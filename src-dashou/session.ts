/**
 * 会话持久化：token + 用户资料存到插件数据目录（session.json）。
 * core 的 Node 不受 ACL 限制，直接用 fs；不需要额外权限。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface SessionData {
  token: string
  user: unknown
}

const EMPTY: SessionData = { token: '', user: null }

let file = ''
let current: SessionData = { ...EMPTY }

/** onReady 时调用：绑定数据目录并读回上次登录态 */
export function bindSession(dataDir: string): void {
  file = join(dataDir, 'session.json')
  try {
    mkdirSync(dataDir, { recursive: true })
    const text = readFileSync(file, 'utf8')
    const parsed = JSON.parse(text) as Partial<SessionData>
    current = {
      token: typeof parsed.token === 'string' ? parsed.token : '',
      user: parsed.user ?? null
    }
  } catch {
    current = { ...EMPTY }
  }
}

export function token(): string | null {
  return current.token === '' ? null : current.token
}

export function user(): unknown {
  return current.user
}

export function setSession(nextToken: string, nextUser: unknown): void {
  current = { token: nextToken, user: nextUser }
  persist()
}

export function setUser(nextUser: unknown): void {
  current = { ...current, user: nextUser }
  persist()
}

export function clearSession(): void {
  current = { ...EMPTY }
  persist()
}

function persist(): void {
  if (file === '') return
  try {
    writeFileSync(file, JSON.stringify(current, null, 2), 'utf8')
  } catch {
    // 登录态写盘失败不阻塞使用，下次启动需重新登录
  }
}
