<template>
  <view class="container">
    <aurora-bg />
    <ann-banner />
    <view class="gl-lobby gl-lobby--flush">
      <view class="gl-orbs">
        <view class="gl-orb orb-a"></view>
        <view class="gl-orb orb-b"></view>
        <view class="gl-orb orb-c"></view>
      </view>

      <view class="hero">
        <text class="title">星梦影院</text>
        <text class="subtitle">异地同步 · 免费看片 · 非商业用途</text>
      </view>

      <view v-if="backendStatus === 'online'" class="backend-online">
        服务已连接，可以创建房间
      </view>

      <view class="gl-col">
        <view class="gl-card">
          <text class="gl-kicker">01 · 空白房间</text>
          <text class="gl-card__title">先开房，再放片</text>
          <button class="gl-btn" :disabled="creatingEmpty" @click="createEmptyRoom">
            {{ creatingEmpty ? '创建中...' : '创建空白房间' }}
          </button>
          <text class="gl-note">可以先创建房间，再在房间内添加任意视频</text>
        </view>

        <view class="gl-card">
          <text class="gl-kicker">02 · 视频链接</text>
          <text class="gl-card__title">用视频链接开房</text>
          <input
            ref="biliInput"
            class="gl-input"
            type="text"
            :value="biliUrl"
            placeholder="粘贴视频链接（B站 / 影视站 / mp4 / m3u8 / 网页）"
            @click="focusBiliInput"
            @input="onBiliInput"
            @paste="onBiliPaste"
          />
          <button class="gl-btn" :disabled="resolving" @click="resolveBili">
            {{ resolving ? '解析中...' : '解析视频并开房' }}
          </button>
          <text class="gl-note">支持 B 站、影视/番剧站（粘详情页会自动播第一集）、直链 mp4/m3u8，以及大部分带视频的网页（需登录/付费/DRM 的除外）</text>
        </view>

        <view class="gl-card">
          <text class="gl-kicker">03 · 快速加入</text>
          <text class="gl-card__title">加入已有房间</text>
          <input
            class="gl-input"
            type="text"
            ref="joinInput"
            placeholder="请输入 6 位房间号"
            @click="focusJoinInput"
            @input="onJoinRoomInput"
          />
          <button class="gl-btn" @click="joinRoom">加入房间</button>
        </view>
      </view>

      <view v-if="error" class="error">{{ error }}</view>

      <view class="gl-foot">本项目纯免费、非商业用途，不提供付费 / 会员功能</view>
    </view>
  </view>
</template>

<script>
import { getSocket, getServerBase } from '../../utils/socket.js'
import { requestJSON } from '../../utils/request.js'

export default {
  data() {
    return {
      biliUrl: '',
      joinRoomId: '',
      resolving: false,
        creatingEmpty: false,
      error: '',
        backendStatus: 'checking'
    }
  },

    onLoad() {
      this.checkBackend()
    },

  methods: {
      async checkBackend() {
        this.backendStatus = 'checking'
        try {
          const data = await requestJSON(`${getServerBase()}/api/health`)
          this.backendStatus = data.ok ? 'online' : 'offline'
        } catch (err) {
          this.backendStatus = 'offline'
        }
      },

      onBiliPaste(e) {
        try {
          const ce = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData) || (e.detail && e.detail.clipboardData)
          const text = ce && ce.getData('text')
          if (text) {
            this.biliUrl = text.trim()
          }
        } catch (err) {
          // 忽略粘贴事件读取异常，浏览器默认粘贴仍然会生效
        }
      },

      onBiliInput(e) {
        const dt = e.detail
          const value = dt && dt.value !== undefined ? dt.value : ((e.target && e.target.value !== undefined) ? e.target.value : ((e.currentTarget && e.currentTarget.value !== undefined) ? e.currentTarget.value : (e.srcElement && e.srcElement.value)))
          if (value === undefined || value === null) return
          this.biliUrl = String(value)

        /*
          const dt = e.detail
          const value = dt && dt.value !== undefined ? dt.value : ((e.target && e.target.value !== undefined) ? e.target.value : ((e.currentTarget && e.currentTarget.value !== undefined) ? e.currentTarget.value : (e.srcElement && e.srcElement.value)))
          if (value === undefined || value === null) return
          */

      },

      focusBiliInput() {
        // #ifdef H5
        this.$nextTick(() => {
          const el = this.$refs.biliInput
          const inner = el && (el.querySelector ? el.querySelector('input') : (el.$el && el.$el.querySelector('input')))
          if (inner && inner.focus) inner.focus()
        })
        // #endif
      },

      pasteBiliLink() {
        uni.getClipboardData({
          success: (res) => {
            const text = String((res && res.data) || '').trim()
            if (!text) {
              this.error = '剪贴板里没有内容，请先复制视频链接'
            } else {
              this.biliUrl = text
              this.error = ''
            }
          },
          fail: () => {
            this.error = '无法读取剪贴板，请长按输入框手动粘贴'
          }
        })
      },

        onJoinRoomInput(e) {
          const dt = e.detail
          const value = dt && dt.value !== undefined ? dt.value : ((e.target && e.target.value !== undefined) ? e.target.value : ((e.currentTarget && e.currentTarget.value !== undefined) ? e.currentTarget.value : (e.srcElement && e.srcElement.value)))
          if (value === undefined || value === null) return
          this.joinRoomId = String(value)
        },


        focusJoinInput() {
          // #ifdef H5
          this.$nextTick(() => {
            const el = this.$refs.joinInput
            const inner = el && (el.querySelector ? el.querySelector('input') : (el.$el && el.$el.querySelector('input')))
            if (inner && inner.focus) inner.focus()
          })
          // #endif
        },


        async pasteJoinRoom() {
          try {
            if (navigator.clipboard && navigator.clipboard.readText) {
              const text = await navigator.clipboard.readText()
              this.joinRoomId = (text || '').trim().toUpperCase()
              if (!this.joinRoomId) {
                this.error = '剪贴板里没有内容，请先复制房间号'
              } else {
                this.error = ''
              }
            } else {
              this.error = '当前浏览器不支持一键粘贴，请手动输入'
            }
          } catch (err) {
            this.error = '无法读取剪贴板，请手动输入房间号'
          }
        },


      createEmptyRoom() {
        this.error = ''
        this.creatingEmpty = true
        const socket = getSocket()
        socket.connect()
          socket.off('connect_error', this.onSocketConnectError)
          socket.on('connect_error', this.onSocketConnectError)

        this._pendingVideo = null

        socket.off('room-created', this.onRoomCreated)
        socket.off('room-error', this.onRoomError)
        socket.on('room-created', this.onRoomCreated)
        socket.on('room-error', this.onRoomError)

        if (socket.connected) {
          this.emitCreateRoom()
        } else {
          socket.once('connect', this.emitCreateRoom)
        }
      },

    async resolveBili() {
      const url = this.biliUrl.trim()
      if (!url) {
        this.error = '请先粘贴视频链接'
        return
      }

      this.resolving = true
      this.error = ''

      try {
        const data = await requestJSON(`${getServerBase()}/api/video/resolve`, {
          method: 'POST',
          data: { url }
        })
        if (data.error) {
          throw new Error(data.error || '解析失败')
        }
        this.createRoomWithVideo(data)
      } catch (err) {
        this.error = this.backendStatus === 'offline' ? '服务暂时不可用，请稍后重试' : (err.message || '解析失败')
      } finally {
        this.resolving = false
      }
    },

    joinRoom() {
      let roomId = (this.joinRoomId || '').trim().toUpperCase()
        if (!roomId && this.$refs.joinInput) {
          const el = this.$refs.joinInput
          const input = el && (el.value !== undefined ? el : (el.querySelector ? el.querySelector('input') : (el.$el && el.$el.querySelector('input'))))
          roomId = String((input && input.value) || '').trim().toUpperCase()
        }
      if (!roomId) {
        this.error = '请输入房间号'
        return
      }
      this.error = ''
      uni.navigateTo({
        url: `/pages/room/room?roomId=${roomId}`
      })
    },

    createRoomWithVideo(video) {
      this.error = ''
      const socket = getSocket()
      socket.connect()
        socket.off('connect_error', this.onSocketConnectError)
        socket.on('connect_error', this.onSocketConnectError)

      this._pendingVideo = video

      socket.off('room-created', this.onRoomCreated)
      socket.off('room-error', this.onRoomError)
      socket.on('room-created', this.onRoomCreated)
      socket.on('room-error', this.onRoomError)

      if (socket.connected) {
        this.emitCreateRoom()
      } else {
        socket.once('connect', this.emitCreateRoom)
      }
    },

    emitCreateRoom() {
      const socket = getSocket()
      socket.emit('create-room', { video: this._pendingVideo })
    },

    onRoomCreated(data) {
      const socket = getSocket()
      const room = data.room

        this.creatingEmpty = false
      socket.off('room-created', this.onRoomCreated)
      socket.off('room-error', this.onRoomError)

      uni.setStorageSync('lastRoomId', room.id)
      uni.setStorageSync('lastRoomVideo', room.video)

      uni.redirectTo({
        url: `/pages/room/room?roomId=${room.id}`
      })
    },

      onSocketConnectError() {
        this.error = '网络连接失败，请检查网络后重试'
        this.resolving = false
        this.creatingEmpty = false
      },

    onRoomError(err) {
      this.error = (err && err.message) || '创建房间失败'
      this.resolving = false
        this.creatingEmpty = false
    }
  }
}
</script>

<style scoped>
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

  .link-actions {
    display: flex;
    align-items: stretch;
    gap: 10px;
    margin-bottom: 10px;
  }

  .link-actions .input-field {
    flex: 1;
    min-width: 0;
    margin-bottom: 0;
  }

  .link-actions .input-field.bili-input {
    height: 54px;
    min-height: 54px;
    line-height: 54px;
    padding: 0 16px;
    font-size: 17px;
    color: var(--c-text);
  }

  .btn-secondary {
    background: #f0f0f0;
    color: var(--c-text);
    border-radius: 8px;
    padding: 12px 24px;
    font-size: 16px;
    border: none;
    cursor: pointer;
    flex-shrink: 0;
  }

.file-row {
  margin-bottom: 12px;
}

.file-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  border: 1px dashed #ccc;
  border-radius: 8px;
  background: #fafafa;
  font-size: 13px;
}

.file-info {
  margin-bottom: 12px;
  color: #666;
  font-size: 13px;
}

.tip {
  margin-top: 8px;
  font-size: 12px;
  color: #999;
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

  .backend-online {
    display: block;
    width: 100%;
    max-width: 452px;
    margin: 0 auto 14px;
    padding: 9px 14px;
    box-sizing: border-box;
    border-radius: 999px;
    font-size: 12.5px;
    text-align: center;
    color: #0b7a4c;
    background: #e8f7ef;
    border: 1px solid rgba(16, 157, 99, 0.24);
  }

  .backend-offline {
    display: block;
    width: 100%;
    max-width: 452px;
    margin: 0 auto 14px;
    padding: 9px 14px;
    box-sizing: border-box;
    border-radius: 999px;
    font-size: 12.5px;
    text-align: center;
    color: #c0392b;
    background: #fdecec;
    border: 1px solid rgba(217, 83, 79, 0.24);
  }

.footer {
  text-align: center;
  color: #bbb;
  font-size: 12px;
  padding: 20px 0;
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
.file-input {
  background: #0a1428;
  border-color: rgba(184, 198, 255, 0.24);
  color: var(--c-text);
}
.file-info { color: var(--c-text-2); }
.input-field.bili-input { color: var(--c-text); }
</style>

<style>
.link-actions .input-field.bili-input .uni-input-wrapper,
.link-actions .input-field.bili-input .uni-input-input,
.link-actions .input-field.bili-input input {
  height: 54px;
  min-height: 54px;
  line-height: 54px;
  font-size: 17px;
  color: var(--c-text);
}
</style>
