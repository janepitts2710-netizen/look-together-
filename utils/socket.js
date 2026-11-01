// 全局唯一的 Socket.IO 客户端实例
// H5 端用 index.html 引入的 socket.io-client（CDN 失败时会回退到后端的 /socket.io/socket.io.js）
// 小程序端用 uni.request 实现轻量 Socket.IO 客户端，不依赖 npm 包。
import { H5_SERVER_BASE, MP_SERVER_BASE } from './config.js'

let socket = null

// #ifdef H5
const io = (typeof window !== 'undefined' && window.io) ? window.io : null
// #endif

function trimTrailingSlash(base) {
  return String(base || '').replace(/\/+$/, '')
}

export function getServerBase() {
  // #ifdef H5
  // '' = 同源（推荐）。同源部署时 '/api/xxx'、'/uploads/xxx' 和 io() 都会自动使用当前域名；
  // 前后端分离时在 utils/config.js 里把 H5_SERVER_BASE 改成 'https://api.example.com'。
  return trimTrailingSlash(H5_SERVER_BASE)
  // #endif
  // #ifndef H5
  let base = 'http://localhost:3000'
  try {
    const info = uni.getSystemInfoSync()
    if (info && info.platform && info.platform !== 'devtools') {
      base = MP_SERVER_BASE
    }
  } catch (e) {
    // 读取环境信息失败时保持默认
  }
  return trimTrailingSlash(base)
  // #endif
}

// #ifdef H5
function getIO() {
  if (!io) {
    throw new Error('socket.io-client 未加载：请检查网络，或确认能访问 /socket.io/socket.io.js')
  }
  return io
}
// #endif

// #ifndef H5
// 轻量 Socket.IO 客户端：基于 uni.request 的 polling 模式，适配微信小程序
function createMPSocket(baseUrl) {
  const listeners = {}
  const onceListeners = {}
  let sid = null
  let isConnected = false
  let manuallyClosed = false
  let connecting = false
  // 轮询代际标记：重新 connect() 时递增，使旧轮询循环立即失效
  let loopId = 0
  let reconnectTimer = null

  function on(event, cb) {
    (listeners[event] = listeners[event] || []).push(cb)
    return api
  }

  function once(event, cb) {
    const wrapper = function (...args) {
      off(event, wrapper)
      cb.apply(null, args)
    }
    wrapper._cb = cb
    ;(onceListeners[event] = onceListeners[event] || []).push(wrapper)
    return api
  }

  function off(event, cb) {
    if (!event) return
    if (listeners[event]) listeners[event] = listeners[event].filter(fn => fn !== cb)
    if (onceListeners[event]) onceListeners[event] = onceListeners[event].filter(fn => fn !== cb && fn._cb !== cb)
  }

  function emitEvent(event, ...args) {
    ;(listeners[event] || []).slice().forEach(fn => fn.apply(null, args))
    ;(onceListeners[event] || []).slice().forEach(fn => fn.apply(null, args))
  }

  function buildUrl() {
    let url = baseUrl.replace(/\/$/, '') + '/socket.io/?EIO=4&transport=polling&t=' + Date.now()
    if (sid) url += '&sid=' + encodeURIComponent(sid)
    return url
  }

  function request(method, data, callback) {
    uni.request({
      url: buildUrl(),
      method,
      data: data || '',
      dataType: 'text',
      header: {
        'Content-Type': 'text/plain;charset=UTF-8'
      },
      success: (res) => {
        if (res.statusCode >= 400) {
          console.error('[MP-SOCKET] request HTTP 失败', method, res.statusCode, res.data)
          const err = new Error('HTTP ' + res.statusCode)
          callback(err)
          return
        }
        callback(null, res.data)
      },
      fail: (err) => {
        console.error('[MP-SOCKET] request 失败', method, err && err.errMsg)
        callback(err)
      }
    })
  }

  function sendPacket(payload) {
    if (!sid && payload !== '40') return
    request('POST', payload, (err) => {
      if (err) {
        isConnected = false
        emitEvent('connect_error', err)
        scheduleReconnect()
      }
    })
  }

  function handlePackets(raw) {
    if (typeof raw !== 'string') {
      console.error('[MP-SOCKET] 响应不是文本，dataType 可能仍被解析成 JSON：', raw)
    }
    const text = String(raw || '')
    if (text) {
      console.log('[MP-SOCKET] 收到数据:', text)
    }
    const packets = text.split('\x1e')
    for (let i = 0; i < packets.length; i++) {
      const packet = packets[i]
      if (!packet) continue
      const type = packet.charAt(0)

      if (type === '0') {
        // Engine.IO open，拿到 sid 后发送 Socket.IO connect 包
        try {
          const info = JSON.parse(packet.slice(1))
          sid = info.sid
        } catch (e) {}
        sendPacket('40')
      } else if (type === '2') {
        // ping，回复 pong
        sendPacket('3')
      } else if (type === '3') {
        // pong
      } else if (type === '4') {
        const msg = packet.slice(1)
        if (msg.charAt(0) === '0') {
          isConnected = true
          console.log('[MP-SOCKET] 连接成功')
          emitEvent('connect')
        } else if (msg.charAt(0) === '1') {
          isConnected = false
          emitEvent('disconnect')
        } else if (msg.charAt(0) === '2') {
          try {
            const data = JSON.parse(msg.slice(1))
            const eventName = data[0]
            const args = data.slice(1)
            emitEvent(eventName, ...args)
          } catch (e) {
            // 忽略无法解析的消息
          }
        } else if (msg.charAt(0) === '4') {
          emitEvent('connect_error', new Error('Socket.IO 连接失败'))
        }
      } else if (type === '1') {
        isConnected = false
        emitEvent('disconnect')
      }
    }
  }

  function poll(id) {
    if (manuallyClosed || id !== loopId) return
    request('GET', null, (err, data) => {
      if (id !== loopId) return
      if (err) {
        isConnected = false
        emitEvent('connect_error', err)
        scheduleReconnect()
        return
      }
      handlePackets(data)
      if (!manuallyClosed) {
        setTimeout(() => poll(id), 20)
      }
    })
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer)
    reconnectTimer = setTimeout(() => {
      if (!manuallyClosed) connect()
    }, 2000)
  }

  function connect() {
    if (manuallyClosed) return
    clearTimeout(reconnectTimer)
    // 已连接时保持现有连接，避免页面跳转后重复握手导致旧轮询循环卡住新连接
    if (isConnected) return
    if (connecting) return
    connecting = true
    loopId += 1
    const id = loopId
    sid = null
    isConnected = false
    console.log('[MP-SOCKET] 开始连接', baseUrl)
    request('GET', null, (err, data) => {
      if (id !== loopId) return
      connecting = false
      if (err) {
        console.error('[MP-SOCKET] 握手失败', err && err.errMsg)
        emitEvent('connect_error', err)
        scheduleReconnect()
        return
      }
      console.log('[MP-SOCKET] 握手响应:', data)
      handlePackets(data)
      poll(id)
    })
  }

  function close() {
    manuallyClosed = true
    clearTimeout(reconnectTimer)
    loopId += 1
    connecting = false
    sid = null
    isConnected = false
  }

  const api = {
    get connected() {
      return isConnected
    },
    on,
    once,
    off,
    emit(event, data) {
      sendPacket('42' + JSON.stringify([event, data]))
      return api
    },
    connect,
    close
  }

  return api
}
// #endif

export function getSocket() {
  if (socket) return socket

  // #ifdef H5
  // 同源时用当前 origin；分离部署时用配置的域名。io 未加载会抛出可读错误，而不是 TypeError
  const socketOrigin = getServerBase() || (typeof window !== 'undefined' ? window.location.origin : '')
  socket = getIO()(socketOrigin, {
    transports: ['websocket', 'polling'],
    // 一旦升级到 WebSocket 就记住，重连不再先走一轮 polling（异地隧道下轮询会慢很多）
    rememberUpgrade: true,
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000
  })
  // #endif

  // #ifndef H5
  socket = createMPSocket(getServerBase())
  // #endif

  return socket
}
