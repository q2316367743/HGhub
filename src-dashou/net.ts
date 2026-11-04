/**
 * 网络层：与上游站点对话。
 *
 * 站点把全部 `/api/**` 调用收敛成 `POST /api/edge/request` 的信封，
 * 我们只实现这一个入口，其余接口都是「填 path」。core 有 Node，
 * 直连不受窗口 CSP 与 CORS 限制，媒体也走这里。
 *
 * 代理：优先环境变量（HTTPS_PROXY 等），其次系统代理
 * （macOS `scutil --proxy`、Windows 注册表、Linux gsettings），
 * 这样从桌面启动、没有终端环境的场景也能走用户已有的代理。
 */
import { execFileSync } from 'node:child_process'
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import * as tls from 'node:tls'
import * as zlib from 'node:zlib'

export const BASE = 'https://huangguoai.com'

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const TIMEOUT_MS = 20_000
const MAX_REDIRECTS = 5

export interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export class ApiError extends Error {
  readonly code: 'AUTH' | 'NETWORK' | 'HTTP'

  constructor(message: string, code: 'AUTH' | 'NETWORK' | 'HTTP' = 'HTTP') {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/** 拉原始字节（图片 / m3u8 / 分片），网络错误重试 3 次 */
export async function requestBytes(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: Buffer } = {}
): Promise<RawResponse> {
  return withRetry(() => once(url, init))
}

/** 业务请求：走边缘信封，返回 data 字段 */
export async function edge(
  method: string,
  path: string,
  body: Record<string, unknown> | null,
  token: string | null
): Promise<unknown> {
  const payload = {
    method,
    path,
    body: body ? Buffer.from(JSON.stringify(body), 'utf8').toString('base64') : '',
    content_type: body ? 'application/json' : ''
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
  if (token) headers.Authorization = `Bearer ${token}`

  const res = await requestBytes(`${BASE}/api/edge/request`, {
    method: 'POST',
    headers,
    body: Buffer.from(JSON.stringify(payload), 'utf8')
  })

  if (res.status === 401 || res.status === 403) {
    throw new ApiError('登录已过期，请重新登录', 'AUTH')
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError(`服务暂时不可用（${res.status}）`, 'HTTP')
  }

  const text = res.body.toString('utf8').trim()
  if (text === '') return null

  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new ApiError('服务返回的数据无法解析', 'HTTP')
  }

  const envelope = value as { status?: number; data?: unknown; msg?: string }
  if (envelope.status === 1) return envelope.data ?? null
  const msg = typeof envelope.msg === 'string' && envelope.msg.trim() !== '' ? envelope.msg : '请求失败，请稍后重试'
  throw new ApiError(msg, 'HTTP')
}

/** 带 Referer 的媒体下载（站点按 Referer 放行，分片本身不强制） */
export async function fetchBytes(url: string): Promise<RawResponse> {
  return requestBytes(url, {
    headers: {
      Accept: '*/*',
      Referer: `${BASE}/`
    }
  })
}

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  let last: unknown = new Error('网络连接失败，请检查网络')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      last = error
      if (attempt < 2) await sleep(350 * (attempt + 1))
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

async function once(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: Buffer }
): Promise<RawResponse> {
  let target = url
  for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
    let parsed: URL
    try {
      parsed = new URL(target)
    } catch {
      throw new ApiError('无效的地址', 'NETWORK')
    }
    const proxy = parsed.protocol === 'https:' ? proxyFor(parsed) : null
    const tunnel = proxy === null ? null : await connectThroughProxy(parsed, proxy)
    const response = await requestOnce(parsed, init, tunnel)
    const location = response.headers.location
    if (response.status >= 300 && response.status < 400 && location) {
      target = new URL(location, target).toString()
      continue
    }
    return response
  }
  throw new ApiError('页面跳转次数过多', 'NETWORK')
}

function requestOnce(
  parsed: URL,
  init: { method?: string; headers?: Record<string, string>; body?: Buffer },
  tunnel: tls.TLSSocket | null
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === 'http:' ? http : https
    const req = transport.request(
      parsed,
      {
        method: init.method ?? 'GET',
        timeout: TIMEOUT_MS,
        ...(tunnel === null
          ? {}
          : { createConnection: () => tunnel, servername: parsed.hostname }),
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Encoding': 'gzip, deflate, br',
          Referer: `${BASE}/`,
          ...init.headers
        }
      },
      (res) => {
        const status = res.statusCode ?? 0
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const body = decode(Buffer.concat(chunks), res.headers['content-encoding'])
          resolve({ status, headers: res.headers, body })
        })
        res.on('error', (error) => reject(toNetworkError(error)))
      }
    )
    req.on('timeout', () => req.destroy(new Error('请求超时')))
    req.on('error', (error) => reject(toNetworkError(error)))
    if (init.body) req.write(init.body)
    req.end()
  })
}

/* ───────────────────────── 代理 ───────────────────────── */

/** HTTP CONNECT 隧道；只支持 http:// 代理（Clash / 系统代理的常见形态） */
function connectThroughProxy(target: URL, proxyUrl: string): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    let proxy: URL
    try {
      proxy = new URL(proxyUrl)
    } catch {
      reject(new ApiError('代理地址无效', 'NETWORK'))
      return
    }
    if (proxy.protocol !== 'http:') {
      reject(new ApiError('暂不支持这种代理类型', 'NETWORK'))
      return
    }

    const port = target.port === '' ? '443' : target.port
    const socket = net.connect({
      host: proxy.hostname,
      port: Number(proxy.port === '' ? '80' : proxy.port)
    })

    const fail = (error: Error): void => {
      socket.destroy()
      reject(error)
    }

    socket.setTimeout(15_000, () => fail(new ApiError('代理连接超时', 'NETWORK')))
    socket.once('error', fail)
    socket.once('connect', () => {
      const auth =
        proxy.username === ''
          ? ''
          : `Proxy-Authorization: Basic ${Buffer.from(
              `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
            ).toString('base64')}\r\n`
      socket.write(
        `CONNECT ${target.hostname}:${port} HTTP/1.1\r\nHost: ${target.hostname}:${port}\r\n${auth}\r\n`
      )
    })

    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffer.length > 64 * 1024) fail(new ApiError('代理响应异常', 'NETWORK'))
        return
      }
      socket.off('data', onData)
      socket.off('error', fail)
      socket.setTimeout(0)

      const head = buffer.subarray(0, end).toString('latin1')
      const rest = buffer.subarray(end + 4)
      const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1] ?? 0)
      if (status < 200 || status >= 300) {
        fail(new ApiError(`代理连接失败（${status === 0 ? '未知' : status}）`, 'NETWORK'))
        return
      }
      if (rest.length > 0) socket.unshift(rest)

      const secure = tls.connect({ socket, servername: target.hostname })
      secure.once('error', fail)
      secure.once('secureConnect', () => {
        secure.off('error', fail)
        resolve(secure)
      })
    }
    socket.on('data', onData)
  })
}

function proxyFor(target: URL): string | null {
  if (bypassProxy(target)) return null
  const envHttps = env('HTTPS_PROXY') || env('https_proxy') || env('ALL_PROXY') || env('all_proxy')
  const envHttp = env('HTTP_PROXY') || env('http_proxy') || env('ALL_PROXY') || env('all_proxy')
  if (target.protocol === 'https:') {
    return envHttps || envHttp || systemProxy('https') || systemProxy('http')
  }
  return envHttp || systemProxy('http')
}

function bypassProxy(target: URL): boolean {
  const list = env('NO_PROXY') || env('no_proxy')
  if (list === '') return false
  const host = target.hostname.toLowerCase()
  for (const item of list.split(',')) {
    const rule = item.trim().toLowerCase()
    if (rule === '') continue
    if (rule === '*') return true
    const domain = rule.replace(/^\./, '').replace(/:\d+$/, '')
    if (host === domain || host.endsWith(`.${domain}`)) return true
  }
  return false
}

interface SystemProxy {
  http: string | null
  https: string | null
}

let systemProxyCache: { at: number; value: SystemProxy } | null = null

function systemProxy(kind: keyof SystemProxy): string | null {
  const now = Date.now()
  if (systemProxyCache === null || now - systemProxyCache.at > 60_000) {
    systemProxyCache = { at: now, value: detectSystemProxy() }
  }
  return systemProxyCache.value[kind]
}

function detectSystemProxy(): SystemProxy {
  try {
    if (process.platform === 'darwin') return detectMacProxy()
    if (process.platform === 'win32') return detectWindowsProxy()
    return detectLinuxProxy()
  } catch {
    return { http: null, https: null }
  }
}

function detectMacProxy(): SystemProxy {
  const text = execFileSync('scutil', ['--proxy'], { encoding: 'utf8', timeout: 1500 })
  const value = (key: string): string => {
    const match = new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, 'm').exec(text)
    return match?.[1] ?? ''
  }
  const build = (enabledKey: string, hostKey: string, portKey: string): string | null => {
    if (value(enabledKey) !== '1') return null
    const host = value(hostKey)
    const port = value(portKey)
    return host !== '' && port !== '' ? `http://${host}:${port}` : null
  }
  const http = build('HTTPEnable', 'HTTPProxy', 'HTTPPort')
  const https = build('HTTPSEnable', 'HTTPSProxy', 'HTTPSPort') ?? http
  return { http, https }
}

function detectWindowsProxy(): SystemProxy {
  const output = execFileSync(
    'reg',
    ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
    { encoding: 'utf8', timeout: 1500 }
  )
  if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(output)) return { http: null, https: null }
  const raw = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(output)?.[1]?.trim() ?? ''
  if (raw === '') return { http: null, https: null }
  if (!raw.includes('=')) {
    const value = `http://${raw}`
    return { http: value, https: value }
  }
  const map = new Map<string, string>()
  for (const part of raw.split(';')) {
    const [key, value] = part.split('=')
    if (key && value) map.set(key.trim().toLowerCase(), value.trim())
  }
  const http = map.get('http') ?? ''
  const https = map.get('https') ?? http
  return {
    http: http === '' ? null : `http://${http}`,
    https: https === '' ? null : `http://${https}`
  }
}

function detectLinuxProxy(): SystemProxy {
  const mode = execFileSync('gsettings', ['get', 'org.gnome.system.proxy', 'mode'], {
    encoding: 'utf8',
    timeout: 1500
  }).trim()
  if (mode !== "'manual'") return { http: null, https: null }
  const build = (schema: string): string | null => {
    const host = gsettings(`${schema}.host`)
    const port = gsettings(`${schema}.port`)
    return host !== '' && port !== '' ? `http://${host}:${port}` : null
  }
  return { http: build('org.gnome.system.proxy.http'), https: build('org.gnome.system.proxy.https') }
}

function gsettings(key: string): string {
  try {
    return execFileSync('gsettings', ['get', key], { encoding: 'utf8', timeout: 1500 })
      .trim()
      .replace(/^['"]|['"]$/g, '')
  } catch {
    return ''
  }
}

function env(name: string): string {
  return (process.env[name] ?? '').trim()
}

/* ───────────────────────── 工具 ───────────────────────── */

function decode(body: Buffer, encoding: http.IncomingHttpHeaders['content-encoding']): Buffer {
  const value = String(encoding ?? '').toLowerCase()
  if (body.length === 0) return body
  try {
    if (value.includes('br')) return zlib.brotliDecompressSync(body)
    if (value.includes('gzip')) return zlib.gunzipSync(body)
    if (value.includes('deflate')) return zlib.inflateSync(body)
  } catch {
    // 压缩头与实际内容不一致时按原始字节处理
  }
  return body
}

function toNetworkError(error: unknown): Error {
  const raw = error instanceof Error ? error : new Error(String(error))
  if (
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|TLS|certificate|网络/i.test(
      raw.message
    )
  ) {
    return new ApiError('网络连接失败，请检查网络', 'NETWORK')
  }
  return raw
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
