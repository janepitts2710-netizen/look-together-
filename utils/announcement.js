// 全站公告（前台）：
//   1) 启动时拉一次 /api/site-info，先把当前公告 / 顶部横幅显示出来
//   2) 之后靠 Socket.IO 的 server-info / announcement 事件实时推送，后台点发布前台立刻弹
//   3) 再留一个 60 秒兜底轮询，防止某些环境（小程序、弱网）socket 掉了之后收不到
// 同一条公告只会弹一次（按 id 记在本地存储里），关掉横幅也不会反复出现。
import { reactive } from 'vue'
import { getSocket, getServerBase } from './socket.js'
import { requestJSON } from './request.js'

const SEEN_KEY = 'ann_seen_ids'      // 已经弹过窗的公告 id
const CLOSED_KEY = 'ann_closed_ids'  // 用户主动关掉横幅的公告 id
const MAX_REMEMBER = 30
const POLL_INTERVAL = 60000

const LEVEL_TITLE = {
  info: '📢 系统公告',
  warning: '⚠️ 重要提醒',
  danger: '🚨 紧急公告'
}

export const annState = reactive({
  loaded: false,
  banner: '',          // 「系统配置 → 全站顶部横幅」的常驻文案
  announcement: null,  // 当前生效的公告对象
  barVisible: false,
  barText: '',
  barLevel: 'info',
  bannerClosed: false  // 用户手动关掉了常驻横幅（本次会话内不再显示）
})

let inited = false
let pollTimer = null
let popupShowing = false

// ---------------------------------------------------------------- 本地记录

function readList(key) {
  try {
    const value = uni.getStorageSync(key)
    return Array.isArray(value) ? value : []
  } catch (e) {
    return []
  }
}

function remember(key, id) {
  try {
    const list = readList(key).filter((x) => x !== id)
    list.unshift(id)
    uni.setStorageSync(key, list.slice(0, MAX_REMEMBER))
  } catch (e) {
    // 存储满了就算了，不影响显示
  }
}

// ---------------------------------------------------------------- 渲染状态

function refreshBar() {
  const item = annState.announcement
  const closed = item ? readList(CLOSED_KEY).includes(String(item.id)) : true

  if (item && !closed) {
    annState.barText = item.title || '有新公告'
    annState.barLevel = item.level || 'info'
    annState.barVisible = true
    return
  }

  if (annState.banner && !annState.bannerClosed) {
    annState.barText = annState.banner
    annState.barLevel = 'info'
    annState.barVisible = true
    return
  }

  annState.barVisible = false
}

function buildContent(item) {
  const title = String(item.title || '').trim()
  const content = String(item.content || '').trim()
  if (!content) return title
  if (!title) return content
  return title + '\n\n' + content
}

function showModal(title, content) {
  if (popupShowing) return
  popupShowing = true
  uni.showModal({
    title,
    content,
    showCancel: false,
    confirmText: '我知道了',
    confirmColor: '#0f9d63',
    complete() {
      popupShowing = false
    }
  })
}

/** 弹窗只弹一次；管理员勾了「房间内弹窗」才会弹 */
function maybePopup(item) {
  if (!item || !item.popup) return
  const id = String(item.id)
  if (readList(SEEN_KEY).includes(id)) return
  remember(SEEN_KEY, id)
  showModal(LEVEL_TITLE[item.level] || LEVEL_TITLE.info, buildContent(item))
}

// ---------------------------------------------------------------- 数据落地

function applyAnnouncement(item) {
  annState.announcement = item || null
  refreshBar()
  maybePopup(item)
}

function applySiteInfo(payload) {
  if (!payload) return
  if (typeof payload.banner === 'string') annState.banner = payload.banner.trim()
  if ('announcement' in payload) {
    applyAnnouncement(payload.announcement)
  } else {
    refreshBar()
  }
  annState.loaded = true
}

async function pull() {
  try {
    const base = getServerBase()
    const data = await requestJSON(base + '/api/site-info')
    applySiteInfo(data)
  } catch (e) {
    // 拉不到就等下次轮询 / socket 推送，不打扰用户
  }
}

// ---------------------------------------------------------------- 对外方法

/** 点横幅「详情」：把完整公告再打开一次 */
export function openAnnouncementDetail() {
  const item = annState.announcement
  if (item) {
    showModal(LEVEL_TITLE[item.level] || LEVEL_TITLE.info, buildContent(item))
    return
  }
  if (annState.banner) {
    showModal('📢 公告', annState.banner)
  }
}

/** 关掉顶部条：公告按 id 记住，常驻横幅本次会话内不再出现 */
export function dismissBar() {
  const item = annState.announcement
  if (item && !readList(CLOSED_KEY).includes(String(item.id))) {
    remember(CLOSED_KEY, String(item.id))
  } else if (!item) {
    annState.bannerClosed = true
  }
  refreshBar()
}

/** 在 App onLaunch 里调用一次即可 */
export function initAnnouncement() {
  if (inited) return
  inited = true

  // 先拉一次，保证首屏就能看到
  pull()

  // 实时推送
  try {
    const socket = getSocket()
    socket.on('server-info', (payload) => applySiteInfo(payload))
    socket.on('announcement', (item) => applyAnnouncement(item))
    socket.on('announcement-removed', () => applyAnnouncement(null))
    // 后台改了「全站顶部横幅」也能立刻看到，不用刷新
    socket.on('site-settings', (payload) => {
      if (!payload || typeof payload.announcementBanner !== 'string') return
      annState.banner = payload.announcementBanner.trim()
      annState.bannerClosed = false
      refreshBar()
    })
    socket.connect()
  } catch (e) {
    // socket.io-client 没加载成功也不影响，下面还有轮询兜底
  }

  // 兜底轮询
  if (!pollTimer) {
    pollTimer = setInterval(pull, POLL_INTERVAL)
  }
}

/** 页面里想手动触发刷新时可用 */
export function refreshAnnouncement() {
  return pull()
}
