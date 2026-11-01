<template>
  <view class="home-page">
    <aurora-bg />
    <view class="home-beam"></view>
    <ann-banner />

    <view class="home-hud">
      <view class="brand">
        <view class="brand-mark"><text class="brand-spark">✦</text></view>
        <view class="brand-text">
          <text class="brand-name">星梦之屋</text>
          <text class="brand-sub">STARRY HOME</text>
        </view>
      </view>
      <view class="hud-meta">
        <text class="hud-dot"></text>
        <text>MENU · 04</text>
      </view>
    </view>

    <view class="home-stage">
      <view class="home-lead">
        <text class="kicker">STARRY HOME · 2026</text>
        <text class="display">星梦之屋</text>
        <text class="tagline">把异地，变成同一块屏幕。<br />一起看电影、听歌、下一盘。</text>
        <view class="scan-link" @click="openScan">
          <view class="scan-mark"></view>
          <text>扫码进房</text>
          <text class="scan-arrow">↗</text>
        </view>
      </view>

      <view class="home-index">
        <view class="entry" @click="goVideo">
          <text class="entry-num">01</text>
          <view class="entry-main">
            <text class="entry-name">星梦影院</text>
            <text class="entry-desc">异地同步 · 免费看片</text>
          </view>
          <text class="entry-arrow">→</text>
        </view>

        <view class="entry" @click="goDoudizhu">
          <text class="entry-num">02</text>
          <view class="entry-main">
            <text class="entry-name">斗地主</text>
            <text class="entry-desc">AI 陪玩 · 在线联机</text>
          </view>
          <text class="entry-arrow">→</text>
        </view>

        <view class="entry" @click="goMusic">
          <text class="entry-num">03</text>
          <view class="entry-main">
            <text class="entry-name">星梦音乐厅</text>
            <text class="entry-desc">多人同步听歌</text>
          </view>
          <text class="entry-arrow">→</text>
        </view>

        <view class="entry" @click="goGomoku">
          <text class="entry-num">04</text>
          <view class="entry-main">
            <text class="entry-name">五子棋</text>
            <text class="entry-desc">可 AI 同玩 · 精彩博弈</text>
          </view>
          <text class="entry-arrow">→</text>
        </view>
      </view>
    </view>

    <view class="home-foot">
      <text>影院 / 音乐厅 / 棋牌 / 6 位房间号</text>
      <text>SCROLL OR TAP</text>
    </view>

    <qr-scanner :visible="scanVisible" @close="scanVisible = false" @result="onScanResult" />
  </view>
</template>



<script>
import { goScanTarget } from '../../utils/qr-link.js'

export default {
  data() {
    return {
      scanVisible: false,
      // 底部滚动带里展示的品牌字标
      // 换成真实客户 LOGO：把图片丢进 static/logos/，这一项写成 { image: '/static/logos/xxx.png', name: '客户名', sub: 'CLIENT' } 即可
      brands: [
        // 用等宽字母标代替 emoji，和首页编号体系一致；换真实 LOGO 时用 { image, name, sub }
        { mark: 'SD', name: '星梦之屋', sub: 'STARRY HOME' },
        { mark: 'CI', name: '星梦影院', sub: 'CINEMA' },
        { mark: 'LL', name: '欢乐斗地主', sub: 'LANDLORD' },
        { mark: 'MU', name: '星梦音乐厅', sub: 'MUSIC HALL' },
        { mark: 'GK', name: '五子棋', sub: 'GOMOKU' },
        { mark: 'ST', name: '星河放映室', sub: 'STUDIO' }
      ],
      // 一份内容的重复次数；太窄时自动增加，保证滚动时不露白
      repeat: 1,
      // 按内容长度换算的滚动时长，保持恒定的视觉速度
      duration: '30s',
      // 滚动带只在「露在屏幕里 + 手指没有在滑动」时才跑
      marqueeVisible: false,
      pageScrolling: false
    }
  },

  computed: {
    marqueeRunning() {
      return this.marqueeVisible && !this.pageScrolling
    },

    // 一份完整内容（宽度要 >= 容器宽，否则滚到后半段右边会空）
    unitBrands() {
      const list = []
      for (let i = 0; i < this.repeat; i += 1) list.push(...this.brands)
      return list
    },

    // 复制一份接在队尾，轨道位移 50% 时正好接上，看起来是无限循环
    marqueeItems() {
      return this.unitBrands.concat(this.unitBrands)
    }
  },

  mounted() {
    this.$nextTick(() => this.fitMarquee())
    if (typeof window !== 'undefined') {
      this.onResize = () => {
        if (this.resizeTimer) clearTimeout(this.resizeTimer)
        this.resizeTimer = setTimeout(() => this.fitMarquee(), 220)
      }
      window.addEventListener('resize', this.onResize)

      // 手指滑动期间暂停品牌带：位移动画本身要一直合成，滚动时叠在一起最容易掉帧
      this.onScroll = () => {
        if (!this.pageScrolling) this.pageScrolling = true
        if (this.scrollIdleTimer) clearTimeout(this.scrollIdleTimer)
        this.scrollIdleTimer = setTimeout(() => {
          this.pageScrolling = false
        }, 180)
      }
      // 用捕获阶段监听 document：H5 端真正滚动的是页面内的滚动容器，
      // 挂在 window 上在部分内核里收不到事件
      document.addEventListener('scroll', this.onScroll, { passive: true, capture: true })

      // 滚出屏幕就彻底停掉，别让看不见的东西继续抢 GPU
      if (typeof IntersectionObserver === 'function') {
        this.$nextTick(() => {
          const box = document.querySelector('.marquee')
          if (!box) return
          this.marqueeIO = new IntersectionObserver((entries) => {
            this.marqueeVisible = !!(entries[0] && entries[0].isIntersecting)
          }, { rootMargin: '80px' })
          this.marqueeIO.observe(box)
        })
      } else {
        this.marqueeVisible = true
      }
    }
  },

  beforeUnmount() {
    if (typeof window !== 'undefined') {
      if (this.onResize) window.removeEventListener('resize', this.onResize)
      if (this.onScroll) document.removeEventListener('scroll', this.onScroll, true)
      if (this.resizeTimer) clearTimeout(this.resizeTimer)
      if (this.scrollIdleTimer) clearTimeout(this.scrollIdleTimer)
    }
    if (this.marqueeIO) {
      this.marqueeIO.disconnect()
      this.marqueeIO = null
    }
  },

  methods: {
    /** 量一下一份内容够不够铺满容器，不够就再重复一份（大屏才需要） */
    async fitMarquee() {
      if (typeof document === 'undefined') return
      const box = document.querySelector('.marquee')
      if (!box) return
      const need = box.clientWidth
      for (let i = 0; i < 5; i += 1) {
        await this.$nextTick()
        const track = document.querySelector('.marquee-track')
        if (!track) return
        // 轨道里是两份，除以 2 就是一份的宽度
        const unit = track.scrollWidth / 2
        if (unit >= need) {
          // 内容越长走越久，保证看起来是同一个速度（约 48px/s）
          this.duration = `${Math.max(14, Math.round(unit / 48))}s`
          return
        }
        this.repeat += 1
      }
    },

    openScan() {
      this.scanVisible = true
    },

    async onScanResult(parsed) {
      this.scanVisible = false
      try {
        await goScanTarget(parsed)
      } catch (e) {
        uni.showToast({ title: '这个房间可能已经散了', icon: 'none', duration: 2000 })
      }
    },

    goVideo() {
      uni.navigateTo({
        url: '/pages/index/index'
      })
    },

      goGomoku() {
        uni.navigateTo({
          url: '/pages/gomoku/gomoku'
        })
      },

      goDoudizhu() {
        uni.navigateTo({
          url: '/pages/doudizhu/doudizhu'
        })
      },


    goMusic() {
      uni.navigateTo({
        url: '/pages/music/music'
      })
    },

    comingSoon(name) {
      uni.showToast({
        title: `${name}开发中，敬请期待`,
        icon: 'none',
        duration: 2000
      })
    }
  }
}
</script>

<style scoped>
/* ============================================================
   首页 · 深海编辑式封面
   大标题 + 极细索引列表 + 大量留白；不用 Bentao 卡片。
   ============================================================ */
.home-page {
  position: relative;
  min-height: 100vh;
  min-height: 100svh;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: calc(env(safe-area-inset-top, 0px) + 26px) clamp(20px, 5vw, 80px) 20px;
  color: var(--c-text);
  background: transparent;
}

/* ---------- HUD ---------- */
.home-hud {
  position: relative;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding-bottom: 18px;
  border-bottom: 1px solid rgba(184, 198, 255, 0.1);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-mark {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(110, 231, 255, 0.32);
  border-radius: 50%;
}

.brand-spark {
  display: block;
  font-size: 13px;
  line-height: 1;
  color: var(--c-primary-soft);
}

.brand-text {
  display: flex;
  flex-direction: column;
}

.brand-name {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.32em;
  line-height: 1.2;
  color: var(--c-text);
}

.brand-sub {
  display: block;
  margin-top: 4px;
  font-family: var(--font-mono);
  font-size: 7.5px;
  letter-spacing: 0.3em;
  line-height: 1;
  color: var(--c-text-3);
}

.hud-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: var(--c-text-3);
}

.hud-dot {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--c-primary-soft);
  box-shadow: 0 0 8px rgba(110, 231, 255, 0.8);
}

/* ---------- 主舞台 ---------- */
.home-stage {
  position: relative;
  z-index: 1;
  flex: 1;
  display: grid;
  grid-template-columns: minmax(0, 1.02fr) minmax(0, 0.98fr);
  gap: clamp(40px, 7vw, 120px);
  align-items: center;
  width: 100%;
  max-width: 1500px;
  margin: 0 auto;
  padding: 36px 0;
  box-sizing: border-box;
}

.home-lead {
  min-width: 0;
  max-width: 44rem;
}

.kicker {
  display: block;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.34em;
  line-height: 1;
  color: var(--c-primary-soft);
  text-transform: uppercase;
}

.display {
  display: block;
  margin-top: 22px;
  font-size: clamp(3.2rem, 8.6vw, 8.4rem);
  font-weight: 300;
  line-height: 1.02;
  letter-spacing: 0.1em;
  color: var(--c-text);
}

.tagline {
  display: block;
  margin-top: 26px;
  max-width: 30rem;
  font-size: clamp(0.9rem, 1.1vw, 1.02rem);
  font-weight: 300;
  line-height: 2;
  color: var(--c-text-2);
}

.scan-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-top: 34px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(110, 231, 255, 0.28);
  cursor: pointer;
}

.scan-link text {
  font-size: 12px;
  letter-spacing: 0.08em;
  color: var(--c-text);
}

.scan-mark {
  position: relative;
  width: 9px;
  height: 9px;
  border: 1px solid var(--c-primary-soft);
  border-radius: 2px;
}

.scan-mark::after {
  content: '';
  position: absolute;
  top: 2px;
  right: 2px;
  bottom: 2px;
  left: 2px;
  background: var(--c-primary-soft);
}

.scan-arrow {
  color: var(--c-text-3) !important;
}

.scan-link:active {
  opacity: 0.7;
}

/* ---------- 索引列表 ---------- */
.home-index {
  display: flex;
  flex-direction: column;
  border-top: 1px solid rgba(184, 198, 255, 0.16);
}

.entry {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 20px;
  gap: 16px;
  align-items: center;
  padding: 22px 4px;
  border-bottom: 1px solid rgba(184, 198, 255, 0.16);
  cursor: pointer;
  transition: background 0.25s ease, padding 0.25s ease;
  -webkit-tap-highlight-color: transparent;
}

.entry-num {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.1em;
  color: var(--c-text-3);
}

.entry-main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.entry-name {
  font-size: clamp(1.05rem, 1.5vw, 1.35rem);
  font-weight: 400;
  letter-spacing: 0.08em;
  line-height: 1.3;
  color: var(--c-text);
  transition: color 0.25s ease;
}

.entry-desc {
  display: block;
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  line-height: 1.4;
  color: var(--c-text-3);
}

.entry-arrow {
  font-family: var(--font-mono);
  font-size: 16px;
  line-height: 1;
  color: var(--c-text-3);
  transition: transform 0.25s ease, color 0.25s ease;
}

@media (hover: hover) {
  .entry:hover {
    padding-left: 10px;
    background: linear-gradient(90deg, rgba(110, 231, 255, 0.05), rgba(110, 231, 255, 0));
  }

  .entry:hover .entry-name {
    color: var(--c-primary-soft);
  }

  .entry:hover .entry-arrow {
    transform: translateX(4px);
    color: var(--c-primary-soft);
  }
}

.entry:active {
  background: rgba(110, 231, 255, 0.05);
}

/* ---------- 底栏 ---------- */
.home-foot {
  position: relative;
  z-index: 2;
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding-top: 18px;
  border-top: 1px solid rgba(184, 198, 255, 0.1);
  font-family: var(--font-mono);
  font-size: 8.5px;
  letter-spacing: 0.14em;
  line-height: 1.4;
  color: var(--c-text-3);
}

/* ---------- 手机 ---------- */
@media (max-width: 900px) {
  .home-page {
    padding: calc(env(safe-area-inset-top, 0px) + 18px) 20px 16px;
  }

  .home-hud {
    padding-bottom: 14px;
  }

  .home-stage {
    grid-template-columns: 1fr;
    gap: 26px;
    align-items: start;
    align-content: center;
    padding: 28px 0 8px;
  }

  .display {
    margin-top: 16px;
    font-size: clamp(3rem, 14vw, 4.6rem);
    letter-spacing: 0.08em;
  }

  .tagline {
    margin-top: 18px;
    font-size: 0.88rem;
    line-height: 1.9;
  }

  .scan-link {
    margin-top: 22px;
  }

  .home-index {
    margin-top: 4px;
  }

  .entry {
    grid-template-columns: 32px minmax(0, 1fr) 18px;
    gap: 10px;
    padding: 17px 2px;
  }

  .entry-name {
    font-size: 1.05rem;
  }

  .entry-desc {
    font-size: 8.5px;
  }

  .home-foot {
    padding-top: 14px;
    font-size: 8px;
    letter-spacing: 0.1em;
  }
}

@media (max-width: 360px) {
  .brand-name {
    font-size: 11px;
  }

  .hud-meta {
    font-size: 8px;
  }

  .entry-name {
    font-size: 1rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .entry,
  .entry-name,
  .entry-arrow {
    transition: none;
  }
}

@media (max-height: 700px) {
  .home-stage {
    padding: 18px 0 4px;
    gap: 22px;
  }

  .display {
    margin-top: 10px;
    font-size: clamp(2.7rem, 12vw, 3.6rem);
  }

  .tagline {
    margin-top: 12px;
    line-height: 1.75;
  }

  .scan-link {
    margin-top: 14px;
  }

  .entry {
    padding: 14px 2px;
  }

  .home-foot {
    padding-top: 10px;
  }
}

/* 基准页的签名元素：一束从顶部打下的冷光 */
.home-beam {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
}

.home-beam::before {
  content: '';
  position: absolute;
  top: -18%;
  left: 50%;
  width: 34vw;
  height: 118vh;
  transform: translateX(-50%) rotate(7deg);
  transform-origin: 50% 0;
  background: linear-gradient(180deg, rgba(77, 107, 254, 0.28) 0%, rgba(77, 107, 254, 0.06) 46%, rgba(77, 107, 254, 0) 72%);
  clip-path: polygon(43% 0, 57% 0, 100% 100%, 0 100%);
  opacity: 0.55;
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 20%, #000 80%, transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0%, #000 20%, #000 80%, transparent 100%);
}

.home-beam::after {
  content: '';
  position: absolute;
  top: -18%;
  left: 46%;
  width: 12vw;
  height: 110vh;
  transform: translateX(-50%) rotate(-4deg);
  transform-origin: 50% 0;
  background: linear-gradient(180deg, rgba(110, 231, 255, 0.18) 0%, rgba(110, 231, 255, 0) 64%);
  clip-path: polygon(46% 0, 54% 0, 100% 100%, 0 100%);
  opacity: 0.4;
  -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 20%, #000 80%, transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0%, #000 20%, #000 80%, transparent 100%);
}

.entry-name {
  font-weight: 300;
  font-size: clamp(1.1rem, 1.55vw, 1.45rem);
}

@media (max-width: 900px) {
  .home-beam {
    display: none;
  }
}
</style>
