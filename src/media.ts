import { useEffect, useState } from "react";
import { useApi } from "@dashou/api";
import { writeText } from "@dashou/api/clipboardManager";
import type { Api } from "../src-dashou";

/** hls.js 只用来解析；真正取字节由 core 完成，伪地址不会产生网络请求 */
export const MEDIA_ORIGIN = "https://dashou-media.local";

const core = useApi<Api>();

const COVER_CACHE_MAX = 400;
const coverCache = new Map<string, string>();
const coverPending = new Map<string, Promise<string>>();

/** 封面由 core 下载并 AES 解密，返回 data URL（CSP 的 img-src 允许 data:） */
export async function loadCover(url?: string): Promise<string> {
  const key = (url ?? "").trim();
  if (key === "") return "";

  const cached = coverCache.get(key);
  if (cached !== undefined) return cached;

  const running = coverPending.get(key);
  if (running !== undefined) return running;

  const job = core
    .cover({ url: key })
    .then((value) => {
      const src = typeof value === "string" ? value : "";
      if (src !== "") {
        if (coverCache.size >= COVER_CACHE_MAX) {
          const oldest = coverCache.keys().next().value;
          if (oldest !== undefined) coverCache.delete(oldest);
        }
        coverCache.set(key, src);
      }
      return src;
    })
    .finally(() => {
      coverPending.delete(key);
    });

  coverPending.set(key, job);
  return job;
}

export function useCover(url?: string): string {
  const key = (url ?? "").trim();
  const [src, setSrc] = useState(() => (key ? coverCache.get(key) ?? "" : ""));

  useEffect(() => {
    if (key === "") {
      setSrc("");
      return;
    }
    const cached = coverCache.get(key);
    if (cached !== undefined) {
      setSrc(cached);
      return;
    }
    let alive = true;
    setSrc("");
    loadCover(key)
      .then((value) => {
        if (alive) setSrc(value);
      })
      .catch(() => {
        if (alive) setSrc("");
      });
    return () => {
      alive = false;
    };
  }, [key]);

  return src;
}

/** 把上游 m3u8 地址包成 hls.js 能解析的伪地址 */
export function mediaUrl(url: string): string {
  return `${MEDIA_ORIGIN}/m?u=${encodeBase64Url(url)}`;
}

function encodeBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 复制文本走宿主剪贴板；失败再退回浏览器实现 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await writeText(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }
}
