<template>
  <view class="aurora-bg" aria-hidden="true">
    <view class="aurora-base"></view>
    <view class="aurora-curtain curtain-1"></view>
    <view class="aurora-curtain curtain-2"></view>
    <view class="aurora-curtain curtain-3"></view>
    <view class="aurora-blob blob-1"></view>
    <view class="aurora-blob blob-2"></view>
    <view class="aurora-blob blob-3"></view>
    <view class="aurora-blob blob-4"></view>
    <view class="aurora-veil"></view>
  </view>
</template>

<script>
export default {
  name: 'AuroraBg'
}
</script>

<style scoped>
/* ============================================================
   深海极光（Abyssal Aurora）
   底色 #04070f → 蓝紫中层 → 四团冷光斑
   手机端静止（大面积运动渐变会让滚动掉帧），宽屏才漂移；
   只做 transform / opacity，不用 filter。
   ============================================================ */
.aurora-bg {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
  background: #04070f;
  transform: translateZ(0);
  contain: paint;
}

/* ---------- 1. 底色 ---------- */
.aurora-base {
  position: absolute;
  top: -10%;
  right: -10%;
  bottom: -10%;
  left: -10%;
  background:
    radial-gradient(100% 70% at 50% -12%, rgba(18, 34, 74, 0.9) 0%, rgba(18, 34, 74, 0) 62%),
    radial-gradient(80% 62% at 88% 108%, rgba(26, 16, 53, 0.85) 0%, rgba(26, 16, 53, 0) 64%),
    linear-gradient(180deg, #04070f 0%, #060b18 52%, #04070f 100%);
}

/* ---------- 2. 光带 ---------- */
.aurora-curtain {
  position: absolute;
  left: -30%;
  width: 160%;
  opacity: 0.42;
  -webkit-mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 1) 24%, rgba(0, 0, 0, 1) 76%, rgba(0, 0, 0, 0) 100%);
  mask-image: linear-gradient(180deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 1) 24%, rgba(0, 0, 0, 1) 76%, rgba(0, 0, 0, 0) 100%);
}

.curtain-1 {
  top: 0%;
  height: 42%;
  background: linear-gradient(
    100deg,
    rgba(77, 107, 254, 0) 0%,
    rgba(77, 107, 254, 0.26) 16%,
    rgba(110, 231, 255, 0.16) 36%,
    rgba(124, 77, 255, 0.2) 58%,
    rgba(77, 107, 254, 0.08) 76%,
    rgba(77, 107, 254, 0) 94%
  );
  transform: translate3d(-6%, 0, 0) rotate(-10deg);
}

.curtain-2 {
  top: 18%;
  height: 50%;
  background: linear-gradient(
    96deg,
    rgba(110, 231, 255, 0) 0%,
    rgba(110, 231, 255, 0.14) 20%,
    rgba(77, 107, 254, 0.18) 44%,
    rgba(124, 77, 255, 0.16) 68%,
    rgba(110, 231, 255, 0) 92%
  );
  transform: translate3d(5%, 1%, 0) rotate(-11deg);
}

.curtain-3 {
  top: 46%;
  height: 46%;
  background: linear-gradient(
    104deg,
    rgba(124, 77, 255, 0) 0%,
    rgba(124, 77, 255, 0.2) 22%,
    rgba(77, 107, 254, 0.14) 50%,
    rgba(110, 231, 255, 0.1) 74%,
    rgba(124, 77, 255, 0) 96%
  );
  transform: translate3d(0, 2%, 0) rotate(-8deg);
}

/* ---------- 3. 弥散光斑 ---------- */
.aurora-blob {
  position: absolute;
  border-radius: 50%;
  opacity: 0.78;
}

.blob-1 {
  top: -28vw;
  left: -24vw;
  width: 80vw;
  height: 80vw;
  background: radial-gradient(circle at 50% 50%, rgba(77, 107, 254, 0.26) 0%, rgba(77, 107, 254, 0) 70%);
}

.blob-2 {
  top: -20vw;
  right: -24vw;
  width: 72vw;
  height: 72vw;
  background: radial-gradient(circle at 50% 50%, rgba(124, 77, 255, 0.2) 0%, rgba(124, 77, 255, 0) 70%);
}

.blob-3 {
  bottom: -34vw;
  left: -6vw;
  width: 84vw;
  height: 84vw;
  background: radial-gradient(circle at 50% 50%, rgba(27, 58, 122, 0.4) 0%, rgba(27, 58, 122, 0) 72%);
}

.blob-4 {
  right: -18vw;
  bottom: -26vw;
  width: 64vw;
  height: 64vw;
  background: radial-gradient(circle at 50% 50%, rgba(110, 231, 255, 0.1) 0%, rgba(110, 231, 255, 0) 72%);
}

/* ---------- 4. 中央提亮 + 四周压暗 ---------- */
.aurora-veil {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  background:
    radial-gradient(100% 70% at 50% 36%, rgba(77, 107, 254, 0.08) 0%, rgba(77, 107, 254, 0) 60%),
    radial-gradient(120% 120% at 50% 42%, rgba(4, 7, 15, 0) 42%, rgba(2, 4, 10, 0.62) 100%);
}

/* ============================================================
   宽屏才漂移；手机端静止
   ============================================================ */
@media (min-width: 900px) {
  .aurora-blob {
    opacity: 0.66;
    will-change: transform;
  }

  .aurora-curtain {
    opacity: 0.34;
    will-change: transform, opacity;
    transform: translate3d(0, 0, 0);
  }

  .aurora-base {
    animation: base-breathe 52s ease-in-out infinite alternate;
  }

  .curtain-1 { animation: curtain-drift-1 46s ease-in-out infinite alternate; }
  .curtain-2 { animation: curtain-drift-2 62s ease-in-out infinite alternate; }
  .curtain-3 { animation: curtain-drift-3 74s ease-in-out infinite alternate; }
  .blob-1 { animation: blob-drift-1 58s ease-in-out infinite alternate; }
  .blob-2 { animation: blob-drift-2 66s ease-in-out infinite alternate; }
  .blob-3 { animation: blob-drift-3 72s ease-in-out infinite alternate; }
  .blob-4 { animation: blob-drift-4 64s ease-in-out infinite alternate; }
}

@keyframes base-breathe {
  0% { transform: translate3d(0, 0, 0) scale(1); opacity: 0.94; }
  100% { transform: translate3d(0, -1.5%, 0) scale(1.04); opacity: 1; }
}

@keyframes curtain-drift-1 {
  0% { transform: translate3d(-9%, 0, 0) rotate(-13deg) scale(1.02); opacity: 0.24; }
  50% { opacity: 0.4; }
  100% { transform: translate3d(11%, -6%, 0) rotate(-7deg) scale(1.16); opacity: 0.3; }
}

@keyframes curtain-drift-2 {
  0% { transform: translate3d(10%, 2%, 0) rotate(-9deg) scale(1.1); opacity: 0.2; }
  50% { opacity: 0.36; }
  100% { transform: translate3d(-12%, -4%, 0) rotate(-16deg) scale(1.02); opacity: 0.26; }
}

@keyframes curtain-drift-3 {
  0% { transform: translate3d(-6%, 3%, 0) rotate(-11deg) scale(1.04); opacity: 0.18; }
  50% { opacity: 0.32; }
  100% { transform: translate3d(8%, -3%, 0) rotate(-5deg) scale(1.14); opacity: 0.24; }
}

@keyframes blob-drift-1 {
  0% { transform: translate3d(0, 0, 0) scale(1) rotate(0deg); }
  100% { transform: translate3d(12vw, 9vh, 0) scale(1.16) rotate(26deg); }
}

@keyframes blob-drift-2 {
  0% { transform: translate3d(0, 0, 0) scale(1.06) rotate(0deg); }
  100% { transform: translate3d(-11vw, 12vh, 0) scale(1.2) rotate(-22deg); }
}

@keyframes blob-drift-3 {
  0% { transform: translate3d(0, 0, 0) scale(1.08) rotate(0deg); }
  100% { transform: translate3d(9vw, -11vh, 0) scale(1.24) rotate(16deg); }
}

@keyframes blob-drift-4 {
  0% { transform: translate3d(0, 0, 0) scale(1) rotate(0deg); }
  100% { transform: translate3d(-12vw, -9vh, 0) scale(1.18) rotate(-18deg); }
}

@media (prefers-reduced-motion: reduce) {
  .aurora-base,
  .aurora-curtain,
  .aurora-blob {
    animation: none;
  }
}
</style>
