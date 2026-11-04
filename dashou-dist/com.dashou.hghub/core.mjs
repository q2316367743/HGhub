// ../../app/da-shou-plugin-ext/packages/core/dist/define.js
function definePluginApi(descriptor) {
  return descriptor;
}

// src-dashou/net.ts
import { execFileSync } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import * as tls from "node:tls";
import * as zlib from "node:zlib";
var BASE = "https://huangguoai.com";
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
var TIMEOUT_MS = 2e4;
var MAX_REDIRECTS = 5;
var ApiError = class extends Error {
  code;
  constructor(message, code = "HTTP") {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
};
async function requestBytes(url, init = {}) {
  return withRetry(() => once(url, init));
}
async function edge(method, path, body, token2) {
  const payload = {
    method,
    path,
    body: body ? Buffer.from(JSON.stringify(body), "utf8").toString("base64") : "",
    content_type: body ? "application/json" : ""
  };
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json"
  };
  if (token2) headers.Authorization = `Bearer ${token2}`;
  const res = await requestBytes(`${BASE}/api/edge/request`, {
    method: "POST",
    headers,
    body: Buffer.from(JSON.stringify(payload), "utf8")
  });
  if (res.status === 401 || res.status === 403) {
    throw new ApiError("\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55", "AUTH");
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError(`\u670D\u52A1\u6682\u65F6\u4E0D\u53EF\u7528\uFF08${res.status}\uFF09`, "HTTP");
  }
  const text = res.body.toString("utf8").trim();
  if (text === "") return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError("\u670D\u52A1\u8FD4\u56DE\u7684\u6570\u636E\u65E0\u6CD5\u89E3\u6790", "HTTP");
  }
  const envelope = value;
  if (envelope.status === 1) return envelope.data ?? null;
  const msg = typeof envelope.msg === "string" && envelope.msg.trim() !== "" ? envelope.msg : "\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5";
  throw new ApiError(msg, "HTTP");
}
async function fetchBytes(url) {
  return requestBytes(url, {
    headers: {
      Accept: "*/*",
      Referer: `${BASE}/`
    }
  });
}
async function withRetry(run) {
  let last = new Error("\u7F51\u7EDC\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      last = error;
      if (attempt < 2) await sleep(350 * (attempt + 1));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
async function once(url, init) {
  let target = url;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops += 1) {
    let parsed;
    try {
      parsed = new URL(target);
    } catch {
      throw new ApiError("\u65E0\u6548\u7684\u5730\u5740", "NETWORK");
    }
    const proxy = parsed.protocol === "https:" ? proxyFor(parsed) : null;
    const tunnel = proxy === null ? null : await connectThroughProxy(parsed, proxy);
    const response = await requestOnce(parsed, init, tunnel);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      target = new URL(location, target).toString();
      continue;
    }
    return response;
  }
  throw new ApiError("\u9875\u9762\u8DF3\u8F6C\u6B21\u6570\u8FC7\u591A", "NETWORK");
}
function requestOnce(parsed, init, tunnel) {
  return new Promise((resolve, reject) => {
    const transport = parsed.protocol === "http:" ? http : https;
    const req = transport.request(
      parsed,
      {
        method: init.method ?? "GET",
        timeout: TIMEOUT_MS,
        ...tunnel === null ? {} : { createConnection: () => tunnel, servername: parsed.hostname },
        headers: {
          "User-Agent": UA,
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate, br",
          Referer: `${BASE}/`,
          ...init.headers
        }
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const body = decode(Buffer.concat(chunks), res.headers["content-encoding"]);
          resolve({ status, headers: res.headers, body });
        });
        res.on("error", (error) => reject(toNetworkError(error)));
      }
    );
    req.on("timeout", () => req.destroy(new Error("\u8BF7\u6C42\u8D85\u65F6")));
    req.on("error", (error) => reject(toNetworkError(error)));
    if (init.body) req.write(init.body);
    req.end();
  });
}
function connectThroughProxy(target, proxyUrl) {
  return new Promise((resolve, reject) => {
    let proxy;
    try {
      proxy = new URL(proxyUrl);
    } catch {
      reject(new ApiError("\u4EE3\u7406\u5730\u5740\u65E0\u6548", "NETWORK"));
      return;
    }
    if (proxy.protocol !== "http:") {
      reject(new ApiError("\u6682\u4E0D\u652F\u6301\u8FD9\u79CD\u4EE3\u7406\u7C7B\u578B", "NETWORK"));
      return;
    }
    const port = target.port === "" ? "443" : target.port;
    const socket = net.connect({
      host: proxy.hostname,
      port: Number(proxy.port === "" ? "80" : proxy.port)
    });
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(15e3, () => fail(new ApiError("\u4EE3\u7406\u8FDE\u63A5\u8D85\u65F6", "NETWORK")));
    socket.once("error", fail);
    socket.once("connect", () => {
      const auth = proxy.username === "" ? "" : `Proxy-Authorization: Basic ${Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
      ).toString("base64")}\r
`;
      socket.write(
        `CONNECT ${target.hostname}:${port} HTTP/1.1\r
Host: ${target.hostname}:${port}\r
${auth}\r
`
      );
    });
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffer.length > 64 * 1024) fail(new ApiError("\u4EE3\u7406\u54CD\u5E94\u5F02\u5E38", "NETWORK"));
        return;
      }
      socket.off("data", onData);
      socket.off("error", fail);
      socket.setTimeout(0);
      const head = buffer.subarray(0, end).toString("latin1");
      const rest = buffer.subarray(end + 4);
      const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)?.[1] ?? 0);
      if (status < 200 || status >= 300) {
        fail(new ApiError(`\u4EE3\u7406\u8FDE\u63A5\u5931\u8D25\uFF08${status === 0 ? "\u672A\u77E5" : status}\uFF09`, "NETWORK"));
        return;
      }
      if (rest.length > 0) socket.unshift(rest);
      const secure = tls.connect({ socket, servername: target.hostname });
      secure.once("error", fail);
      secure.once("secureConnect", () => {
        secure.off("error", fail);
        resolve(secure);
      });
    };
    socket.on("data", onData);
  });
}
function proxyFor(target) {
  if (bypassProxy(target)) return null;
  const envHttps = env("HTTPS_PROXY") || env("https_proxy") || env("ALL_PROXY") || env("all_proxy");
  const envHttp = env("HTTP_PROXY") || env("http_proxy") || env("ALL_PROXY") || env("all_proxy");
  if (target.protocol === "https:") {
    return envHttps || envHttp || systemProxy("https") || systemProxy("http");
  }
  return envHttp || systemProxy("http");
}
function bypassProxy(target) {
  const list = env("NO_PROXY") || env("no_proxy");
  if (list === "") return false;
  const host = target.hostname.toLowerCase();
  for (const item of list.split(",")) {
    const rule = item.trim().toLowerCase();
    if (rule === "") continue;
    if (rule === "*") return true;
    const domain = rule.replace(/^\./, "").replace(/:\d+$/, "");
    if (host === domain || host.endsWith(`.${domain}`)) return true;
  }
  return false;
}
var systemProxyCache = null;
function systemProxy(kind) {
  const now = Date.now();
  if (systemProxyCache === null || now - systemProxyCache.at > 6e4) {
    systemProxyCache = { at: now, value: detectSystemProxy() };
  }
  return systemProxyCache.value[kind];
}
function detectSystemProxy() {
  try {
    if (process.platform === "darwin") return detectMacProxy();
    if (process.platform === "win32") return detectWindowsProxy();
    return detectLinuxProxy();
  } catch {
    return { http: null, https: null };
  }
}
function detectMacProxy() {
  const text = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 1500 });
  const value = (key) => {
    const match = new RegExp(`^\\s*${key}\\s*:\\s*(\\S+)`, "m").exec(text);
    return match?.[1] ?? "";
  };
  const build = (enabledKey, hostKey, portKey) => {
    if (value(enabledKey) !== "1") return null;
    const host = value(hostKey);
    const port = value(portKey);
    return host !== "" && port !== "" ? `http://${host}:${port}` : null;
  };
  const http2 = build("HTTPEnable", "HTTPProxy", "HTTPPort");
  const https2 = build("HTTPSEnable", "HTTPSProxy", "HTTPSPort") ?? http2;
  return { http: http2, https: https2 };
}
function detectWindowsProxy() {
  const output = execFileSync(
    "reg",
    ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings"],
    { encoding: "utf8", timeout: 1500 }
  );
  if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(output)) return { http: null, https: null };
  const raw = /ProxyServer\s+REG_SZ\s+(.+)/i.exec(output)?.[1]?.trim() ?? "";
  if (raw === "") return { http: null, https: null };
  if (!raw.includes("=")) {
    const value = `http://${raw}`;
    return { http: value, https: value };
  }
  const map = /* @__PURE__ */ new Map();
  for (const part of raw.split(";")) {
    const [key, value] = part.split("=");
    if (key && value) map.set(key.trim().toLowerCase(), value.trim());
  }
  const http2 = map.get("http") ?? "";
  const https2 = map.get("https") ?? http2;
  return {
    http: http2 === "" ? null : `http://${http2}`,
    https: https2 === "" ? null : `http://${https2}`
  };
}
function detectLinuxProxy() {
  const mode = execFileSync("gsettings", ["get", "org.gnome.system.proxy", "mode"], {
    encoding: "utf8",
    timeout: 1500
  }).trim();
  if (mode !== "'manual'") return { http: null, https: null };
  const build = (schema) => {
    const host = gsettings(`${schema}.host`);
    const port = gsettings(`${schema}.port`);
    return host !== "" && port !== "" ? `http://${host}:${port}` : null;
  };
  return { http: build("org.gnome.system.proxy.http"), https: build("org.gnome.system.proxy.https") };
}
function gsettings(key) {
  try {
    return execFileSync("gsettings", ["get", key], { encoding: "utf8", timeout: 1500 }).trim().replace(/^['"]|['"]$/g, "");
  } catch {
    return "";
  }
}
function env(name) {
  return (process.env[name] ?? "").trim();
}
function decode(body, encoding) {
  const value = String(encoding ?? "").toLowerCase();
  if (body.length === 0) return body;
  try {
    if (value.includes("br")) return zlib.brotliDecompressSync(body);
    if (value.includes("gzip")) return zlib.gunzipSync(body);
    if (value.includes("deflate")) return zlib.inflateSync(body);
  } catch {
  }
  return body;
}
function toNetworkError(error) {
  const raw = error instanceof Error ? error : new Error(String(error));
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|TLS|certificate|网络/i.test(
    raw.message
  )) {
    return new ApiError("\u7F51\u7EDC\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC", "NETWORK");
  }
  return raw;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// src-dashou/session.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var EMPTY = { token: "", user: null };
var file = "";
var current = { ...EMPTY };
function bindSession(dataDir) {
  file = join(dataDir, "session.json");
  try {
    mkdirSync(dataDir, { recursive: true });
    const text = readFileSync(file, "utf8");
    const parsed = JSON.parse(text);
    current = {
      token: typeof parsed.token === "string" ? parsed.token : "",
      user: parsed.user ?? null
    };
  } catch {
    current = { ...EMPTY };
  }
}
function token() {
  return current.token === "" ? null : current.token;
}
function user() {
  return current.user;
}
function setSession(nextToken, nextUser) {
  current = { token: nextToken, user: nextUser };
  persist();
}
function setUser(nextUser) {
  current = { ...current, user: nextUser };
  persist();
}
function clearSession() {
  current = { ...EMPTY };
  persist();
}
function persist() {
  if (file === "") return;
  try {
    writeFileSync(file, JSON.stringify(current, null, 2), "utf8");
  } catch {
  }
}

// src-dashou/media.ts
import { createDecipheriv } from "node:crypto";
var IMG_KEY = Buffer.from("f5d965df75336270", "ascii");
var IMG_IV = Buffer.from("97b60394abc2fbe1", "ascii");
var MEDIA_ORIGIN = "https://dashou-media.local";
var IMG_CACHE_MAX = 240;
var SEGMENT_CACHE_BYTES = 96 * 1024 * 1024;
var imageCache = /* @__PURE__ */ new Map();
var segmentCache = /* @__PURE__ */ new Map();
var segmentBytes = 0;
async function loadImage(rawUrl) {
  const url = rawUrl.trim();
  if (url === "") throw new Error("\u5C01\u9762\u5730\u5740\u4E3A\u7A7A");
  const hit = imageCache.get(url);
  if (hit !== void 0) {
    imageCache.delete(url);
    imageCache.set(url, hit);
    return hit;
  }
  let body;
  try {
    const res = await fetchBytes(url);
    if (res.status < 200 || res.status >= 300) throw new Error(String(res.status));
    body = res.body;
  } catch {
    throw new Error("\u5C01\u9762\u52A0\u8F7D\u5931\u8D25");
  }
  const plain = imageKind(body) !== null ? body : decryptImage(body);
  const kind = imageKind(plain) ?? "image/jpeg";
  const dataUrl = `data:${kind};base64,${plain.toString("base64")}`;
  if (imageCache.size >= IMG_CACHE_MAX) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== void 0) imageCache.delete(oldest);
  }
  imageCache.set(url, dataUrl);
  return dataUrl;
}
function decryptImage(data) {
  if (data.length === 0 || data.length % 16 !== 0) {
    throw new Error("\u5C01\u9762\u89E3\u5BC6\u5931\u8D25");
  }
  let plain;
  try {
    const decipher = createDecipheriv("aes-128-cbc", IMG_KEY, IMG_IV);
    decipher.setAutoPadding(false);
    plain = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new Error("\u5C01\u9762\u89E3\u5BC6\u5931\u8D25");
  }
  return stripPadding(plain);
}
function stripPadding(buf) {
  const pad = buf.length > 0 ? buf[buf.length - 1] : 0;
  if (pad > 0 && pad <= 16 && buf.length >= pad) {
    let valid = true;
    for (let i = buf.length - pad; i < buf.length; i += 1) {
      if (buf[i] !== pad) {
        valid = false;
        break;
      }
    }
    if (valid) return buf.subarray(0, buf.length - pad);
  }
  return buf;
}
function imageKind(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 255 && buf[1] === 216) return "image/jpeg";
  if (buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71) return "image/png";
  if (buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  return null;
}
function mediaUrl(url) {
  return `${MEDIA_ORIGIN}/m?u=${encodeBase64Url(url)}`;
}
async function loadMedia(rawUrl) {
  const url = resolveMediaUrl(rawUrl);
  const cached = segmentCache.get(url);
  if (cached !== void 0) {
    segmentCache.delete(url);
    segmentCache.set(url, cached);
    return new Uint8Array(cached.buffer, cached.byteOffset, cached.byteLength);
  }
  const res = await fetchBytes(url);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`\u5A92\u4F53\u52A0\u8F7D\u5931\u8D25\uFF08${res.status}\uFF09`);
  }
  const head = res.body.subarray(0, 1024).toString("utf8").replace(/^\uFEFF/, "");
  const isPlaylist = head.startsWith("#EXTM3U") || /mpegurl/i.test(String(res.headers["content-type"] ?? ""));
  if (isPlaylist) {
    const text = rewritePlaylist(res.body.toString("utf8"), url);
    return new TextEncoder().encode(text);
  }
  putSegment(url, res.body);
  return new Uint8Array(res.body.buffer, res.body.byteOffset, res.body.byteLength);
}
function putSegment(url, body) {
  const size = body.byteLength;
  if (size > SEGMENT_CACHE_BYTES / 4) return;
  segmentCache.set(url, body);
  segmentBytes += size;
  while (segmentBytes > SEGMENT_CACHE_BYTES) {
    const oldest = segmentCache.keys().next().value;
    if (oldest === void 0) break;
    const evicted = segmentCache.get(oldest);
    segmentCache.delete(oldest);
    segmentBytes -= evicted?.byteLength ?? 0;
  }
}
function resolveMediaUrl(raw) {
  if (!raw.startsWith(MEDIA_ORIGIN)) return raw;
  try {
    const u = new URL(raw).searchParams.get("u");
    return u ? decodeBase64Url(u) : raw;
  } catch {
    return raw;
  }
}
function rewritePlaylist(text, base) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "") {
      out.push("");
      continue;
    }
    if (line.startsWith("#")) {
      out.push(line.includes('URI="') ? rewriteUriAttr(line, base) : line);
      continue;
    }
    out.push(mediaUrl(absolutize(base, line)));
  }
  return out.join("\n");
}
function rewriteUriAttr(line, base) {
  return line.replace(/URI="([^"]*)"/, (_match, uri) => {
    return `URI="${mediaUrl(absolutize(base, uri))}"`;
  });
}
function absolutize(base, target) {
  if (target.startsWith("http://") || target.startsWith("https://")) return target;
  if (target.startsWith("//")) return `https:${target}`;
  try {
    return new URL(target, base).toString();
  } catch {
    return target;
  }
}
function encodeBase64Url(text) {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf8");
}
function clearCaches() {
  imageCache.clear();
  segmentCache.clear();
  segmentBytes = 0;
}

// src-dashou/index.ts
function requireToken() {
  const value = token();
  if (value === null) throw new Error("\u8BF7\u5148\u767B\u5F55");
  return value;
}
async function get(path) {
  try {
    return await edge("GET", path, null, token());
  } catch (error) {
    if (error instanceof ApiError && error.code === "AUTH") clearSession();
    throw error;
  }
}
async function authed(method, path, body = null) {
  const value = requireToken();
  try {
    return await edge(method, path, body, value);
  } catch (error) {
    if (error instanceof ApiError && error.code === "AUTH") clearSession();
    throw error;
  }
}
function textOf(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new Error(`${field}\u4E0D\u80FD\u4E3A\u7A7A`);
  return text;
}
var plugin = definePluginApi({
  async onReady(ctx) {
    bindSession(ctx.paths.data);
    ctx.log("HGhub \u5DF2\u542F\u52A8", "info");
  },
  onError(error, ctx) {
    ctx.log(`HGhub \u8FD0\u884C\u5F02\u5E38\uFF1A${error instanceof Error ? error.message : String(error)}`, "error");
  },
  api: {
    async boot() {
      return { user: user(), logged_in: token() !== null };
    },
    async login(_ctx, args) {
      const username = textOf(args?.username, "\u8D26\u53F7");
      const password = textOf(args?.password, "\u5BC6\u7801");
      const data = await edge(
        "POST",
        "/api/account/loginByPassword",
        { username, password },
        null
      );
      const nextToken = typeof data?.token === "string" ? data.token : "";
      if (nextToken === "") throw new Error("\u767B\u5F55\u8FD4\u56DE\u5F02\u5E38\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      const nextUser = data?.user ?? null;
      setSession(nextToken, nextUser);
      return { user: nextUser };
    },
    async register(_ctx, args) {
      const username = textOf(args?.username, "\u8D26\u53F7");
      const password = textOf(args?.password, "\u5BC6\u7801");
      const body = {
        username,
        password,
        confirm_password: password
      };
      const email = typeof args?.email === "string" ? args.email.trim() : "";
      if (email !== "") body.email = email;
      const data = await edge(
        "POST",
        "/api/account/registerByPassword",
        body,
        null
      );
      const nextToken = typeof data?.token === "string" ? data.token : "";
      if (nextToken === "") throw new Error("\u6CE8\u518C\u8FD4\u56DE\u5F02\u5E38\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      const nextUser = data?.user ?? null;
      setSession(nextToken, nextUser);
      return { user: nextUser };
    },
    async logout() {
      const value = token();
      if (value !== null) {
        try {
          await edge("POST", "/api/account/logout", null, value);
        } catch {
        }
      }
      clearSession();
      return { ok: true };
    },
    async me() {
      const me = await get("/api/account/me");
      if (token() !== null) setUser(me);
      return me;
    },
    /* ───────────────────────── 列表 ───────────────────────── */
    feed: (_ctx, args) => get(`/api/videos?page=${args.page}&size=${args.size}`),
    category: (_ctx, args) => get(`/api/videos/category/${encodeURIComponent(args.cate)}?page=${args.page}&size=${args.size}`),
    rank: (_ctx, args) => {
      const kind = ["recommend", "potential"].includes(args.kind) ? args.kind : "hot";
      return get(`/api/ranks/${kind}`);
    },
    search: (_ctx, args) => {
      const params = new URLSearchParams({
        q: args.q,
        page: String(args.page),
        size: String(args.size)
      });
      return get(`/api/search?${params.toString()}`);
    },
    posts: (_ctx, args) => get(`/api/posts?page=${args.page}&size=${args.size}`),
    post: (_ctx, args) => get(`/api/posts/${args.id}`),
    /* ───────────────────────── 详情 / 播放 ───────────────────────── */
    video: (_ctx, args) => get(`/api/videos/${args.id}`),
    play: (_ctx, args) => get(`/api/videos/${args.id}/play?ep=${args.ep}&page_texts=0`),
    /* ───────────────────────── 评论 / 互动 ───────────────────────── */
    comments: (_ctx, args) => get(`/api/videos/${args.id}/comments?ep=${args.ep}&page=${args.page}&size=${args.size}`),
    commentSend: (_ctx, args) => {
      const body = { text: args.text };
      const replyId = typeof args.replyId === "number" ? args.replyId : 0;
      const path = replyId > 0 ? `/api/videos/${args.id}/comments` : `/api/videos/${args.id}/comments?ep=${args.ep}`;
      if (replyId > 0) body.reply_id = replyId;
      return authed("POST", path, body);
    },
    like: (_ctx, args) => authed(args.on ? "POST" : "DELETE", `/api/videos/${args.id}/like?ep=${args.ep}`),
    collect: (_ctx, args) => authed(args.on ? "POST" : "DELETE", `/api/videos/${args.id}/collect`),
    follow: (_ctx, args) => authed(args.on ? "POST" : "DELETE", `/api/users/${args.uid}/follow`),
    postLike: (_ctx, args) => authed(args.on ? "POST" : "DELETE", `/api/posts/${args.id}/like`),
    postCollect: (_ctx, args) => authed(args.on ? "POST" : "DELETE", `/api/posts/${args.id}/collect`),
    postComments: (_ctx, args) => get(`/api/posts/${args.id}/comments?page=${args.page}&size=${args.size}`),
    /* ───────────────────────── 媒体 ───────────────────────── */
    cover: (_ctx, args) => loadImage(args.url),
    mediaFetch: (_ctx, args) => loadMedia(args.url),
    clearCache() {
      clearCaches();
      return { ok: true };
    }
  }
});
var index_default = plugin;
export {
  index_default as default
};
