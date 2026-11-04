import { useApi } from "@dashou/api";
import type { Api } from "../src-dashou";
import type {
  CommentPage, Detail, Paged, PlayInfo, Post, RankItem, User, VideoCard,
} from "./types";

/* ── 运行环境 ───────────────────────────────────────────── */

/** 搭手插件是桌面窗口；保留这个导出只为现有组件里的平台分支 */
export const platform: "android" | "windows" = "windows";
export const isAndroid = false;

const core = useApi<Api>();

async function call<T>(job: Promise<unknown>): Promise<T> {
  return (await job) as T;
}

/* ── 接口 ───────────────────────────────────────────────── */

export const api = {
  boot: () => call<{ user: User | null; logged_in: boolean }>(core.boot()),
  login: (username: string, password: string) =>
    call<{ user: User }>(core.login({ username, password })),
  register: (username: string, password: string, email = "") =>
    call<{ user: User }>(core.register({ username, password, email })),
  logout: () => call<{ ok: boolean }>(core.logout()),
  me: () => call<User>(core.me()),

  feed: (page = 1, size = 20) => call<Paged<VideoCard>>(core.feed({ page, size })),
  category: (cate: string, page = 1, size = 20) =>
    call<Paged<VideoCard>>(core.category({ cate, page, size })),
  rank: (kind: "hot" | "recommend" | "potential") =>
    call<{ type: string; items: RankItem[] }>(core.rank({ kind })),
  search: (q: string, page = 1, size = 20) =>
    call<{ items: VideoCard[]; pagination: Paged<VideoCard>["pagination"]; keyword: string }>(
      core.search({ q, page, size }),
    ),
  posts: (page = 1, size = 20) => call<Paged<Post>>(core.posts({ page, size })),
  post: (id: number) => call<Post & { content?: string; video_url?: string }>(core.post({ id })),

  video: (id: number) => call<Detail>(core.video({ id })),
  play: (id: number, ep: number) => call<PlayInfo>(core.play({ id, ep })),

  comments: (id: number, ep: number, page = 1, size = 20) =>
    call<CommentPage>(core.comments({ id, ep, page, size })),
  commentSend: (id: number, ep: number, text: string, replyId?: number) =>
    call<unknown>(core.commentSend({ id, ep, text, replyId: replyId ?? null })),

  clearCache: () => call<unknown>(core.clearCache()),
  postLike: (id: number, on: boolean) => call<unknown>(core.postLike({ id, on })),
  postCollect: (id: number, on: boolean) => call<unknown>(core.postCollect({ id, on })),
  postComments: (id: number, page: number, size: number) =>
    call<CommentPage>(core.postComments({ id, page, size })),
  like: (id: number, ep: number, on: boolean) => call<unknown>(core.like({ id, ep, on })),
  collect: (id: number, on: boolean) => call<unknown>(core.collect({ id, on })),
  follow: (uid: number, on: boolean) => call<unknown>(core.follow({ uid, on })),
};

/* ── 媒体 ───────────────────────────────────────────────── */

export { loadCover, useCover, mediaUrl, MEDIA_ORIGIN, copyText } from "./media";

/* ── 格式化 ─────────────────────────────────────────────── */

export const fmt = (n: number | undefined) => {
  const v = Number(n) || 0;
  if (v >= 100_000_000) return `${(v / 100_000_000).toFixed(1).replace(/\.0$/, "")}亿`;
  if (v >= 10_000) return `${(v / 10_000).toFixed(1).replace(/\.0$/, "")}万`;
  return String(v);
};

export const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, "0")}`;
};

export const dur = (s?: number | string) => {
  const n = Number(s) || 0;
  if (n <= 0) return "";
  const m = Math.floor(n / 60);
  const ss = n % 60;
  return `${m}:${String(ss).padStart(2, "0")}`;
};
