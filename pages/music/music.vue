<template>
  <view class="container music-page">
    <aurora-bg />
    <ann-banner />
    <view class="gl-lobby">
      <view class="gl-orbs">
        <view class="gl-orb orb-a"></view>
        <view class="gl-orb orb-b"></view>
        <view class="gl-orb orb-c"></view>
      </view>

      <view class="hero">
        <text class="title">星梦音乐厅</text>
        <text class="subtitle">多人同步听歌 · 创建房间邀请好友</text>
      </view>

      <view class="gl-col">
        <view class="gl-card">
          <text class="gl-kicker">01 · 开一间房</text>
          <text class="gl-card__title">创建音乐房间</text>
          <button class="gl-btn" :disabled="creating" @click="createRoom">
            {{ creating ? '创建中...' : '创建房间' }}
          </button>
          <text class="gl-note">创建后出二维码：好友扫码直接进房，异地也能扫；也能发房间号</text>
        </view>

        <view class="gl-card">
          <text class="gl-kicker">02 · 加入好友</text>
          <text class="gl-card__title">加入房间</text>
          <input
            class="gl-input"
            type="text"
            v-model="joinRoomId"
            placeholder="请输入 6 位房间号"
          />
          <button class="gl-btn" @click="joinRoom">加入房间</button>
          <text class="gl-note">输入好友分享的 6 位房间号即可进入</text>
        </view>

        <view class="gl-card">
          <text class="gl-kicker">03 · 玩法说明</text>
          <text class="gl-card__title">房间里能做什么</text>
          <text class="gl-note">支持添加音频链接 / 本地上传，房间内播放进度、暂停、切歌会实时同步</text>
        </view>
      </view>

      <view v-if="error" class="error">{{ error }}</view>
    </view>
  </view>
</template>

<script>
import { getSocket } from '../../utils/socket.js'

export default {
  data() {
    return {
      creating: false,
      createTimer: null,
      joinRoomId: '',
      socket: null,
      error: ''
    }
  },

  onUnload() {
    this.clearCreateTimer()
    this.unbindEvents()
  },

  methods: {
    bindEvents() {
      this.socket = getSocket()
      this.socket.off('music-room-created', this.handleRoomCreated)
      this.socket.off('music-error', this.handleError)
      this.socket.off('connect_error', this.handleConnectError)
      this.socket.off('connect', this.handleConnect)
      this.socket.on('music-room-created', this.handleRoomCreated)
      this.socket.on('music-error', this.handleError)
      this.socket.on('connect_error', this.handleConnectError)
      this.socket.on('connect', this.handleConnect)
    },

    unbindEvents() {
      if (!this.socket) return
      this.socket.off('music-room-created', this.handleRoomCreated)
      this.socket.off('music-error', this.handleError)
      this.socket.off('connect_error', this.handleConnectError)
      this.socket.off('connect', this.handleConnect)
    },

    clearCreateTimer() {
      if (this.createTimer) {
        clearTimeout(this.createTimer)
        this.createTimer = null
      }
    },

    createRoom() {
      this.error = ''
      this.creating = true
      this.clearCreateTimer()
      this.createTimer = setTimeout(() => {
        if (this.creating) {
          this.creating = false
          uni.showToast({
            title: '创建房间超时，请稍后重试',
            icon: 'none',
            duration: 3000
          })
        }
      }, 8000)
      this.bindEvents()
      this.socket.connect()
      if (this.socket.connected) {
        this.emitCreateRoom()
      } else {
        this.socket.once('connect', () => this.emitCreateRoom())
      }
    },

    emitCreateRoom() {
      this.socket.emit('music-create-room')
    },

    handleRoomCreated(data) {
      this.clearCreateTimer()
      this.creating = false
      const room = data.room
      uni.navigateTo({
        url: `/pages/music/room?roomId=${room.id}`
      })
    },

    joinRoom() {
      const roomId = (this.joinRoomId || '').trim().toUpperCase()
      if (!roomId) {
        uni.showToast({ title: '请输入房间号', icon: 'none' })
        return
      }
      uni.navigateTo({
        url: `/pages/music/room?roomId=${roomId}`
      })
    },

    handleError(err) {
      this.clearCreateTimer()
      this.creating = false
      this.error = (err && err.message) || '创建房间失败'
    },

    handleConnectError() {
      this.clearCreateTimer()
      this.creating = false
      this.error = '连接失败，正在自动重连，请稍后重试'
    }
,

    handleConnect() {
      this.error = ''
    }
  }
}
</script>

<style scoped>
.music-page {
  min-height: 100vh;
  padding: 0 20px;
  box-sizing: border-box;
  background: transparent;
}

.hero {
  text-align: center;
  padding: 30px 0 20px;
}

.title {
  display: block;
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 1px;
  color: #14342a;
}

.subtitle {
  display: block;
  margin-top: 8px;
  font-size: 13px;
  color: #5c7c6d;
  line-height: 1.6;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 12px;
}

.tip {
  margin-top: 8px;
  font-size: 12px;
  color: #999;
  line-height: 1.7;
}

.error {
  background: #fdecec;
  color: #c0392b;
  border: 1px solid rgba(217, 83, 79, 0.2);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 16px;
  font-size: 13px;
  line-height: 1.6;
}

/* ===== 深海覆盖（颜色） ===== */
.hero .title { color: var(--c-text); }
.hero .subtitle { color: var(--c-text-2); }
.section-title { color: var(--c-text); }
.tip,
.footer { color: var(--c-text-3); }

.error {
  background: rgba(255, 107, 138, 0.1);
  color: #ffb3c1;
  border-color: rgba(255, 107, 138, 0.28);
}

.backend-online {
  color: #9fe8ff;
  background: rgba(77, 107, 254, 0.14);
  border-color: rgba(110, 231, 255, 0.28);
}

.backend-offline {
  color: #ffb3c1;
  background: rgba(255, 107, 138, 0.1);
  border-color: rgba(255, 107, 138, 0.26);
}
</style>
