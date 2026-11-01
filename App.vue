<script>
import { initAnnouncement } from './utils/announcement.js'

export default {
  onLaunch() {
    console.log('星梦小筑 App Launch')
    // 全站公告：首屏拉取 + Socket 实时推送 + 轮询兜底
    initAnnouncement()
  }
}
</script>

<style>
/* ============================================================
   全局主题 · 深海（Abyssal）
   底色 #04070f / 面板 #0b1730 / 主光 #4d6bfe / 冷光 #6ee7ff
   文字 #e6ecff / 次级 #c3d0ff / 弱 #8fa3d9 / 线 rgba(184,198,255,.16)
   手机端不启用 backdrop-filter，桌面端才开玻璃。
   ============================================================ */
:root {
  --c-bg: #04070f;
  --c-bg-2: #0b1730;
  --c-surface: #0d1a33;
  --c-surface-2: #101f3c;
  --c-primary: #4d6bfe;
  --c-primary-soft: #6ee7ff;
  --c-primary-deep: #3b55e0;
  --c-mint: rgba(110, 231, 255, 0.08);
  --c-text: #e6ecff;
  --c-text-2: #c3d0ff;
  --c-text-3: #8fa3d9;
  --c-line: rgba(184, 198, 255, 0.16);
  --c-danger: #ff6b8a;
  --font-mono: "JetBrains Mono", Consolas, "Cascadia Code", monospace;
  --sh-card: 0 24px 60px -36px rgba(0, 0, 0, 0.9), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

html,
body {
  background-color: #04070f;
  min-height: 100%;
  overscroll-behavior-y: none;
}

page,
uni-page,
uni-page-wrapper,
uni-page-body,
uni-app,
#app {
  background-color: #0b1730 !important;
}

page {
  color: #e6ecff;
  font-size: 14px;
  -webkit-font-smoothing: antialiased;
}

/* 顶部导航：深色半透明，手机端纯色避免每帧模糊 */
/* #ifdef H5 */
uni-page-head .uni-page-head {
  background: rgba(6, 9, 26, 0.86) !important;
  border-bottom: 1px solid rgba(184, 198, 255, 0.14);
  box-shadow: 0 10px 30px -24px rgba(0, 0, 0, 0.9);
}

uni-page-head .uni-page-head .uni-page-head__title {
  color: #e6ecff !important;
  font-weight: 600;
}

@media (min-width: 900px) {
  uni-page-head .uni-page-head {
    background: rgba(6, 9, 26, 0.62) !important;
    backdrop-filter: blur(18px) saturate(120%);
    -webkit-backdrop-filter: blur(18px) saturate(120%);
  }
}
/* #endif */

.container {
  min-height: 100vh;
  padding: 24px 20px;
  box-sizing: border-box;
}

/* #ifdef H5 */
.container {
  min-height: calc(100vh - var(--window-top, 44px));
}
/* #endif */

.btn-primary {
  background: linear-gradient(135deg, #6d8bff 0%, #4d6bfe 100%);
  color: #fff;
  border-radius: 12px;
  padding: 12px 24px;
  font-size: 16px;
  font-weight: 600;
  border: none;
  cursor: pointer;
  box-shadow: 0 14px 30px -18px rgba(77, 107, 254, 0.85);
}

.btn-primary[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}

.card {
  background: rgba(13, 26, 51, 0.78);
  border: 1px solid rgba(184, 198, 255, 0.14);
  border-radius: 18px;
  padding: 20px;
  margin-bottom: 16px;
  color: #e6ecff;
  box-shadow: 0 22px 50px -34px rgba(0, 0, 0, 0.95), inset 0 1px 0 rgba(255, 255, 255, 0.05);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

@media (min-width: 900px) {
  .card {
    background: rgba(13, 26, 51, 0.66);
    backdrop-filter: blur(14px) saturate(120%);
    -webkit-backdrop-filter: blur(14px) saturate(120%);
  }
}

.input-field {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid rgba(184, 198, 255, 0.18);
  border-radius: 12px;
  padding: 10px 12px;
  font-size: 14px;
  color: #e6ecff;
  background: #0a1428;
  margin-bottom: 12px;
  position: relative;
  z-index: 1;
  pointer-events: auto;
  -webkit-user-select: text;
  user-select: text;
  -webkit-touch-callout: default;
}

.input-field input::placeholder,
.input-field .uni-input-placeholder {
  color: #7f93c4 !important;
  opacity: 1 !important;
}

.input-field.room-input {
  height: 52px;
  line-height: 52px;
  padding: 0 16px;
  font-size: 17px;
  color: #e6ecff;
}

/* ============================================================
   大厅：单列窄栏 + 深色细线卡
   ============================================================ */
.gl-lobby {
  position: relative;
  display: block;
  width: 100%;
  box-sizing: border-box;
  padding: 34px 16px 44px;
}

.gl-lobby--flush {
  padding: 10px 16px 28px;
}

.gl-orbs {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}

.gl-orbs::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background-image:
    linear-gradient(rgba(184, 198, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(184, 198, 255, 0.05) 1px, transparent 1px);
  background-size: 34px 34px;
  opacity: 0.7;
  -webkit-mask-image: radial-gradient(78% 62% at 50% 40%, rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0.35) 58%, rgba(0, 0, 0, 0) 100%);
  mask-image: radial-gradient(78% 62% at 50% 40%, rgba(0, 0, 0, 0.9) 0%, rgba(0, 0, 0, 0.35) 58%, rgba(0, 0, 0, 0) 100%);
}

.gl-orb {
  position: absolute;
  border-radius: 50%;
  opacity: 0.9;
}

.orb-a {
  top: 4%;
  left: -20%;
  width: 64vw;
  max-width: 350px;
  height: 64vw;
  max-height: 350px;
  background: radial-gradient(circle at 50% 50%, rgba(77, 107, 254, 0.26) 0%, rgba(77, 107, 254, 0.09) 44%, rgba(77, 107, 254, 0) 72%);
}

.orb-b {
  top: 40%;
  right: -22%;
  width: 58vw;
  max-width: 320px;
  height: 58vw;
  max-height: 320px;
  background: radial-gradient(circle at 50% 50%, rgba(124, 77, 255, 0.2) 0%, rgba(124, 77, 255, 0.07) 46%, rgba(124, 77, 255, 0) 74%);
}

.orb-c {
  bottom: 0;
  left: 20%;
  width: 54vw;
  max-width: 310px;
  height: 54vw;
  max-height: 310px;
  background: radial-gradient(circle at 50% 50%, rgba(110, 231, 255, 0.14) 0%, rgba(110, 231, 255, 0.05) 48%, rgba(110, 231, 255, 0) 76%);
}

.gl-col {
  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  max-width: 452px;
  margin: 0 auto;
}

.gl-card {
  position: relative;
  display: block;
  box-sizing: border-box;
  padding: 18px 18px 16px;
  margin-bottom: 14px;
  border-radius: 18px;
  color: #e6ecff;
  background: rgba(11, 23, 48, 0.78);
  border: 1px solid rgba(184, 198, 255, 0.15);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.05),
    0 2px 4px -2px rgba(0, 0, 0, 0.4),
    0 22px 46px -30px rgba(0, 0, 0, 0.9);
  animation: gl-rise 0.52s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}

@media (min-width: 900px) {
  .gl-card {
    background: rgba(11, 23, 48, 0.62);
    backdrop-filter: blur(12px) saturate(120%);
    -webkit-backdrop-filter: blur(12px) saturate(120%);
  }
}

/* 顶部 2px 冷光线，替代原来的绿色渐变 */
.gl-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 18px;
  right: 18px;
  height: 2px;
  border-radius: 0 0 2px 2px;
  background: linear-gradient(90deg, rgba(110, 231, 255, 0.75) 0%, rgba(77, 107, 254, 0.35) 45%, rgba(77, 107, 254, 0) 100%);
  pointer-events: none;
}

.gl-col > .gl-card:nth-child(1) { animation-delay: 0.04s; }
.gl-col > .gl-card:nth-child(2) { animation-delay: 0.12s; }
.gl-col > .gl-card:nth-child(3) { animation-delay: 0.2s; }

.gl-kicker {
  display: block;
  font-family: var(--font-mono);
  font-size: 10.5px;
  line-height: 1.4;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: #6ee7ff;
  margin-bottom: 6px;
}

.gl-card__title {
  display: block;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.4;
  color: #e6ecff;
  margin-bottom: 14px;
}

.gl-note {
  display: block;
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.65;
  color: #8fa3d9;
}

.gl-foot {
  position: relative;
  z-index: 1;
  display: block;
  width: 100%;
  max-width: 452px;
  margin: 4px auto 0;
  padding: 0 6px;
  box-sizing: border-box;
  font-size: 11.5px;
  line-height: 1.8;
  color: #7f93c4;
  text-align: center;
}

.gl-btn {
  display: block;
  width: 100%;
  box-sizing: border-box;
  height: 46px;
  line-height: 46px;
  padding: 0 16px;
  margin: 0 0 2px;
  border: none;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  color: #ffffff;
  text-align: center;
  background: linear-gradient(135deg, #6d8bff 0%, #4d6bfe 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.28),
    0 14px 28px -18px rgba(77, 107, 254, 0.85);
  transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease;
}

.gl-btn::after {
  border: none;
}

.gl-btn:active {
  transform: translateY(1px) scale(0.994);
  filter: brightness(1.06);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.2),
    0 6px 14px -10px rgba(77, 107, 254, 0.8);
}

.gl-btn[disabled] {
  opacity: 0.5;
  filter: saturate(0.65);
}

.gl-input {
  display: block;
  width: 100%;
  box-sizing: border-box;
  height: 46px;
  line-height: 46px;
  padding: 0 14px;
  margin-bottom: 12px;
  border: 1px solid rgba(184, 198, 255, 0.18);
  border-radius: 12px;
  font-size: 16px;
  color: #e6ecff;
  background: #0a1428;
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.45);
}

.gl-input ::placeholder,
.gl-input input::placeholder,
.gl-input .uni-input-placeholder,
.gl-input .uni-input-input::placeholder {
  color: #7f93c4 !important;
  opacity: 1 !important;
}

.gl-input input,
.gl-input .uni-input-input {
  color: #e6ecff !important;
  background: transparent !important;
}

@supports not ((backdrop-filter: blur(2px)) or (-webkit-backdrop-filter: blur(2px))) {
  .gl-card {
    background: #0b1730;
  }
}

@keyframes gl-rise {
  from { opacity: 0; transform: translateY(16px) scale(0.985); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes gl-orb-a {
  from { transform: translate3d(0, 0, 0) scale(1); }
  to { transform: translate3d(16vw, 12vh, 0) scale(1.16); }
}

@keyframes gl-orb-b {
  from { transform: translate3d(0, 0, 0) scale(1.05); }
  to { transform: translate3d(-14vw, -10vh, 0) scale(1.2); }
}

@keyframes gl-orb-c {
  from { transform: translate3d(0, 0, 0) scale(1); }
  to { transform: translate3d(10vw, -8vh, 0) scale(1.14); }
}

@media (min-width: 900px) {
  .gl-orb { will-change: transform; }
  .orb-a { animation: gl-orb-a 26s ease-in-out infinite alternate; }
  .orb-b { animation: gl-orb-b 32s ease-in-out infinite alternate; }
  .orb-c { animation: gl-orb-c 29s ease-in-out infinite alternate; }
}

@media (max-height: 620px) {
  .gl-lobby { padding-top: 14px; padding-bottom: 24px; }
  .gl-card { padding: 14px 16px 12px; margin-bottom: 12px; }
  .gl-card__title { margin-bottom: 10px; }
}

@media (prefers-reduced-motion: reduce) {
  .gl-card, .gl-orb { animation: none; }
}

uni-input,
.uni-input-wrapper {
  display: block;
  width: 100%;
}

uni-input .uni-input-input,
.uni-input-wrapper input,
.input-field input,
.input-field uni-input {
  pointer-events: auto !important;
  user-select: text !important;
  -webkit-user-select: text !important;
  cursor: text !important;
}

/* ============================================================
   大厅 · 编辑式压平
   把 gl-card 从「卡片」变成「细线分节」，与首页索引同一套语言
   ============================================================ */
.gl-lobby {
  max-width: 1080px;
  margin: 0 auto;
  padding: 36px 0 54px;
}

.gl-lobby--flush {
  padding-top: 18px;
}

.gl-lobby .gl-orbs {
  display: none;
}

.gl-lobby .hero {
  text-align: left !important;
  padding: 8px 0 30px;
}

.gl-lobby .hero .title {
  font-size: clamp(2.4rem, 5vw, 4rem) !important;
  font-weight: 300 !important;
  letter-spacing: 0.08em !important;
  line-height: 1.08 !important;
  color: var(--c-text) !important;
}

.gl-lobby .hero .subtitle {
  margin-top: 14px;
  font-size: 13px;
  line-height: 1.9;
  color: var(--c-text-2) !important;
  letter-spacing: 0.02em;
}

.gl-lobby .backend-online,
.gl-lobby .backend-offline {
  display: flex;
  align-items: center;
  justify-content: flex-start !important;
  width: auto !important;
  max-width: none !important;
  margin: 0 auto 8px 0 !important;
  padding: 0;
  border: 0 !important;
  border-radius: 0 !important;
  background: transparent !important;
  padding: 0 !important;
  max-width: none !important;
  width: auto !important;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.12em;
  line-height: 1.8;
  text-align: left !important;
}

.gl-lobby .backend-online::before,
.gl-lobby .backend-offline::before {
  content: '';
  display: block;
  width: 5px;
  height: 5px;
  margin-right: 8px;
  border-radius: 50%;
  flex: 0 0 5px;
}

.gl-lobby .backend-online { color: #9fe8ff !important; }
.gl-lobby .backend-online::before {
  background: var(--c-primary-soft);
  box-shadow: 0 0 8px rgba(110, 231, 255, 0.8);
}
.gl-lobby .backend-offline { color: #ffb3c1 !important; }
.gl-lobby .backend-offline::before { background: #ff6b8a; }

.gl-lobby .gl-col {
  max-width: none;
}

.gl-lobby .gl-card {
  background: transparent;
  border: 0;
  border-top: 1px solid rgba(184, 198, 255, 0.16);
  border-radius: 0;
  box-shadow: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  padding: 24px 0 28px;
  margin: 0;
  animation: gl-rise 0.42s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}

.gl-lobby .gl-card:last-child {
  border-bottom: 1px solid rgba(184, 198, 255, 0.16);
}

.gl-lobby .gl-card::before {
  display: none;
}

.gl-lobby .gl-kicker {
  font-size: 9.5px;
  letter-spacing: 0.2em;
  color: var(--c-primary-soft);
  margin-bottom: 8px;
}

.gl-lobby .gl-card__title {
  font-size: clamp(1.35rem, 2.2vw, 1.8rem);
  font-weight: 300;
  letter-spacing: 0.04em;
  line-height: 1.3;
  color: var(--c-text);
  margin-bottom: 16px;
}

.gl-lobby .gl-input {
  width: 100%;
  height: 46px;
  line-height: 46px;
  padding: 0;
  margin-bottom: 10px;
  border: 0;
  border-bottom: 1px solid rgba(184, 198, 255, 0.22);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  font-size: 15px;
  color: var(--c-text);
}

.gl-lobby .gl-input:focus {
  border-bottom-color: var(--c-primary-soft);
}

.gl-lobby .gl-btn {
  display: inline-block;
  width: auto;
  height: auto;
  line-height: 1.4;
  margin: 6px 0 0;
  padding: 8px 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  color: var(--c-primary-soft);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-align: left;
  text-decoration: underline;
  text-underline-offset: 4px;
  text-decoration-color: rgba(110, 231, 255, 0.35);
}

.gl-lobby .gl-btn:active {
  transform: none;
  filter: none;
  opacity: 0.65;
  box-shadow: none;
}

.gl-lobby .gl-btn[disabled] {
  color: var(--c-text-3);
  opacity: 0.55;
}

.gl-lobby .gl-note {
  margin-top: 12px;
  max-width: 46rem;
  font-size: 11.5px;
  line-height: 1.8;
  color: var(--c-text-3);
}

.gl-lobby .gl-foot {
  max-width: none;
  margin-top: 18px;
  padding: 0;
  text-align: left;
  font-size: 9px;
  letter-spacing: 0.1em;
  color: rgba(143, 163, 217, 0.7);
}

.gl-lobby .error {
  background: rgba(255, 107, 138, 0.08);
  border: 1px solid rgba(255, 107, 138, 0.24);
  color: #ffb3c1;
}

@media (max-width: 900px) {
  .gl-lobby {
    padding: 22px 0 40px;
  }

  .gl-lobby .hero {
    padding: 4px 0 22px;
  }

  .gl-lobby .hero .title {
    font-size: clamp(2.1rem, 10vw, 3rem) !important;
  }

  .gl-lobby .gl-card {
    padding: 20px 0 22px;
  }

  .gl-lobby .gl-card__title {
    font-size: 1.22rem;
    margin-bottom: 14px;
  }
}

/* 主操作：小圆角按钮（保留编辑式排版，但别太隐形） */
.gl-lobby .gl-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: auto;
  height: auto;
  min-height: 36px;
  margin-top: 10px;
  padding: 8px 16px;
  border: 1px solid rgba(110, 231, 255, 0.3);
  border-radius: 10px;
  background: rgba(77, 107, 254, 0.14);
  box-shadow: none;
  color: var(--c-text);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-decoration: none;
  text-underline-offset: 0;
}

.gl-lobby .gl-btn:active {
  transform: scale(0.98);
  background: rgba(77, 107, 254, 0.24);
  opacity: 1;
}

.gl-lobby .gl-btn[disabled] {
  color: var(--c-text-3);
  border-color: rgba(184, 198, 255, 0.14);
  background: rgba(184, 198, 255, 0.05);
  opacity: 0.55;
}
</style>
