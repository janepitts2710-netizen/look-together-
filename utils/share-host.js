// 分享地址解析：给「扫码进房」用的候选地址列表
//
// 这是全站唯一的一份实现 —— 观影厅(room.vue)、五子棋、斗地主、音乐厅
// 四个房间的二维码都走这里，避免各写一套导致行为不一致。
//
// 优先级：公网隧道（谁都能扫）→ 当前地址（非 localhost 时）→ 局域网各网卡
// 页面里直接调 resolveShareHosts()，拿到 bases[0] 就是最适合做二维码的地址。
import { getServerBase } from './socket.js'
import { requestJSON } from './request.js'

const LOOPBACK_RE = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|\[::1\])$/i

function stripSlash(v) {
  return String(v || '').replace(/\/+$/, '')
}

/** 网卡类型 → 界面上给人看的称呼 */
export function hostKindLabel(kind) {
  if (kind === 'wifi') return 'Wi-Fi'
  if (kind === 'ethernet') return '有线'
  if (kind === 'virtual') return '虚拟网卡'
  return ''
}

/** 用某个地址前缀 + 页面路径拼出可扫码的完整链接 */
export function buildShareLink(base, pagePath, roomId) {
  const root = stripSlash(base) || (typeof window !== 'undefined' ? window.location.origin : '')
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '/'
  const page = String(pagePath || '').replace(/^#/, '')
  const suffix = roomId ? `?roomId=${encodeURIComponent(roomId)}` : ''
  return `${root}${pathname}#${page}${suffix}`
}

/** 探测公网地址是否真的可用：隧道被关掉/超时就不该拿来做二维码 */
export function probePublicUrl(url, timeout = 4000) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return resolve(true)
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null
    window
      .fetch(`${stripSlash(url)}/api/health`, {
        signal: ctrl ? ctrl.signal : undefined,
        cache: 'no-store'
      })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => resolve(!!(data && data.ok)))
      .catch(() => resolve(false))
      .finally(() => {
        if (timer) clearTimeout(timer)
      })
  })
}

/**
 * 算出分享/二维码可用的地址候选
 * @returns {Promise<{bases: Array<{base:string,name:string,kind:string}>, tunnelOn:boolean}>}
 */
export async function resolveShareHosts() {
  const result = { bases: [], tunnelOn: false }
  if (typeof window === 'undefined') return result

  const hostname = window.location.hostname || ''
  const isLoopback = !hostname || LOOPBACK_RE.test(hostname)
  const isIpv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)

  // 已经用域名打开（公网隧道或正式部署）：当前地址最靠谱
  if (!isLoopback && !isIpv4) {
    // 公网隧道域名：Cloudflare 快速隧道（trycloudflare.com）或 cpolar 国内节点（cpolar.cn/.top/.io）
    result.tunnelOn = /(^|\.)(trycloudflare\.com|cpolar\.(cn|top|io|xyz))$/i.test(hostname)
    result.bases = [{ base: window.location.origin, name: '当前域名', kind: 'domain' }]
    return result
  }

  const bases = []
  const same = (a, b) => stripSlash(a) === stripSlash(b)

  try {
    const data = await requestJSON(`${getServerBase()}/api/health`)
    const pub = data && typeof data.publicUrl === 'string' ? stripSlash(data.publicUrl.trim()) : ''
    // 后端会顺带告诉我们隧道进程还在不在：
    //   true  → 进程在，先按「公网可用」放进候选并置 tunnelOn，但**仍由前端后台探测**
    //           （进程活着 ≠ 地址真能访问，网络抽风时进程在但地址打不开）
    //   false → 隧道已经关了，跳过，二维码立刻用局域网地址出来
    //   null  → 后端也判断不了，这里探测一次再决定
    const alive = data ? data.publicUrlAlive : null
    if (pub && /^https?:\/\//i.test(pub) && alive !== false) {
      if (alive === true) {
        // 先出公网码（网络正常时零等待），前端 verifyPublic 会后台实测，
        // 真连不通会自动降级到局域网并提示
        bases.push({ base: pub, name: '公网·手机在哪都能扫', kind: 'public' })
        result.tunnelOn = true
      } else {
        const ok = await probePublicUrl(pub, 6000)
        if (ok) {
          bases.push({ base: pub, name: '公网·手机在哪都能扫', kind: 'public' })
          result.tunnelOn = true
        }
      }
    }
    // 当前地址本来就是能用的 IP，排第二位
    if (!isLoopback && window.location.origin && !bases.some((i) => same(i.base, window.location.origin))) {
      bases.push({ base: window.location.origin, name: '当前地址', kind: 'current' })
    }
    const port = window.location.port
    const proto = window.location.protocol
    const withPort = (ip) => (port ? `${ip}:${port}` : ip)
    let lanList = []
    if (data && Array.isArray(data.lan) && data.lan.length) {
      lanList = data.lan.map((i) => ({
        base: `${proto}//${withPort(i.ip)}`,
        name: i.kind === 'wifi' ? 'Wi-Fi 局域网' : (i.kind === 'ethernet' ? '有线局域网' : (i.name || '局域网')),
        kind: i.kind || 'lan'
      }))
    } else if (data && Array.isArray(data.lanIps)) {
      lanList = data.lanIps.map((ip) => ({ base: `${proto}//${withPort(ip)}`, name: '局域网', kind: 'lan' }))
    }
    lanList.forEach((i) => {
      if (!bases.some((x) => same(x.base, i.base))) bases.push(i)
    })
  } catch (e) {
    // 拿不到候选时退回当前地址，至少二维码不是空的
  }

  result.bases = bases.length ? bases : [{ base: window.location.origin, name: '当前地址', kind: 'current' }]
  return result
}
