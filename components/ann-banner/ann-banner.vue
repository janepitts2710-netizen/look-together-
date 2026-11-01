<template>
  <view v-if="visible" class="ann-bar" :class="'lv-' + level">
    <view class="ann-inner" @tap="open">
      <text class="ann-ico">📢</text>
      <text class="ann-text">{{ text }}</text>
      <text class="ann-more">详情</text>
    </view>
    <view class="ann-close" @tap.stop="close">
      <text class="ann-x">×</text>
    </view>
  </view>
</template>

<script>
import { annState, dismissBar, openAnnouncementDetail } from '../../utils/announcement.js'

export default {
  name: 'AnnBanner',
  computed: {
    visible() {
      return annState.barVisible && !!annState.barText
    },
    text() {
      return annState.barText
    },
    level() {
      return annState.barLevel || 'info'
    }
  },
  methods: {
    open() {
      openAnnouncementDetail()
    },
    close() {
      dismissBar()
    }
  }
}
</script>

<style scoped>
/* 跟随内容流排在页面顶部：不会盖住导航栏和播放器，也不用给每个页面加 padding */
.ann-bar {
  position: relative;
  display: flex;
  align-items: center;
  margin: 0 0 14px;
  padding: 9px 12px 9px 15px;
  box-sizing: border-box;
  border-radius: 12px;
  background: rgba(11, 23, 48, 0.78);
  border: 1px solid rgba(184, 198, 255, 0.15);
  box-shadow: 0 14px 30px -24px rgba(0, 0, 0, 0.9);
  overflow: hidden;
  animation: ann-in 0.3s ease-out;
}

@keyframes ann-in {
  from {
    transform: translateY(-6px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

/* 左侧竖条按公告级别变色 */
.ann-bar::before {
  content: '';
  position: absolute;
  left: 0;
  top: 6px;
  bottom: 6px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: #6ee7ff;
}

.ann-bar.lv-warning::before {
  background: #e0a52e;
}

.ann-bar.lv-danger::before {
  background: #ff6b8a;
}

.ann-bar.lv-warning {
  background: rgba(224, 165, 46, 0.1);
  border-color: rgba(224, 165, 46, 0.28);
}

.ann-bar.lv-danger {
  background: rgba(255, 107, 138, 0.1);
  border-color: rgba(255, 107, 138, 0.26);
}

.ann-inner {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ann-ico {
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
}

.ann-text {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: #e6ecff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lv-warning .ann-text {
  color: #f4d48a;
}

.lv-danger .ann-text {
  color: #ffb3c1;
}

.ann-more {
  flex-shrink: 0;
  font-size: 11.5px;
  color: #e6ecff;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(77, 107, 254, 0.16);
  border: 1px solid rgba(110, 231, 255, 0.3);
}

.ann-close {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  margin-left: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(184, 198, 255, 0.08);
}

.ann-x {
  font-size: 15px;
  line-height: 1;
  color: #8fa3d9;
}
</style>
