/**
 * 一键启动（可移植：不依赖盘符 / 安装目录）
 *
 * 做四件事：
 *   1. 检查 Node.js 版本（node:sqlite 需要 22.5+）
 *   2. 缺依赖时自动 npm install（失败切国内镜像）
 *   3. 启动后端，等 /api/health 通了再开浏览器
 *   4. 启动公网隧道（cpolar / cloudflare），让异地网络也能进房
 *
 * 任何电脑解压后双击「一键启动.bat」即可；不要写死 D:\ 路径。
 */
'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const http = require('http')

const ROOT = __dirname
const SERVER_DIR = path.join(ROOT, 'server')
const PORT = Number(process.env.PORT || 3000)
const NO_OPEN = process.env.NO_OPEN === '1'
const NO_TUNNEL = process.env.NO_TUNNEL === '1' || !!String(process.env.PUBLIC_URL || '').trim()
let tunnelProc = null

const REQUIRED = ['express', 'socket.io', 'multer', 'axios', 'cors', 'jsonwebtoken', 'bcryptjs']

function line(text = '') {
  console.log(text)
}

function fail(msg) {
  line('')
  line('  ' + msg)
  line('')
  line('  按任意键关闭窗口…')
  process.exit(1)
}

function inspectDeps() {
  for (const name of REQUIRED) {
    try {
      require.resolve(name, { paths: [SERVER_DIR] })
    } catch (e) {
      return { name, reason: '未安装' }
    }
  }
  for (const name of REQUIRED) {
    try {
      require(require.resolve(name, { paths: [SERVER_DIR] }))
    } catch (e) {
      return { name, reason: '加载失败：' + String(e.message || e.code).split('\n')[0] }
    }
  }
  return null
}

function runNpm(args, extraEnv) {
  return new Promise((resolve) => {
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npmCmd, args, {
      cwd: SERVER_DIR,
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, ...(extraEnv || {}) }
    })
    child.on('error', (err) => {
      line('  [警告] 无法执行 npm：' + err.message)
      resolve(-1)
    })
    child.on('exit', (code) => resolve(code === null ? -1 : code))
  })
}

async function installDeps() {
  let broken = inspectDeps()
  if (!broken) return

  line('  首次运行，需要安装后端依赖（约 1-2 分钟，请保持联网）。')
  line('  待处理：' + broken.name + '（' + broken.reason + '）')
  line('')
  let code = await runNpm(['install', '--omit=dev'])
  if (code !== 0) {
    line('')
    line('  首次安装未成功，切换国内镜像重试…')
    line('')
    code = await runNpm(['install', '--omit=dev'], {
      npm_config_registry: 'https://registry.npmmirror.com'
    })
  }
  if (code !== 0) {
    fail('[错误] 依赖安装失败。\n'
      + '        请检查网络后重试，或手动在 server 目录执行：npm install --omit=dev\n'
      + '        国内网络可先执行：npm config set registry https://registry.npmmirror.com')
  }
  broken = inspectDeps()
  if (broken) {
    fail('[错误] 依赖仍不可用：' + broken.name + '（' + broken.reason + '）\n'
      + '        请删除 server\\node_modules 后重新双击启动。')
  }
  line('  依赖安装完成。')
  line('')
}

function waitForHealth(timeoutMs = 30000) {
  const started = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      const req = http.get(
        { host: '127.0.0.1', port: PORT, path: '/api/health', timeout: 1200 },
        (res) => {
          res.resume()
          if (res.statusCode && res.statusCode < 500) return resolve(true)
          retry()
        }
      )
      req.on('error', retry)
      req.on('timeout', () => { req.destroy(); retry() })
    }
    const retry = () => {
      if (Date.now() - started > timeoutMs) return resolve(false)
      setTimeout(tick, 500)
    }
    tick()
  })
}

function openBrowser(url) {
  if (NO_OPEN) return
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
  } catch (e) {
    /* 打开浏览器失败不影响服务 */
  }
}

function startTunnel() {
  if (NO_TUNNEL) return null
  const child = spawn(process.execPath, ['tunnel.js'], {
    cwd: SERVER_DIR,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(PORT), TUNNEL_QUIET: '1', DISABLE_NGROK: '1', TUNNEL_PROVIDER: 'auto' }
  })
  child.on('error', (err) => line('  [警告] 隧道启动失败：' + err.message))
  child.on('exit', (code) => {
    if (code && code !== 0) line('  [提示] 隧道已退出，局域网内仍可正常使用。')
  })
  return child
}

function waitForTunnel(since, timeoutMs = 25000) {
  if (NO_TUNNEL) return ''
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      try {
        const f = path.join(SERVER_DIR, 'data', 'tunnel.json')
        if (fs.existsSync(f)) {
          const data = JSON.parse(fs.readFileSync(f, 'utf8'))
          if (data && data.url && /^https?:\/\//i.test(data.url)) {
            if (!data.at || data.at >= since - 5000) return resolve(String(data.url).replace(/\/+$/, ''))
          }
        }
      } catch (e) { /* 还没写好 */ }
      if (Date.now() - started > timeoutMs) return resolve('')
      setTimeout(tick, 500)
    }
    tick()
  })
}
;(async () => {
  line('')
  line('  星梦小筑 正在启动…')
  line('')

  const major = Number((process.versions.node || '0').split('.')[0])
  const minor = Number((process.versions.node || '0.0').split('.')[1] || 0)
  if (major < 22 || (major === 22 && minor < 5)) {
    fail('[错误] 当前 Node.js 版本是 ' + process.versions.node + '，需要 22.5 或更高。\n'
      + '        请到 https://nodejs.org/en/download 安装 LTS 后重试。')
  }
  if (!fs.existsSync(path.join(SERVER_DIR, 'index.js'))) {
    fail('[错误] 找不到 server/index.js。\n'
      + '        请先完整解压压缩包，不要在压缩包里直接双击。')
  }

  await installDeps()

  const server = spawn(process.execPath, ['index.js'], {
    cwd: SERVER_DIR,
    stdio: 'inherit',
    env: { ...process.env, PORT: String(PORT), QUIET_START: '1', AUTO_OPEN: '0' }
  })
  server.on('error', (err) => fail('[错误] 服务启动失败：' + err.message))
  server.on('exit', (code) => {
    if (code && code !== 0) line('  服务异常退出（退出码 ' + code + '）。')
    else line('  服务已停止。')
    try { if (tunnelProc) tunnelProc.kill() } catch (e) {}
    process.exit(0)
  })

  const ok = await waitForHealth()
  if (!ok) fail('[错误] 服务启动失败，请把窗口里的报错截图反馈。')

  const tunnelStartedAt = Date.now()
  tunnelProc = startTunnel()
  const pub = await waitForTunnel(tunnelStartedAt)

  line('')
  line('  ========================================')
  line('         星梦小筑 已启动')
  line('  ========================================')
  line('  本机：http://localhost:' + PORT)
  if (pub) {
    line('  公网：' + pub)
    line('  手机：打开上面的公网地址，或扫房间二维码')
  } else {
    line('  公网：隧道还在连接，稍后刷新房间二维码')
  }
  line('')
  line('  这个窗口不要关。')
  line('')
  openBrowser('http://localhost:' + PORT)

  const shutdown = () => {
    try { if (tunnelProc) tunnelProc.kill() } catch (e) {}
    try { server.kill() } catch (e) {}
    setTimeout(() => process.exit(0), 200)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
})().catch((err) => fail('[错误] 启动过程出错：' + (err && err.message ? err.message : err)))
