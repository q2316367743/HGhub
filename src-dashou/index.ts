import { definePluginApi } from '@dashou/core'
import { ApiError, edge } from './net'
import { bindSession, clearSession, setSession, setUser, token, user } from './session'
import { clearCaches, loadImage, loadMedia } from './media'

function requireToken(): string {
  const value = token()
  if (value === null) throw new Error('请先登录')
  return value
}

async function get(path: string): Promise<unknown> {
  try {
    return await edge('GET', path, null, token())
  } catch (error) {
    if (error instanceof ApiError && error.code === 'AUTH') clearSession()
    throw error
  }
}

async function authed(
  method: 'POST' | 'DELETE',
  path: string,
  body: Record<string, unknown> | null = null
): Promise<unknown> {
  const value = requireToken()
  try {
    return await edge(method, path, body, value)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'AUTH') clearSession()
    throw error
  }
}

function textOf(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') throw new Error(`${field}不能为空`)
  return text
}

const plugin = definePluginApi({
  async onReady(ctx) {
    bindSession(ctx.paths.data)
    ctx.log('HGhub 已启动', 'info')
  },

  onError(error, ctx) {
    ctx.log(`HGhub 运行异常：${error instanceof Error ? error.message : String(error)}`, 'error')
  },

  api: {
    async boot() {
      return { user: user(), logged_in: token() !== null }
    },

    async login(_ctx, args: { username: string; password: string }) {
      const username = textOf(args?.username, '账号')
      const password = textOf(args?.password, '密码')
      const data = (await edge(
        'POST',
        '/api/account/loginByPassword',
        { username, password },
        null
      )) as { token?: unknown; user?: unknown } | null
      const nextToken = typeof data?.token === 'string' ? data.token : ''
      if (nextToken === '') throw new Error('登录返回异常，请稍后重试')
      const nextUser = data?.user ?? null
      setSession(nextToken, nextUser)
      return { user: nextUser }
    },

    async register(_ctx, args: { username: string; password: string; email?: string }) {
      const username = textOf(args?.username, '账号')
      const password = textOf(args?.password, '密码')
      const body: Record<string, unknown> = {
        username,
        password,
        confirm_password: password
      }
      const email = typeof args?.email === 'string' ? args.email.trim() : ''
      if (email !== '') body.email = email

      const data = (await edge(
        'POST',
        '/api/account/registerByPassword',
        body,
        null
      )) as { token?: unknown; user?: unknown } | null
      const nextToken = typeof data?.token === 'string' ? data.token : ''
      if (nextToken === '') throw new Error('注册返回异常，请稍后重试')
      const nextUser = data?.user ?? null
      setSession(nextToken, nextUser)
      return { user: nextUser }
    },

    async logout() {
      const value = token()
      if (value !== null) {
        try {
          await edge('POST', '/api/account/logout', null, value)
        } catch {
          // 上游登出失败也清本地会话
        }
      }
      clearSession()
      return { ok: true }
    },

    async me() {
      const me = await get('/api/account/me')
      if (token() !== null) setUser(me)
      return me
    },

    /* ───────────────────────── 列表 ───────────────────────── */

    feed: (_ctx, args: { page: number; size: number }) =>
      get(`/api/videos?page=${args.page}&size=${args.size}`),

    category: (_ctx, args: { cate: string; page: number; size: number }) =>
      get(`/api/videos/category/${encodeURIComponent(args.cate)}?page=${args.page}&size=${args.size}`),

    rank: (_ctx, args: { kind: string }) => {
      const kind = ['recommend', 'potential'].includes(args.kind) ? args.kind : 'hot'
      return get(`/api/ranks/${kind}`)
    },

    search: (_ctx, args: { q: string; page: number; size: number }) => {
      const params = new URLSearchParams({
        q: args.q,
        page: String(args.page),
        size: String(args.size)
      })
      return get(`/api/search?${params.toString()}`)
    },

    posts: (_ctx, args: { page: number; size: number }) =>
      get(`/api/posts?page=${args.page}&size=${args.size}`),

    post: (_ctx, args: { id: number }) => get(`/api/posts/${args.id}`),

    /* ───────────────────────── 详情 / 播放 ───────────────────────── */

    video: (_ctx, args: { id: number }) => get(`/api/videos/${args.id}`),

    play: (_ctx, args: { id: number; ep: number }) =>
      get(`/api/videos/${args.id}/play?ep=${args.ep}&page_texts=0`),

    /* ───────────────────────── 评论 / 互动 ───────────────────────── */

    comments: (_ctx, args: { id: number; ep: number; page: number; size: number }) =>
      get(`/api/videos/${args.id}/comments?ep=${args.ep}&page=${args.page}&size=${args.size}`),

    commentSend: (
      _ctx,
      args: { id: number; ep: number; text: string; replyId?: number | null }
    ) => {
      const body: Record<string, unknown> = { text: args.text }
      const replyId = typeof args.replyId === 'number' ? args.replyId : 0
      const path =
        replyId > 0
          ? `/api/videos/${args.id}/comments`
          : `/api/videos/${args.id}/comments?ep=${args.ep}`
      if (replyId > 0) body.reply_id = replyId
      return authed('POST', path, body)
    },

    like: (_ctx, args: { id: number; ep: number; on: boolean }) =>
      authed(args.on ? 'POST' : 'DELETE', `/api/videos/${args.id}/like?ep=${args.ep}`),

    collect: (_ctx, args: { id: number; on: boolean }) =>
      authed(args.on ? 'POST' : 'DELETE', `/api/videos/${args.id}/collect`),

    follow: (_ctx, args: { uid: number; on: boolean }) =>
      authed(args.on ? 'POST' : 'DELETE', `/api/users/${args.uid}/follow`),

    postLike: (_ctx, args: { id: number; on: boolean }) =>
      authed(args.on ? 'POST' : 'DELETE', `/api/posts/${args.id}/like`),

    postCollect: (_ctx, args: { id: number; on: boolean }) =>
      authed(args.on ? 'POST' : 'DELETE', `/api/posts/${args.id}/collect`),

    postComments: (_ctx, args: { id: number; page: number; size: number }) =>
      get(`/api/posts/${args.id}/comments?page=${args.page}&size=${args.size}`),

    /* ───────────────────────── 媒体 ───────────────────────── */

    cover: (_ctx, args: { url: string }) => loadImage(args.url),

    mediaFetch: (_ctx, args: { url: string }) => loadMedia(args.url),

    clearCache() {
      clearCaches()
      return { ok: true }
    }
  }
})

export default plugin
export type Api = typeof plugin.api
