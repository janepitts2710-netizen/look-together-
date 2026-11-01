<template>
  <!-- #ifdef H5 -->
  <view v-if="roomId" class="share-qr">
    <view class="sqr-head">
      <view class="sqr-head__text">
        <text class="sqr-title">{{ title }}</text>
        <text class="sqr-sub">{{ subtitle }}</text>
      </view>
      <view class="sqr-badge">房间 {{ roomId }}</view>
    </view>

    <view class="sqr-meta">
      <text class="sqr-meta__label">手机扫码直接进房，不用输房间号</text>
      <text class="sqr-copy" @click="copyLink">复制链接</text>
    </view>

    <text class="sqr-link">{{ shareLink || '正在获取地址…' }}</text>

    <view class="sqr-code">
      <image v-if="qrDataUrl" class="sqr-img" :src="qrDataUrl" mode="widthFix" />
      <view v-else class="sqr-ph"><text>{{ qrError ? '二维码生成失败，请用「复制链接」' : '二维码生成中…' }}</text></view>
    </view>

    <view v-if="tunnelOffline" class="sqr-warn">公网地址暂时连不通，已切到局域网（手机需连同一个 Wi-Fi）；网络恢复后会自动切回公网码</view>
    <view v-else-if="bases.length > 1" class="sqr-hint">手机要和电脑连同一个 Wi-Fi；扫不开就点「换个地址」再试</view>
    <view v-else class="sqr-hint">手机要和电脑连同一个 Wi-Fi；扫不开多为电脑防火墙拦了本服务</view>

    <view v-if="bases.length > 1" class="sqr-switch" @click="cycleHost">
      {{ tunnelOn ? '换个地址' : '手机连不上？换一个地址' }}（{{ index + 1 }}/{{ bases.length }}<text v-if="bases[index] && bases[index].name"> · {{ bases[index].name }}</text>）
    </view>
  </view>
  <!-- #endif -->
</template>

<script>
import { resolveShareHosts, buildShareLink, probePublicUrl } from '../../utils/share-host.js'
import { ensureQRCode } from '../../utils/load-script.js'

export default {
  name: 'share-qr',
  props: {
    // 房间号：有值才显示二维码（扫了直接进这个房间）
    roomId: { type: String, default: '' },
    // 该功能页的路径，例：/pages/gomoku/gomoku
    pagePath: { type: String, required: true },
    title: { type: String, default: '扫码进房' },
    subtitle: { type: String, default: '手机扫一下就能进来，不用输房间号' }
  },
  data() {
    return {
      bases: [],
      index: 0,
      tunnelOn: false,
      shareLink: '',
      qrDataUrl: '',
      qrError: false,
      tunnelOffline: false,
      retry: 0,
      retryTimer: null,
      probeTimer: null
    }
  },
  watch: {
    roomId() {
      this.retry = 0
      this.qrDataUrl = ''
      this.qrError = false
      this.tunnelOffline = false
      this.refresh()
    }
  },
  mounted() {
    this.refresh()
  },
  beforeUnmount() {
    clearTimeout(this.retryTimer)
    clearTimeout(this.probeTimer)
    this.retryTimer = null
    this.probeTimer = null
  },
  methods: {
    async refresh() {
      // #ifdef H5
      if (!this.roomId) return
      try {
        const { bases, tunnelOn } = await resolveShareHosts()
        if (!bases || !bases.length) return
        this.bases = bases
        this.index = 0
        this.tunnelOn = tunnelOn
        this.applyBase()
        // 隧道进程起来了不等于地址真能访问（DNS/线路抽风时 cloudflared 还活着但连不上），
        // 先出公网码，再后台验一次：真打不开就换成局域网地址，别让好友扫到一个死链
        if (tunnelOn) this.verifyPublic()
        // 隧道可能比页面晚起来：先出局域网码，等公网地址就绪再自动换成公网码
        if (!tunnelOn && this.retry < 3) {
          this.retry += 1
          clearTimeout(this.retryTimer)
          this.retryTimer = setTimeout(() => this.refresh(), 8000)
        }
      } catch (e) {
        console.warn('分享地址解析失败，仍使用当前地址', e)
      }
      // #endif
    },

    // 公网地址实测：打不开就先退回局域网地址，避免二维码指向死链。
    // 网络是时好时坏（尤其 Cloudflare 免费隧道在国内），所以探测失败后
    // 会每隔一段时间自动重试，网络一恢复就把二维码自动切回公网码，
    // 用户不用手动刷新页面。
    async verifyPublic() {
      const pub = this.bases.find((b) => b.kind === 'public')
      if (!pub) return
      // 探测超时放宽到 8 秒：公网握手在慢网络下可能要好几个秒，4.5 秒会误判
      const ok = await probePublicUrl(pub.base, 8000)
      // 探测期间列表可能已经变了（重新解析 / 手动换地址），重新确认
      const p = this.bases.find((b) => b.kind === 'public')
      if (!p) return

      if (ok) {
        // 公网可用：把它提到最前，恢复绿条
        const idx = this.bases.indexOf(p)
        if (idx > 0) {
          this.bases.splice(idx, 1)
          this.bases.unshift(p)
        }
        this.tunnelOn = true
        this.tunnelOffline = false
        this.index = 0
        this.applyBase()
        return
      }

      // 公网连不通：把公网项挪到最后，二维码改用局域网地址
      if (this.bases[0] && this.bases[0].kind === 'public') {
        this.bases.push(this.bases.shift())
      }
      this.tunnelOn = false
      this.tunnelOffline = true
      this.index = 0
      this.applyBase()

      // 网络可能只是暂时抽风，20 秒后再探一次，通了就自动切回公网码
      clearTimeout(this.probeTimer)
      this.probeTimer = setTimeout(() => this.verifyPublic(), 20000)
    },

    applyBase() {
      const current = this.bases[this.index]
      this.shareLink = buildShareLink(current ? current.base : '', this.pagePath, this.roomId)
      this.makeQr()
    },

    cycleHost() {
      if (this.bases.length < 2) return
      this.index = (this.index + 1) % this.bases.length
      this.applyBase()
    },

    makeQr() {
      // #ifdef H5
      const link = this.shareLink
      if (!link) return
      // qrcode 库按需加载（23KB，只在需要出碼的页面下载一次）
      ensureQRCode()
        .then(() => {
          const lib = typeof window !== 'undefined' ? window.QRCode : null
          if (!lib || typeof lib.toDataURL !== 'function') {
            this.qrError = true
            return
          }
          // 下载期间分享地址可能已经切换，用发起时的链接，避免码和链接对不上
          lib.toDataURL(link, { width: 360, margin: 1 }, (err, url) => {
            if (err) {
              console.error('二维码生成失败', err)
              this.qrError = true
              return
            }
            this.qrError = false
            this.qrDataUrl = url
          })
        })
        .catch(() => {
          this.qrError = true
          console.warn('qrcode 库加载失败，二维码不可用，可改用「复制链接」')
        })
      // #endif
    },

    copyLink() {
      if (!this.shareLink) return
      // #ifdef H5
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(this.shareLink)
          .then(() => uni.showToast({ title: '链接已复制', icon: 'none' }))
          .catch(() => uni.showToast({ title: '复制失败，请长按链接手动复制', icon: 'none' }))
        return
      }
      // #endif
      uni.setClipboardData({
        data: this.shareLink,
        success: () => uni.showToast({ title: '链接已复制', icon: 'none' })
      })
    }
  }
}
</script>

<style scoped>
.share-qr {
  /* 父级若是 align-items:center 的 flex 容器，子项会按 max-content 撑宽，
     这里强制按可用宽度排，避免链接文字把卡片顶出屏幕 */
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  margin-top: 18px;
  padding: 16px;
  border-radius: 18px;
  background: #ffffff;
  border: 1px solid rgba(16, 122, 86, 0.12);
  box-shadow: 0 16px 34px -26px rgba(13, 84, 60, 0.6);
}

.sqr-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
}

.sqr-head__text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.sqr-title {
  display: block;
  font-size: 15px;
  font-weight: 700;
  color: #14342a;
  letter-spacing: 0.5px;
}

.sqr-sub {
  display: block;
  margin-top: 4px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #6b8a7c;
}

.sqr-badge {
  flex: 0 0 auto;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 1px;
  color: #0b7a4c;
  background: #e8f7ef;
  border: 1px solid rgba(16, 157, 99, 0.24);
  white-space: nowrap;
}

.sqr-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}

.sqr-meta__label {
  font-size: 11.5px;
  color: #6b8a7c;
  min-width: 0;
}

.sqr-copy {
  flex: 0 0 auto;
  font-size: 11.5px;
  font-weight: 600;
  color: #0b7a4c;
  padding: 5px 12px;
  border-radius: 999px;
  background: #e8f7ef;
  border: 1px solid rgba(16, 157, 99, 0.26);
  cursor: pointer;
}

.sqr-copy:active {
  transform: scale(0.97);
}

.sqr-link {
  /* uni-app 的 <text> 编译成 inline 的 uni-text，必须转 block 才能单行省略 */
  display: block;
  max-width: 100%;
  margin-top: 8px;
  padding: 9px 11px;
  font-size: 11px;
  line-height: 1.6;
  color: #5c7c6d;
  background: #f7fcf9;
  border: 1px solid rgba(16, 122, 86, 0.12);
  border-radius: 10px;
  word-break: break-all;
  cursor: pointer;
}

.sqr-code {
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
}

.sqr-img {
  width: 168px;
  height: 168px;
  display: block;
  /* 二维码必须留白底，四周留够静区才好扫 */
  background: #fff;
  padding: 10px;
  border-radius: 14px;
  border: 1px solid rgba(16, 122, 86, 0.12);
  box-sizing: content-box;
  box-shadow: 0 12px 28px -18px rgba(13, 84, 60, 0.6);
}

.sqr-ph {
  width: 168px;
  height: 168px;
  border-radius: 14px;
  background: #f7fcf9;
  border: 1px dashed rgba(16, 122, 86, 0.22);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  color: #8aa89b;
  text-align: center;
  padding: 0 14px;
  box-sizing: border-box;
}

.sqr-pub {
  display: block;
  margin-top: 12px;
  padding: 7px 10px;
  border-radius: 9px;
  font-size: 11.5px;
  line-height: 1.5;
  text-align: center;
  color: #0b7a4c;
  background: #e8f7ef;
  border: 1px solid rgba(16, 157, 99, 0.24);
}

.sqr-hint {
  display: block;
  margin-top: 10px;
  font-size: 11px;
  line-height: 1.5;
  color: #8aa89b;
  text-align: center;
}

.sqr-warn {
  display: block;
  margin-top: 10px;
  padding: 7px 10px;
  border-radius: 9px;
  font-size: 11.5px;
  line-height: 1.5;
  text-align: center;
  color: #8a5a12;
  background: #fff6e5;
  border: 1px solid rgba(214, 158, 46, 0.3);
}

.sqr-switch {
  margin-top: 8px;
  text-align: center;
  font-size: 11.5px;
  color: #0b7a4c;
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: rgba(16, 157, 99, 0.35);
  cursor: pointer;
}

.sqr-switch:active {
  color: #0f9d63;
}

@media (max-width: 360px) {
  .sqr-img,
  .sqr-ph {
    width: 148px;
    height: 148px;
  }
}

/* ===== 深海覆盖 ===== */
.share-qr {
  background: rgba(11, 23, 48, 0.78);
  border-color: var(--c-line);
  box-shadow: 0 20px 44px -34px rgba(0, 0, 0, 0.9);
}
.sqr-title { color: var(--c-text); }
.sqr-sub { color: var(--c-text-3); }
.sqr-badge {
  background: rgba(77, 107, 254, 0.16);
  border-color: rgba(110, 231, 255, 0.3);
  color: var(--c-primary-soft);
}
.sqr-meta__label { color: var(--c-text-3); }
.sqr-copy {
  background: rgba(77, 107, 254, 0.16);
  border-color: rgba(110, 231, 255, 0.3);
  color: var(--c-primary-soft);
}
.sqr-link {
  background: rgba(184, 198, 255, 0.05);
  border-color: rgba(184, 198, 255, 0.14);
  color: var(--c-text-3);
}
.sqr-img { border-color: rgba(184, 198, 255, 0.2); box-shadow: 0 10px 24px -18px rgba(0, 0, 0, 0.9); }
.sqr-ph {
  background: rgba(184, 198, 255, 0.05);
  border-color: rgba(184, 198, 255, 0.18);
  color: var(--c-text-3);
}
.sqr-pub {
  background: rgba(77, 107, 254, 0.14);
  border-color: rgba(110, 231, 255, 0.28);
  color: var(--c-primary-soft);
}
.sqr-hint { color: var(--c-text-3); }
.sqr-warn {
  background: rgba(214, 158, 46, 0.14);
  border-color: rgba(230, 178, 77, 0.32);
  color: #f2c265;
}
.sqr-switch { color: var(--c-primary-soft); }
</style>
