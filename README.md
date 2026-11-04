<div align="center">

# HGhub

**黄果短剧第三方客户端 · 搭手插件**

沉浸式竖屏播放 · Fluent 设计 · 分类 / 榜单 / 搜索 / 吃瓜

</div>

> ⚠️ 本项目仅供 **学习与技术交流**，不提供、不存储、不分发任何音视频内容。
> 所有内容均来自第三方站点，请自行判断合规性，并在 24 小时内删除相关资源。

## 功能

- **首页**：沉浸式竖屏信息流，上下滑动切换剧集，双击/按钮点赞
- **统一播放页**：标题、作者与关注、可展开简介、话题标签、评分；右侧竖列集成 点赞 / 评论 / 收藏 / 选集 / 分享
- **播放器**：HLS + AES-128 解密播放、倍速、音量、画中画、影院模式、全屏、上下集切换
- **选集**：右侧停靠面板，画面自动让位；播完自动下一集
- **分类**：AI 短剧 / 漫剧 / 换脸 / 魔改 / 黄果吃瓜，支持 最新 / 最热 / 高分 排序与无限滚动
- **排行榜**：热播榜 / 推荐榜 / 潜力榜
- **搜索**：关键词搜索、搜索历史、热门题材、分页加载
- **吃瓜**：图文与图文+视频混排，视频直接播放，图文正文在应用内阅读
- **我的**：登录/注册、收藏与观看历史、深浅主题、关于、清理缓存

## 技术栈

| 层 | 选型 |
| --- | --- |
| 宿主 | 搭手插件（core + 窗口） |
| 前端 | React 19 + TypeScript + Vite 7 + Tailwind CSS 4 |
| 播放 | hls.js（HLS / AES-128）+ 自定义 loader |
| 网络 | core 的 Node（https / 系统代理 / 重试） |
| 图标 | 内联 SVG |

## 目录

```
.
├─ src/                      窗口前端（React）
│  ├─ api.ts                 core API 封装 + 格式化
│  ├─ media.ts               封面 data URL 缓存 + 媒体伪地址 + 剪贴板
│  ├─ hlsLoader.ts           hls.js 自定义 loader（全部请求交给 core）
│  ├─ store.tsx              全局状态（导航栈 / 用户 / 本地收藏 / 主题）
│  ├─ html.ts                吃瓜正文清洗
│  ├─ components/            Feed / VideoSurface / PlayerControls / Panels / UI
│  └─ pages/                 Home / Search / Category / Profile / Posts
├─ src-dashou/               插件根（plugin.json + core）
│  ├─ plugin.json
│  ├─ index.ts               core：登录 / 列表 / 详情 / 互动 / 媒体
│  ├─ net.ts                 边缘信封 + Node 网络层 + 系统代理
│  ├─ media.ts               封面 AES-128 解密 + HLS 播放列表改写
│  ├─ session.ts             token / 用户持久化
│  └─ assets/icon.png
├─ src-tauri/                原 Tauri 工程，仅作迁移参考，不参与构建
├─ docs/API.md               上游接口文档
└─ dashou-dist/              构建产物（.dsp / 解包目录）
```

## 与上游 Tauri 工程的差异

| 原实现 | 现在 |
| --- | --- |
| Rust 命令 + `reqwest` | `src-dashou` 的 core（Node），窗口只通过 `@dashou/api` 调自定义 API |
| 自定义协议 `hg://localhost` 代理封面 / HLS | core API：封面返回 data URL；m3u8 改写成 `dashou-media.local` 伪地址，由 hls.js 自定义 loader 回调 core 取字节 |
| Tauri 无边框标题栏 / 拖拽缩放 | 保留无边框标题栏与 CSS `app-region: drag`；窗口按钮走 `@dashou/api/window`；缩放交给系统边缘 |
| Android 底部标签栏 / 硬件返回键 | 移除（搭手是桌面宿主），只保留桌面侧栏布局 |
| 应用数据目录 `session.json` | 插件数据目录 `$plugin-data/session.json` |

## 开发 / 构建

```bash
pnpm install          # 首次安装
pnpm dev              # 前端热更新（配 plugin.json 的 build.devUrl）
pnpm typecheck        # tsc --noEmit
pnpm dev:core         # 构建并按开发版目录补一份 src-dashou/core.mjs
pnpm plugin:build     # 打包 .dsp，同时补 src-dashou/core.mjs
```

产物：`dashou-dist/com.dashou.hghub-1.0.0.dsp`。

加载方式：

- **开发**：先 `pnpm dev`（UI）与 `pnpm dev:core`（core），搭手「开发者工具」→ 添加项目 → 选 `src-dashou`（插件根）→ 开发 / 打开；UI 改完热更新，改 core 后重跑 `pnpm dev:core` 并点「重新加载」。
- **安装**：插件管理 → 安装插件 → 选 `.dsp`（或直接双击）。

### 宿主 CSP 要求

插件页面的生产 CSP 默认不含 `blob:`，而 hls.js 依赖 MSE 的 blob URL。本插件的 `plugin.json` 声明了：

```json
"csp": "media-src 'self' plugin: data: blob:; worker-src blob:"
```

这依赖搭手宿主的 **插件级 CSP 支持**（`src/common/plugins/csp.ts` + `protocol.ts` / `windowGuards.ts`）。
旧宿主的清单位置会忽略该字段：插件能装，但视频会报 `manifestLoadError` / 无法起播。

### 网络与代理

core 的 Node 直连上游：

1. 优先 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量；
2. 没有环境变量时读取系统代理（macOS `scutil --proxy`、Windows 注册表 `Internet Settings`、Linux `gsettings`）；
3. 都失败时按直连处理，并做 3 次重试。

## 接口

接口细节见 [docs/API.md](docs/API.md)。站点把全部 `/api/**` 收敛为 `POST /api/edge/request`，
core 只实现这一个信封，其余接口都是「填 path」。

## 免责声明

- 本项目与内容提供方无任何关联，作者不参与内容的制作、上传与分发。
- 使用者应自行遵守所在地法律法规；因使用本项目产生的任何后果由使用者自行承担。
- 若相关权利方认为本项目存在侵权，请通过 Issue 联系，我们会及时处理。

## License

[MIT](LICENSE)

## 上游

原始工程：[Minireel/HGhub](https://github.com/Minireel/HGhub)（Rust + Tauri 2）。
