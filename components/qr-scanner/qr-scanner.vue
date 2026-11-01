<template>
  <view v-if="visible" class="qs-mask" @click="onMaskClick">
    <view class="qs-card" @click.stop>
      <view class="qs-head">
        <text class="qs-title">扫码进房</text>
        <view class="qs-x" @click="close">✕</view>
      </view>

      <view class="qs-stage" :class="{ 'qs-stage--idle': !running }">
        <view id="qs-video-slot" class="qs-video"></view>

        <view v-if="running" class="qs-frame">
          <view class="qs-corner qs-corner--tl"></view>
          <view class="qs-corner qs-corner--tr"></view>
          <view class="qs-corner qs-corner--bl"></view>
          <view class="qs-corner qs-corner--br"></view>
          <view class="qs-line"></view>
        </view>

        <view v-if="!running" class="qs-holder">
          <text class="qs-holder-icon">{{ camBlocked ? '⚠️' : '📷' }}</text>
          <text class="qs-holder-text">{{ statusText }}</text>
        </view>
      </view>

      <text class="qs-hint">{{ hintText }}</text>

      <view class="qs-actions">
        <view class="qs-btn qs-btn--primary" @click="pickImage(true)">拍照识别</view>
        <view class="qs-btn" @click="pickImage(false)">相册选图</view>
      </view>

      <text v-if="running" class="qs-sub" @click="stopCamera">关闭摄像头</text>
    </view>
  </view>
</template>

<script>
import { parseScanResult, scanFailText } from '../../utils/qr-link.js'
import { ensureJsQR } from '../../utils/load-script.js'

const SLOT_ID = 'qs-video-slot'
const IS_TOUCH_DEVICE =
  typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod|Mobile|HarmonyOS/i.test(navigator.userAgent)

export default {
  name: 'QrScanner',
  props: {
    visible: {
      type: Boolean,
      default: false
    }
  },
  emits: ['close', 'result'],

  data() {
    return {
      running: false,
      camBlocked: false,
      statusText: '准备中…',
      hintText: '',
      secure: true
    }
  },

  watch: {
    visible(val) {
      if (val) {
        // 每次打开都重置状态：扫成功进房后返回首页，还能再扫下一张
        this.done = false
        this.busy = false
        this.camBlocked = false
        this.statusText = '准备中…'
        this.hintText = ''
        // jsQR 约 250KB，首页不再预加载，改在打开面板这一刻后台拉取：
        // 摄像头同时启动，等它到货再用于逐帧识别，不阻塞开摄像头
        ensureJsQR().catch(() => {
          /* 拿不到就用 BarcodeDetector 或拍照识别兜底 */
        })
        this.$nextTick(() => this.startCamera())
      } else {
        this.stopCamera()
      }
    }
  },

  mounted() {
    this.video = null
    this.stream = null
    this.timer = null
    this.canvas = null
    this.detector = null
    this.busy = false
    this.done = false
    this.secure = this.checkSecure()
    // 切后台要关掉摄像头（否则指示灯一直亮），回到前台再自动接上
    if (typeof document !== 'undefined') {
      this.onVisibility = () => {
        if (!this.visible) return
        if (document.hidden) {
          this.stopCamera()
        } else if (!this.done) {
          this.startCamera()
        }
      }
      document.addEventListener('visibilitychange', this.onVisibility)
    }
  },

  beforeUnmount() {
    if (this.onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibility)
    }
    this.stopCamera()
  },

  // 页面被切走时释放摄像头
  onHide() {
    this.stopCamera()
  },

  methods: {
    checkSecure() {
      if (typeof window === 'undefined') return false
      if (window.isSecureContext) return true
      const h = window.location.hostname || ''
      return /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/i.test(h)
    },

    onMaskClick() {
      // 面板外的暗色区域点击关闭
      this.close()
    },

    close() {
      this.stopCamera()
      this.$emit('close')
    },

    async startCamera() {
      if (this.running || this.done) return
      this.secure = this.checkSecure()
      if (!this.secure) {
        this.camBlocked = true
        this.statusText = '当前是 http 局域网地址，浏览器不允许网页开摄像头'
        this.hintText = '点下面「拍照识别」，直接拍一张二维码也能进房；想用实时扫描请改用 https 公网地址'
        return
      }
      if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        this.camBlocked = true
        this.statusText = '这个浏览器不支持网页调用摄像头'
        this.hintText = '点下面「拍照识别」或「相册选图」照样能进房'
        return
      }

      this.statusText = '正在打开摄像头…'
      this.hintText = '第一次使用需要允许摄像头权限'
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        })
        if (!this.visible || this.done) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        this.stream = stream
        this.mountVideo(stream)
        this.running = true
        this.camBlocked = false
        this.hintText = '把二维码放进框内，识别成功会自动进房'
        this.startDetect()
      } catch (err) {
        this.camBlocked = true
        const name = (err && err.name) || ''
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          this.statusText = '摄像头权限被拒绝了'
          this.hintText = '可以在浏览器地址栏的权限设置里允许摄像头，或点下面「拍照识别」'
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          this.statusText = '没有找到可用的摄像头'
          this.hintText = '点下面「相册选图」，选一张二维码截图也能进房'
        } else {
          this.statusText = '摄像头没能打开'
          this.hintText = '点下面「拍照识别」或「相册选图」照样能进房'
        }
      }
    },

    mountVideo(stream) {
      if (typeof document === 'undefined') return
      const slot = document.getElementById(SLOT_ID)
      if (!slot) return
      let video = this.video
      if (!video) {
        video = document.createElement('video')
        video.setAttribute('playsinline', 'true')
        video.setAttribute('webkit-playsinline', 'true')
        video.setAttribute('muted', 'true')
        video.muted = true
        video.autoplay = true
        video.style.cssText =
          'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;background:#05070f;'
        this.video = video
      }
      if (video.parentNode !== slot) slot.appendChild(video)
      video.srcObject = stream
      const p = video.play()
      if (p && typeof p.catch === 'function') p.catch(() => {})
    },

    startDetect() {
      this.stopDetect()
      // BarcodeDetector 只在部分浏览器可用，能用就用（比 jsQR 快很多）
      if (typeof window !== 'undefined' && typeof window.BarcodeDetector === 'function') {
        try {
          this.detector = new window.BarcodeDetector({ formats: ['qr_code'] })
        } catch (e) {
          this.detector = null
        }
      }
      this.timer = setInterval(() => this.detectOnce(), 260)
      setTimeout(() => this.detectOnce(), 600)
    },

    stopDetect() {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
    },

    async detectOnce() {
      if (!this.running || this.busy || this.done) return
      const v = this.video
      if (!v || v.readyState < 2 || !v.videoWidth) return
      this.busy = true
      try {
        let raw = ''
        if (this.detector) {
          const codes = await this.detector.detect(v)
          if (codes && codes.length) raw = codes[0].rawValue || ''
        } else {
          raw = this.decodeVideoFrame(v)
        }
        if (raw) this.handleRaw(raw)
      } catch (e) {
        // 个别浏览器构造成功但 detect 抛错，降级到 jsQR
        this.detector = null
      } finally {
        this.busy = false
      }
    },

    decodeVideoFrame(v) {
      const jsQR = typeof window !== 'undefined' ? window.jsQR : null
      if (typeof jsQR !== 'function') return ''
      const maxW = 640
      const scale = Math.min(1, maxW / v.videoWidth)
      const w = Math.round(v.videoWidth * scale)
      const h = Math.round(v.videoHeight * scale)
      if (!this.canvas) this.canvas = document.createElement('canvas')
      const canvas = this.canvas
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      ctx.drawImage(v, 0, 0, w, h)
      const img = ctx.getImageData(0, 0, w, h)
      const res = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' })
      return res && res.data ? res.data : ''
    },

    /** 识别到内容：先校验是不是能进的房间，能进就交给页面跳转 */
    handleRaw(raw) {
      if (this.done) return
      const parsed = parseScanResult(raw)
      if (!parsed.ok) {
        if (typeof uni !== 'undefined') {
          uni.showToast({ title: scanFailText(parsed), icon: 'none', duration: 1800 })
        }
        return
      }
      this.done = true
      this.stopCamera()
      if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
        try {
          navigator.vibrate(50)
        } catch (e) {
          /* 不支持震动就算了 */
        }
      }
      this.$emit('result', parsed)
    },

    /** 拍照 / 相册识别：不需要安全上下文，http 局域网也能用 */
    pickImage(useCamera) {
      if (typeof document === 'undefined') return
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      if (useCamera && IS_TOUCH_DEVICE) input.setAttribute('capture', 'environment')
      input.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;'
      document.body.appendChild(input)
      input.onchange = () => {
        const file = input.files && input.files[0]
        if (file) this.decodeFile(file)
        setTimeout(() => {
          if (input.parentNode) input.parentNode.removeChild(input)
        }, 100)
      }
      input.click()
    },

    async decodeFile(file) {
      uni.showLoading({ title: '识别中…', mask: true })
      // jsQR 是打开面板时才按需下载的，可能还没到货，等它一下（已缓存则立即返回）
      try {
        await ensureJsQR()
      } catch (e) {
        uni.hideLoading()
        uni.showToast({ title: '识别库加载失败，请检查网络后重试', icon: 'none' })
        return
      }
      const jsQR = typeof window !== 'undefined' ? window.jsQR : null
      if (typeof jsQR !== 'function') {
        uni.hideLoading()
        uni.showToast({ title: '识别库没加载，请刷新页面', icon: 'none' })
        return
      }
      const url = URL.createObjectURL(file)
      const img = new Image()
      img.onload = () => {
        try {
          const maxSide = 1200
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
          const w = Math.max(1, Math.round(img.width * scale))
          const h = Math.max(1, Math.round(img.height * scale))
          const canvas = this.canvas || document.createElement('canvas')
          this.canvas = canvas
          canvas.width = w
          canvas.height = h
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          ctx.drawImage(img, 0, 0, w, h)
          const data = ctx.getImageData(0, 0, w, h)
          // attemptBoth：深色底白色码的图也能认
          const res = jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' })
          uni.hideLoading()
          if (res && res.data) {
            this.handleRaw(res.data)
          } else {
            uni.showToast({ title: '照片里没找到二维码，靠近点再拍', icon: 'none', duration: 2200 })
          }
        } catch (e) {
          uni.hideLoading()
          uni.showToast({ title: '图片读取失败，换一张试试', icon: 'none' })
        }
        URL.revokeObjectURL(url)
      }
      img.onerror = () => {
        uni.hideLoading()
        URL.revokeObjectURL(url)
        uni.showToast({ title: '图片打不开，换一张试试', icon: 'none' })
      }
      img.src = url
    },

    stopCamera() {
      this.stopDetect()
      this.running = false
      if (this.stream) {
        try {
          this.stream.getTracks().forEach((t) => t.stop())
        } catch (e) {
          /* ignore */
        }
        this.stream = null
      }
      if (this.video) {
        try {
          this.video.pause()
          this.video.srcObject = null
          if (this.video.parentNode) this.video.parentNode.removeChild(this.video)
        } catch (e) {
          /* ignore */
        }
        this.video = null
      }
      this.detector = null
      this.busy = false
    }
  }
}
</script>

<style scoped>
.qs-mask {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 9990;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  box-sizing: border-box;
  background: rgba(2, 4, 10, 0.66);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
}

.qs-card {
  display: block;
  width: 100%;
  max-width: 380px;
  padding: 18px 18px 20px;
  box-sizing: border-box;
  border-radius: 22px;
  background: rgba(11, 23, 48, 0.9);
  border: 1px solid rgba(184, 198, 255, 0.16);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.06),
    0 34px 70px -30px rgba(0, 0, 0, 0.9);
  animation: qs-pop 0.26s cubic-bezier(0.22, 1, 0.36, 1) both;
}

@keyframes qs-pop {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.97);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.qs-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.qs-title {
  display: block;
  font-size: 16px;
  font-weight: 700;
  color: #e6ecff;
  letter-spacing: 0.5px;
}

.qs-x {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  font-size: 13px;
  color: #8fa3d9;
  background: rgba(184, 198, 255, 0.08);
  border: 1px solid rgba(184, 198, 255, 0.16);
  cursor: pointer;
}

.qs-x:active {
  background: rgba(77, 107, 254, 0.16);
}

/* 取景框区域保持深色：摄像头画面 / 暗角本来就需要压暗背景 */
.qs-stage {
  position: relative;
  width: 100%;
  /* 方形容器，扫码框好看且省屏幕 */
  aspect-ratio: 1 / 1;
  margin-top: 14px;
  border-radius: 18px;
  overflow: hidden;
  background: radial-gradient(120% 120% at 50% 0%, rgba(77, 107, 254, 0.24) 0%, rgba(4, 7, 15, 0.98) 70%);
  border: 1px solid rgba(184, 198, 255, 0.16);
}

/* 摄像头没开起来时不用占一整个正方形，收窄成横条 */
.qs-stage--idle {
  aspect-ratio: auto;
  height: 196px;
}

.qs-video {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  display: block;
}

.qs-holder {
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 22px;
  box-sizing: border-box;
}

.qs-holder-icon {
  display: block;
  font-size: 42px;
  opacity: 0.9;
}

.qs-holder-text {
  display: block;
  margin-top: 12px;
  font-size: 12.5px;
  line-height: 1.6;
  text-align: center;
  color: rgba(195, 208, 255, 0.72);
}

/* 取景框四角 + 扫描线 */
.qs-frame {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 62%;
  height: 62%;
  transform: translate(-50%, -50%);
  border-radius: 8px;
  pointer-events: none;
  /* 框外压暗，让取景范围一眼可见 */
  box-shadow: 0 0 0 999px rgba(2, 4, 10, 0.55);
}

.qs-corner {
  position: absolute;
  width: 34px;
  height: 34px;
  border: 3px solid #6ee7ff;
  box-shadow: 0 0 12px rgba(110, 231, 255, 0.7);
}

.qs-corner--tl {
  left: -1px;
  top: -1px;
  border-right: 0;
  border-bottom: 0;
  border-radius: 8px 0 0 0;
}

.qs-corner--tr {
  right: -1px;
  top: -1px;
  border-left: 0;
  border-bottom: 0;
  border-radius: 0 8px 0 0;
}

.qs-corner--bl {
  left: -1px;
  bottom: -1px;
  border-right: 0;
  border-top: 0;
  border-radius: 0 0 0 8px;
}

.qs-corner--br {
  right: -1px;
  bottom: -1px;
  border-left: 0;
  border-top: 0;
  border-radius: 0 0 8px 0;
}

.qs-line {
  position: absolute;
  left: 6%;
  right: 6%;
  top: 0;
  height: 2px;
  border-radius: 2px;
  background: linear-gradient(90deg, rgba(110, 231, 255, 0) 0%, #6ee7ff 50%, rgba(110, 231, 255, 0) 100%);
  box-shadow: 0 0 12px rgba(110, 231, 255, 0.8);
  animation: qs-scan 2.1s ease-in-out infinite;
}

@keyframes qs-scan {
  0% {
    top: 2%;
    opacity: 0.2;
  }
  50% {
    top: 96%;
    opacity: 1;
  }
  100% {
    top: 2%;
    opacity: 0.2;
  }
}

.qs-hint {
  display: block;
  margin-top: 12px;
  min-height: 34px;
  font-size: 12px;
  line-height: 1.6;
  color: #8fa3d9;
}

.qs-actions {
  display: flex;
  gap: 10px;
  margin-top: 6px;
}

.qs-btn {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 42px;
  border-radius: 13px;
  font-size: 13.5px;
  color: var(--c-text);
  background: rgba(184, 198, 255, 0.07);
  border: 1px solid rgba(184, 198, 255, 0.18);
  cursor: pointer;
  transition: transform 0.16s ease, background 0.16s ease;
}

.qs-btn--primary {
  color: #ffffff;
  font-weight: 600;
  background: linear-gradient(135deg, #6d8bff 0%, #4d6bfe 100%);
  border-color: transparent;
  box-shadow: 0 10px 22px -14px rgba(77, 107, 254, 0.95);
}

.qs-btn:active {
  transform: scale(0.97);
  background: rgba(77, 107, 254, 0.16);
}

.qs-btn--primary:active {
  background: linear-gradient(135deg, #4d6bfe 0%, #3b55e0 100%);
}

.qs-sub {
  display: block;
  margin-top: 12px;
  text-align: center;
  font-size: 11.5px;
  color: #8aa89b;
  text-decoration: underline;
  cursor: pointer;
}
</style>
