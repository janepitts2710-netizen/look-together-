// 扫码结果解析：把二维码里的内容翻译成站内跳转地址
//
// 二维码里可能是这些形态：
//   https://xxx.trycloudflare.com/#/pages/room/room?roomId=ABC123
//   http://172.20.92.2:3000/#/pages/gomoku/gomoku?roomId=ABC123
//   /#/pages/music/room?roomId=ABC123
//   pages/doudizhu/doudizhu?roomId=ABC123
//   https://host/pages/room/room?roomId=ABC123   （history 路由模式）
// 统一拆出 page + roomId，再交给 uni.navigateTo。

/** 允许扫码直达的页面，其余一律当作不认识的二维码 */
const PAGE_WHITELIST = [
  'pages/index/home',
  'pages/index/index',
  'pages/room/room',
  'pages/gomoku/gomoku',
  'pages/doudizhu/doudizhu',
  'pages/music/music',
  'pages/music/room'
]

/** 不需要房号的页面 */
const NO_ROOM_PAGES = ['pages/index/home', 'pages/index/index', 'pages/music/music']

function pickParam(query, keys) {
  if (!query) return ''
  const list = String(query).split('&')
  for (let i = 0; i < list.length; i += 1) {
    const seg = list[i]
    if (!seg) continue
    const eq = seg.indexOf('=')
    const k = eq >= 0 ? seg.slice(0, eq) : seg
    const v = eq >= 0 ? seg.slice(eq + 1) : ''
    let key = k
    let val = v
    try {
      key = decodeURIComponent(k)
      val = decodeURIComponent(v)
    } catch (e) {
      /* 编码异常就按原样用 */
    }
    if (keys.indexOf(key.trim()) >= 0) return String(val).trim()
  }
  return ''
}

/**
 * 解析扫码内容
 * @param {string} raw 二维码原始文本
 * @returns {{ok:boolean, page?:string, roomId?:string, url?:string, reason?:string}}
 */
export function parseScanResult(raw) {
  const text = String(raw || '').trim()
  if (!text) return { ok: false, reason: 'empty' }

  // 1) 先剥掉域名，只留路由部分；hash 路由优先
  let body = text
  const hashAt = body.indexOf('#')
  if (hashAt >= 0) {
    body = body.slice(hashAt + 1)
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(body)) {
    try {
      const u = new URL(body)
      body = `${u.pathname || ''}${u.search || ''}`
    } catch (e) {
      return { ok: false, reason: 'unknown' }
    }
  }
  body = body.replace(/^\/+/, '')

  // 2) 拆 path / query
  let path = body
  let query = ''
  const qAt = body.indexOf('?')
  if (qAt >= 0) {
    path = body.slice(0, qAt)
    query = body.slice(qAt + 1)
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '')

  // 3) 容忍少了 "pages/" 前缀的写法
  if (path && path.indexOf('pages/') > 0) {
    path = path.slice(path.indexOf('pages/'))
  }

  if (path.indexOf('pages/') !== 0) {
    return { ok: false, reason: /^https?:/i.test(text) ? 'foreign' : 'unknown' }
  }
  if (PAGE_WHITELIST.indexOf(path) < 0) {
    return { ok: false, reason: 'unknown', page: path }
  }

  const roomId = pickParam(query, ['roomId', 'roomid', 'room', 'id'])
  if (!roomId && NO_ROOM_PAGES.indexOf(path) < 0) {
    // 房间页没有房号就没意义，提示重新扫房间内那张码
    return { ok: false, reason: 'no-room', page: path }
  }

  let url = `/${path}`
  if (roomId && NO_ROOM_PAGES.indexOf(path) < 0) {
    url += `?roomId=${encodeURIComponent(roomId)}`
  }
  return { ok: true, page: path, roomId, url }
}

/** 给用户看的失败原因 */
export function scanFailText(parsed) {
  const reason = (parsed && parsed.reason) || 'unknown'
  if (reason === 'no-room') return '这张码里没有房间号，请扫房间内那张'
  if (reason === 'foreign') return '这不是星梦小筑的二维码'
  if (reason === 'empty') return '没有识别到内容，请对准二维码'
  return '没认出这是哪个房间，换个码试试'
}

/** 扫码成功后跳过去；首页重复时用 reLaunch 避免叠页 */
export function goScanTarget(parsed) {
  return new Promise((resolve, reject) => {
    if (!parsed || !parsed.ok) return reject(new Error('bad'))
    const isHome = parsed.page === 'pages/index/home'
    const opts = {
      url: parsed.url,
      success: resolve,
      fail: reject
    }
    if (isHome) {
      uni.reLaunch(opts)
    } else {
      uni.navigateTo(opts)
    }
  })
}
