/**
 * 客户端 ↔ 服务器 时钟对齐
 *
 * 为什么要这个：
 *   房主每 5 秒才发一次进度，成员收到时这个数字已经是「几秒前」的了。
 *   更糟的是网慢的一方每次都被强行 seek 一次，缓冲全废，越追越远。
 *
 * 做法：
 *   服务端在每次状态里带上自己的时间戳 at，客户端用这里的偏移把它换算成
 *   「此刻应该在几分几秒」。这样哪怕消息迟到 5 秒，位置依然是准的。
 *
 *   偏移用 ping-pong 估：一轮里取 RTT 最小的那次样本（最接近对称路径）。
 */

let offset = 0
let lastRtt = 0
let syncing = false
let timer = null
let ready = false

/** 时钟是否已经对齐过（没对齐前退回旧逻辑，避免设备时间不准导致乱跳） */
export function clockReady() {
  return ready
}

/** 把本地时间换算成服务器时间 */
export function serverNow() {
  return Date.now() + offset
}

export function getClockOffset() {
  return offset
}

export function getClockRtt() {
  return lastRtt
}

function pingOnce(socket, timeout = 3000) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let settled = false
    const finish = (val) => {
      if (settled) return
      settled = true
      resolve(val)
    }
    const timerId = setTimeout(() => finish(null), timeout)
    try {
      socket.emit('time-ping', { t0 }, (res) => {
        clearTimeout(timerId)
        const t3 = Date.now()
        if (!res || typeof res.s !== 'number') return finish(null)
        const rtt = t3 - t0
        // 往返大致对称：服务器时刻 ≈ 本地 t0 + rtt/2 + offset
        finish({ off: res.s - (t0 + rtt / 2), rtt })
      })
    } catch (err) {
      clearTimeout(timerId)
      finish(null)
    }
  })
}

/**
 * 同步一次时钟。<br>
 * 连打几轮，只信 RTT 最小的那几个样本（其余更可能被排队和抖动污染），
 * 再取中位数。手机流量下 RTT 波动很大，只取「最小的一次」很容易被偶然的
 * 一个低延迟样本带偏，而两边各偏几十毫秒，就是「开播还是差一点」的来源。
 */
export async function syncClock(socket, rounds = 6) {
  if (!socket || !socket.connected || syncing) return offset
  syncing = true
  try {
    const samples = []
    for (let i = 0; i < rounds; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const sample = await pingOnce(socket)
      if (sample) samples.push(sample)
    }
    if (samples.length) {
      const best = samples.sort((a, b) => a.rtt - b.rtt).slice(0, Math.min(3, samples.length))
      const offs = best.map((x) => x.off).sort((a, b) => a - b)
      offset = offs[Math.floor(offs.length / 2)]
      lastRtt = best[0].rtt
      ready = true
    }
  } finally {
    syncing = false
  }
  return offset
}

/** 进房时对齐一次，之后每分钟校正一次慢慢漂移的时钟 */
export function startClockSync(socket, intervalMs = 60000) {
  stopClockSync()
  syncClock(socket)
  timer = setInterval(() => {
    if (socket && socket.connected) syncClock(socket, 2)
  }, intervalMs)
}

export function stopClockSync() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/**
 * 根据房间状态推算「此刻」应该播到的位置
 * @param {{time:number, playing:boolean, rate:number, at:number}} state
 */
export function positionAt(state) {
  if (!state) return 0
  const base = Number(state.time) || 0
  if (!state.playing) return base
  const at = Number(state.at) || 0
  // 还没对时（或对不上）就退回「直接用收到的时间」，行为等同旧版本
  if (!at || !ready) return base
  const rate = Number(state.rate) || 1
  const elapsed = (serverNow() - at) / 1000
  return base + Math.max(0, elapsed) * rate
}
