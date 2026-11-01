#!/usr/bin/env node
// 用 HBuilderX 自带的 Vue3 编译器构建 H5。
//
// 背景：HBuilderX 5.24 的「发行 → 网站-H5手机版」在部分环境下会直接报
//   Could not resolve entry module "index.html".
// 原因是编译器进程没有识别出“自己在 HBuilderX 里”，把 root 当成了编译器目录。
// 这个脚本显式设置 HX_APP_ROOT / UNI_INPUT_DIR / UNI_OUTPUT_DIR，稳定产出到
// unpackage/dist/build/h5，等价于正常发行结果。
//
// 用法：node scripts/build-h5.mjs   或   npm run build:h5
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function findHBuilderX() {
  const candidates = [
    process.env.HX_APP_ROOT,
    process.env.HBUILDERX_HOME,
    'C:\\HBuilderX',
    'D:\\HBuilderX',
    'C:\\Program Files\\HBuilderX'
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(path.join(p, 'plugins', 'uniapp-cli-vite', 'package.json'))) || ''
}

const hxRoot = findHBuilderX()
if (!hxRoot) {
  console.error('没有找到 HBuilderX 安装目录。请设置环境变量 HX_APP_ROOT 指向 HBuilderX 根目录后重试。')
  process.exit(1)
}

const nodeExe = path.join(hxRoot, 'plugins', 'node18', 'node.exe')
const cliRoot = path.join(hxRoot, 'plugins', 'uniapp-cli-vite')
const cli = path.join(cliRoot, 'node_modules', '@dcloudio', 'vite-plugin-uni', 'bin', 'uni.js')
const outDir = path.join(projectRoot, 'unpackage', 'dist', 'build', 'h5')

for (const [label, target] of [['Node 运行时', nodeExe], ['Vue3 编译器', cli]]) {
  if (!fs.existsSync(target)) {
    console.error('缺少' + label + '：' + target)
    process.exit(1)
  }
}

const env = {
  ...process.env,
  HX_APP_ROOT: hxRoot,
  UNI_INPUT_DIR: projectRoot,
  UNI_OUTPUT_DIR: outDir,
  UNI_PLATFORM: 'h5',
  NODE_ENV: 'production'
}
// 避免旧的环境变量把 root 指到别处
delete env.UNI_HBUILDERX_PLUGINS
delete env.VITE_ROOT_DIR

console.log('项目：' + projectRoot)
console.log('编译器：' + cliRoot)
console.log('输出：' + outDir)
console.log('')

const child = spawn(nodeExe, [cli, 'build', '-p', 'h5'], { cwd: cliRoot, env, stdio: 'inherit' })
child.on('exit', (code) => {
  const indexFile = path.join(outDir, 'index.html')
  if (code === 0 && fs.existsSync(indexFile)) {
    console.log('')
    console.log('✅ 构建完成：' + outDir)
    console.log('   重启后端后访问 http://<你的IP>:3000 即可（后端会自动托管该目录）。')
    process.exit(0)
  }
  console.error('')
  console.error('❌ 构建失败，退出码 ' + code)
  process.exit(code || 1)
})
