import { LoadStats } from "hls.js";
import type {
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderStats,
} from "hls.js";
import { useApi } from "@dashou/api";
import type { Api } from "../src-dashou";

const core = useApi<Api>();

/**
 * hls.js 的自定义 loader：不发出任何真实网络请求，
 * 把伪地址交给 core，由 core 直连上游并返回字节。
 */
export class MediaLoader implements Loader<LoaderContext> {
  context: LoaderContext | null = null;
  stats: LoaderStats = emptyStats();
  private job = 0;
  private aborted = false;

  load(
    context: LoaderContext,
    _config: LoaderConfiguration,
    callbacks: LoaderCallbacks<LoaderContext>,
  ): void {
    const job = ++this.job;
    this.context = context;
    this.aborted = false;
    this.stats = emptyStats();

    core
      .mediaFetch({ url: context.url })
      .then((value) => {
        if (this.aborted || job !== this.job) return;
        const bytes = toBytes(value);
        this.stats.loaded = bytes.byteLength;
        this.stats.total = bytes.byteLength;
        this.stats.chunkCount = 1;
        // 播放列表必须给字符串（hls.js 的 M3U8Parser 直接调 startsWith）；
        // 分片 / key 给 ArrayBuffer。
        const data =
          context.responseType === "text"
            ? new TextDecoder().decode(bytes)
            : (bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              ) as ArrayBuffer);
        callbacks.onSuccess(
          { url: context.url, data, code: 200, text: "" },
          this.stats,
          context,
          null,
        );
      })
      .catch((error: unknown) => {
        if (this.aborted || job !== this.job) return;
        callbacks.onError(
          {
            code: 0,
            text: error instanceof Error ? error.message : "媒体加载失败",
          },
          context,
          null,
          this.stats,
        );
      });
  }

  abort(): void {
    this.aborted = true;
    this.job += 1;
  }

  destroy(): void {
    this.abort();
    this.context = null;
  }
}

function emptyStats(): LoaderStats {
  return new LoadStats();
}

/** IPC 正常传 Uint8Array；兼容被序列化成数组 / Node Buffer 形状的情况 */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (value && typeof value === "object") {
    const record = value as { data?: unknown; buffer?: unknown };
    if (Array.isArray(record.data)) return Uint8Array.from(record.data as number[]);
    if (typeof record.buffer === "string") return base64ToBytes(record.buffer);
  }
  throw new Error("媒体数据格式不正确");
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
