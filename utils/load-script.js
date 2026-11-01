// 按需加载同源脚本
//
// 手机端首屏慢的一大半原因，是 <head> 里塞了几个大体积同步脚本：
// 浏览器必须等它们下载 + 执行完，才肯渲染页面。这里改成「用到才下载」：
//   - 观影厅要用 DPlayer / hls.js 才加载（约 660KB）
//   - 打开扫码面板才加载 jsQR（约 250KB）
//   - 房间页要出二维码才加载 qrcode（约 23KB）
// 首页因此一行第三方脚本都不用等。
//
// 同一个地址只下载一次；并发调用共用同一个 Promise，不会重复插 <script>。

const pending = {}

/**
 * 加载一个脚本，返回 Promise
 * @param {string} url 脚本地址（建议用 /static/lib/xxx.js 这种同源绝对路径）
 * @param {string} [globalName] 脚本挂到 window 上的全局变量名，用于「已经有了就不再下载」
 */
export function loadScript(url, globalName) {
  if (typeof document === 'undefined') return Promise.resolve(false)
  if (globalName && typeof window !== 'undefined' && window[globalName]) return Promise.resolve(true)
  if (pending[url]) return pending[url]

  pending[url] = new Promise((resolve, reject) => {
    const el = document.createElement('script')
    el.src = url
    el.async = true
    el.onload = () => resolve(true)
    el.onerror = () => {
      // 失败后允许下次重试（比如刚开页面网络还没就绪）
      delete pending[url]
      reject(new Error('脚本加载失败：' + url))
    }
    document.head.appendChild(el)
  })
  return pending[url]
}

/**
 * 一次加载多个脚本，全部完成才 resolve
 * @param {Array<[string, string?]>} list [[url, globalName], ...]
 */
export function loadScripts(list) {
  return Promise.all(list.map(([url, name]) => loadScript(url, name)))
}

// ---- 具体库的加载入口（统一在这里改版本路径）----

// DPlayer 播放器（样式由它自己注入，不需要额外 CSS）
export function ensureDPlayer() {
  return loadScript('/static/lib/DPlayer.min.js', 'DPlayer')
}

// hls.js 轻量版：只支持 HLS 播放，体积比完整版小 35%
export function ensureHls() {
  return loadScript('/static/lib/hls.light.min.js', 'Hls')
}

// 二维码解码（扫码面板用）
export function ensureJsQR() {
  return loadScript('/static/js/jsqr.min.js', 'jsQR')
}

// 二维码生成（房间分享卡片用）
export function ensureQRCode() {
  return loadScript('/static/js/qrcode.min.js', 'QRCode')
}
