/**
 * 开发版插件根是 src-dashou/，宿主只在插件根找 core.mjs。
 * 每次构建后把打包出的 core.mjs 复制过去，开发者工具选 src-dashou 才能跑 core。
 * 该文件是构建产物，已在 .gitignore 里忽略。
 */
import { copyFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const from = join(root, 'dashou-dist', 'com.dashou.hghub', 'core.mjs')
const to = join(root, 'src-dashou', 'core.mjs')

try {
  await access(from)
} catch {
  console.warn(`[copy-dev-core] 找不到 ${from}，先跑一次 dashou-plugin build。`)
  process.exit(0)
}

await copyFile(from, to)
console.log(`[copy-dev-core] ${from} → ${to}`)
