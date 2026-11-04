/**
 * 媒体层：封面解密 + HLS 代理。
 *
 * 窗口没有 Node，原生 fetch 又被 CSP 限制在 plugin:，所以：
 * - 封面由 core 下载、AES 解密后返回 data URL（CSP 的 img-src 允许 data:）；
 * - m3u8 由 core 下载并把 key / 分片改写成 `dashou-media.local` 伪地址，
 *   窗口用 hls.js 自定义 loader 再调回 core 取字节；
 * - 分片由 core 代理，规避 WebView 的 CORS 与防盗链。
 */
import { createDecipheriv } from 'node:crypto'
import { fetchBytes } from './net'

const IMG_KEY = Buffer.from('f5d965df75336270', 'ascii')
const IMG_IV = Buffer.from('97b60394abc2fbe1', 'ascii')

/** 伪地址只用于 hls.js 解析，不会真的发请求；loader 会把 u 参数解回上游地址 */
export const MEDIA_ORIGIN = 'https://dashou-media.local'

const IMG_CACHE_MAX = 240
const SEGMENT_CACHE_BYTES = 96 * 1024 * 1024

const imageCache = new Map<string, string>()
const segmentCache = new Map<string, Buffer>()
let segmentBytes = 0

/* ───────────────────────── 封面 ───────────────────────── */

export async function loadImage(rawUrl: string): Promise<string> {
  const url = rawUrl.trim()
  if (url === '') throw new Error('封面地址为空')

  const hit = imageCache.get(url)
  if (hit !== undefined) {
    // 命中后刷新 LRU 顺序
    imageCache.delete(url)
    imageCache.set(url, hit)
    return hit
  }

  let body: Buffer
  try {
    const res = await fetchBytes(url)
    if (res.status < 200 || res.status >= 300) throw new Error(String(res.status))
    body = res.body
  } catch {
    throw new Error('封面加载失败')
  }

  const plain = imageKind(body) !== null ? body : decryptImage(body)
  const kind = imageKind(plain) ?? 'image/jpeg'
  const dataUrl = `data:${kind};base64,${plain.toString('base64')}`

  if (imageCache.size >= IMG_CACHE_MAX) {
    const oldest = imageCache.keys().next().value
    if (oldest !== undefined) imageCache.delete(oldest)
  }
  imageCache.set(url, dataUrl)
  return dataUrl
}

function decryptImage(data: Buffer): Buffer {
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new Error('封面解密失败')
  }
  let plain: Buffer
  try {
    const decipher = createDecipheriv('aes-128-cbc', IMG_KEY, IMG_IV)
    decipher.setAutoPadding(false)
    plain = Buffer.concat([decipher.update(data), decipher.final()])
  } catch {
    throw new Error('封面解密失败')
  }
  return stripPadding(plain)
}

function stripPadding(buf: Buffer): Buffer {
  const pad = buf.length > 0 ? buf[buf.length - 1] : 0
  if (pad > 0 && pad <= 16 && buf.length >= pad) {
    let valid = true
    for (let i = buf.length - pad; i < buf.length; i += 1) {
      if (buf[i] !== pad) {
        valid = false
        break
      }
    }
    if (valid) return buf.subarray(0, buf.length - pad)
  }
  return buf
}

function imageKind(buf: Buffer): string | null {
  if (buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif'
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return null
}

/* ───────────────────────── HLS ───────────────────────── */

/** 把上游地址包成 hls.js 能解析的伪地址 */
export function mediaUrl(url: string): string {
  return `${MEDIA_ORIGIN}/m?u=${encodeBase64Url(url)}`
}

/** 取 m3u8 / 分片 / key：播放列表会改写内部 URI，其它原样返回字节 */
export async function loadMedia(rawUrl: string): Promise<Uint8Array> {
  const url = resolveMediaUrl(rawUrl)
  const cached = segmentCache.get(url)
  if (cached !== undefined) {
    segmentCache.delete(url)
    segmentCache.set(url, cached)
    return new Uint8Array(cached.buffer, cached.byteOffset, cached.byteLength)
  }

  const res = await fetchBytes(url)
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`媒体加载失败（${res.status}）`)
  }

  const head = res.body.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '')
  const isPlaylist =
    head.startsWith('#EXTM3U') ||
    /mpegurl/i.test(String(res.headers['content-type'] ?? ''))

  if (isPlaylist) {
    const text = rewritePlaylist(res.body.toString('utf8'), url)
    return new TextEncoder().encode(text)
  }

  putSegment(url, res.body)
  return new Uint8Array(res.body.buffer, res.body.byteOffset, res.body.byteLength)
}

function putSegment(url: string, body: Buffer): void {
  const size = body.byteLength
  if (size > SEGMENT_CACHE_BYTES / 4) return
  segmentCache.set(url, body)
  segmentBytes += size
  while (segmentBytes > SEGMENT_CACHE_BYTES) {
    const oldest = segmentCache.keys().next().value
    if (oldest === undefined) break
    const evicted = segmentCache.get(oldest)
    segmentCache.delete(oldest)
    segmentBytes -= evicted?.byteLength ?? 0
  }
}

/** 伪地址 → 上游地址；非伪地址原样返回（兼容直接调用） */
function resolveMediaUrl(raw: string): string {
  if (!raw.startsWith(MEDIA_ORIGIN)) return raw
  try {
    const u = new URL(raw).searchParams.get('u')
    return u ? decodeBase64Url(u) : raw
  } catch {
    return raw
  }
}

function rewritePlaylist(text: string, base: string): string {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line === '') {
      out.push('')
      continue
    }
    if (line.startsWith('#')) {
      out.push(line.includes('URI="') ? rewriteUriAttr(line, base) : line)
      continue
    }
    out.push(mediaUrl(absolutize(base, line)))
  }
  return out.join('\n')
}

function rewriteUriAttr(line: string, base: string): string {
  return line.replace(/URI="([^"]*)"/, (_match, uri: string) => {
    return `URI="${mediaUrl(absolutize(base, uri))}"`
  })
}

function absolutize(base: string, target: string): string {
  if (target.startsWith('http://') || target.startsWith('https://')) return target
  if (target.startsWith('//')) return `https:${target}`
  try {
    return new URL(target, base).toString()
  } catch {
    return target
  }
}

function encodeBase64Url(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf8')
}

/* ───────────────────────── 清理 ───────────────────────── */

export function clearCaches(): void {
  imageCache.clear()
  segmentCache.clear()
  segmentBytes = 0
}
