<template>
  <view class="container room-page">
    <aurora-bg />
    <ann-banner />
    <view v-if="fatalError" class="error">{{ fatalError }}</view>

    <view v-else-if="loading" class="loading">正在加入房间...</view>

    <view v-else>
      <view v-if="connectionTip" class="connection-tip">{{ connectionTip }}</view>

      <!-- 操作提示（解析失败等）只占一条，不再把整个房间页面顶掉 -->
      <view v-if="error" class="error-inline" @click="error = ''">
        <text class="error-inline-text">{{ error }}</text>
        <text class="error-inline-close">×</text>
      </view>

      <view v-if="video" class="gl-card video-card">
        <view v-if="video.title" class="video-title">{{ video.title }}</view>
        <!-- #ifdef H5 -->
        <view v-if="isEmbed" class="embed-wrap">
          <view class="embed-frame" v-html="embedHtml"></view>
        </view>
        <view v-else id="dplayer" class="dplayer"></view>
        <!-- #endif -->
        <!-- #ifndef H5 -->
        <view v-if="isEmbed" class="mp-video-tip">该站点只支持网页嵌入播放，请用网页端打开房间</view>
        <video
          v-else-if="mpPlayUrl"
          id="mp-video"
          class="mp-video"
          :src="mpPlayUrl"
          controls
          @play="onMpPlay"
          @pause="onMpPause"
          @timeupdate="onMpTimeupdate"
        ></video>
        <view v-else class="mp-video-tip">当前视频格式小程序端暂不支持播放，请使用网页端观看</view>
        <!-- #endif -->
        <view v-if="isEmbed" class="embed-tip">
          该网站不允许直接取流，已切换为「网页嵌入」：画面能一起看，但播放进度不会自动同步
        </view>
        <view v-if="!isEmbed" class="sync-tip">
          {{ waitingVideo ? ('正在等观众加载（' + waitingReady + '/' + waitingTotal + '）…') : (buffering ? '网络较慢，缓冲中…加载好会自动对齐进度' : (catchingUp ? '正在追赶进度…' : '每个人都能暂停或拖进度，操作会同步给全房')) }}
        </view>
        <view v-if="needTapToPlay && !isEmbed" class="tap-to-play" @click="resumePlay">▶ 点击继续播放（浏览器需要一次点击才允许出声）</view>
      </view>

      <view v-if="video && pages && pages.length > 1" class="gl-card part-card">
        <view class="section-title">分P列表</view>
        <view
          v-for="p in pages"
          :key="p.cid"
          class="part-item"
          :class="{ active: selectedPart === p.part }"
          @click="selectPart(p)"
        >
          <text class="part-name">{{ p.page }}. {{ p.part }}</text>
          <text v-if="p.duration" class="part-duration">{{ formatDuration(p.duration) }}</text>
        </view>
      </view>

      <view class="gl-card">
        <view class="section-title">{{ video ? '更换视频' : '给房间添加视频' }}</view>
        <view class="link-actions">
          <input
            ref="roomBiliInput"
            class="gl-input"
            type="text"
            :value="roomBiliUrl"
            placeholder="粘贴视频链接（B站 / 影视站 / mp4 / m3u8 / 网页）"
            @click="focusRoomBiliInput"
            @input="onRoomBiliInput"
            @paste="onRoomBiliPaste"
          />
        </view>
        <button class="gl-btn" :disabled="roomResolving" @click="resolveRoomBili">
          {{ roomResolving ? '解析中...' : (video ? '解析并更换视频' : '解析视频') }}
        </button>
        <view class="link-hint">支持 B 站、影视/番剧站（粘详情页会自动播第一集）、直链 mp4/m3u8，以及大部分带视频的网页</view>
        <view class="link-hint">谁点的片谁就是同步基准，其他人会自动跟你对齐</view>
      </view>

      <view class="gl-card info-card">
        <view class="room-header">
          <view>
            <view class="label">房间号</view>
            <view class="room-id">{{ roomId }}</view>
          </view>
          <view class="badge-group">
            <view class="badge" :class="{ host: isHost }">
              {{ isHost ? '房主' : '观众' }}
            </view>
          </view>
        </view>

        <view class="meta-row">
          <text>当前人数：{{ memberCount }} 人</text>
          <text class="copy-btn" @click="copyLink">复制分享链接</text>
        </view>

        <view class="share-link">{{ shareLink }}</view>

        <!-- #ifdef H5 -->
        <view v-if="qrDataUrl" class="qrcode-wrap">
          <image class="qrcode-img" :src="qrDataUrl" mode="widthFix" />
        </view>
        <view v-if="shareBases.length <= 1" class="share-tip">手机要和电脑连同一个 Wi-Fi；扫不开多为电脑防火墙拦了本服务</view>
        <view v-if="shareBases.length > 1" class="share-switch" @click="cycleShareHost">
          {{ tunnelOn ? '换个地址' : '手机连不上？换一个地址' }}（{{ shareIndex + 1 }}/{{ shareBases.length }}<text v-if="shareBases[shareIndex] && shareBases[shareIndex].name"> · {{ shareBases[shareIndex].name }}</text>）
        </view>
        <!-- #endif -->
      </view>
    </view>
  </view>
</template>

<script>
// 播放器 / 二维码库改成「用到才下载」，不再在 index.html 里同步加载：
// 观影厅要用 DPlayer 时才拉 660KB 的播放器，房间出二维码时才拉 23KB 的 qrcode。
import { ensureDPlayer, ensureHls, ensureQRCode } from '../../utils/load-script.js'
import { getSocket, getServerBase } from '../../utils/socket.js'
import { requestJSON } from '../../utils/request.js'
import { serverNow, positionAt, startClockSync, stopClockSync } from '../../utils/clock.js'
// 二维码/分享地址的统一解析（五子棋、斗地主、音乐厅也用它）
import { resolveShareHosts } from '../../utils/share-host.js'

function absoluteUrl(url) {
  if (!url) return ''
  if (/^https?:\/\//i.test(url)) return url
  return getServerBase() + (url.charAt(0) === '/' ? url : '/' + url)
}

export default {
  data() {
    return {
      roomId: '',
      video: null,
      shareLink: '',
      // 分享地址候选：公网隧道 → 当前地址 → 局域网各网卡，数字角标可手动切换
      shareBases: [],
      shareIndex: 0,
      // 当前选中的地址前缀（'' 表示直接用 window.location）
      shareBase: '',
      // 是否已启用公网穿透：开启后手机用流量、在外地也能扫
      tunnelOn: false,
      // 没检测到隧道时补查次数（隧道晚于页面启动的情况下自动补上）
      shareRetry: 0,
      shareRetryTimer: null,
      memberCount: 0,
      isHost: false,
      // 谁在掌控播放（默认房主；任何人换片后接管）
      isController: false,
      // 服务端时间轴（time/playing/rate/at），跟随方据此推算「此刻该播到哪」
      remoteState: null,
      // 正在等数据（缓冲）：这期间不做任何 seek，否则缓冲会被反复打断
      buffering: false,
      // 网络慢追不上时给个提示
      catchingUp: false,
      loading: true,
      // 页面级错误（房间进不去）：会替换整页
      fatalError: '',
      // 操作级错误（解析失败等）：只在页内显示一条，不影响看视频
      error: '',
      connectionTip: '',
      pendingState: null,
      roomBiliUrl: '',
      roomResolving: false,
      mpPlayUrl: '',
      pages: [],
      selectedPart: '',
      qrDataUrl: '',
      needTapToPlay: false,
      // 房主点播放后，正在等观众加载
      waitingVideo: false,
      waitingReady: 0,
      waitingTotal: 0,
      // 网页嵌入模式：站点不给流时的兜底
      isEmbed: false,
      embedHtml: ''
    }
  },

  onLoad(query) {
    this.roomId = (query && query.roomId) || ''
    if (!this.roomId) {
      this.fatalError = '缺少房间号，请通过分享链接进入'
      this.loading = false
      return
    }

    this.socket = getSocket()
    this.socket.connect()

    // 二维码/分享链接：本机打开时换成局域网 IP，有内网穿透时优先公网地址
    this.refreshShareHost()

    // 绑定事件
    this.socket.on('room-state', this.handleRoomState)
    this.socket.on('host-control', this.handleHostControl)
    this.socket.on('video-waiting', this.handleVideoWaiting)
    this.socket.on('video-start', this.handleVideoStart)
    this.socket.on('sync', this.handleSync)
    this.socket.on('member-updated', this.handleMemberUpdated)
    this.socket.on('host-changed', this.handleHostChanged)
    this.socket.on('room-error', this.handleRoomError)
      this.socket.on('connect', this.handleConnect)
      this.socket.on('disconnect', this.handleDisconnect)
      this.socket.on('video-updated', this.handleVideoUpdated)
      this.socket.on('controller-changed', this.handleControllerChanged)

    if (this.socket.connected) {
      this.handleConnect()
    }
  },

  onUnload() {
    this.cleanup()
  },
  methods: {
    handleConnect() {
      if (!this.roomId) return
      this.connectionTip = ''
      // 先把自己的时钟和服务端对齐，之后所有进度换算才有意义
      startClockSync(this.socket)
      this.socket.emit('join-room', { roomId: this.roomId })
    },

      handleDisconnect() {
        this.connectionTip = '连接已断开，正在自动重连...'
      },

    handleRoomState(data) {
      this._pendingControlUntil = 0
      clearTimeout(this._pendingControlTimer)
      const room = data.room || {}
      this.roomId = room.id || this.roomId
      this.video = room.video || null
      this.syncEmbedState(this.video)
      if (this.isEmbed) this.reportVideoReady()
      this.pages = (this.video && this.video.pages) ? this.video.pages.slice() : []
      this.selectedPart = (this.video && this.video.part) || ''
      this.isHost = !!data.isHost
      this.isController = (room.controllerId || room.hostId) === this.socket.id
      this.memberCount = room.memberCount || 1
      this.shareLink = this.buildShareLink()
      this.loading = false
      this.pendingState = room.state || { playing: false, time: 0, rate: 1 }

      // #ifndef H5
      this.mpPlayUrl = this.buildMpPlayUrl(this.video)
      // #endif

        // 如果断线重连后房主已经换了视频，则重新初始化播放器
        if (this.dp && this.video && this._currentVideoUrl && this._currentVideoUrl !== this.video.videoUrl) {
          this.dp.destroy()
          this.dp = null
          if (this._hls) {
            this._hls.destroy()
            this._hls = null
          }
          this.$nextTick(() => {
            if (this.video) {
              this.initPlayer(this.video.videoUrl)
            }
            this.updateQrcode()
          })
          this.startSyncIfHost()
          return
        }

      if (this.dp || this.mpPlayUrl) {
        this.applyState(this.pendingState)
        this.pendingState = null
      }

      this.$nextTick(() => {
        // 二维码和视频无关：空房间里也要能扫码邀请
        // #ifdef H5
        this.updateQrcode()
        // #endif
        if (!this.video) return
        // #ifdef H5
        this.initPlayer(this.video.videoUrl)
        // #endif
        // #ifndef H5
        if (this.pendingState) {
          this.applyState(this.pendingState)
          this.pendingState = null
        }
        // #endif
      })

      this.startSyncIfHost()
    },

      handleVideoUpdated(data) {
        if (!data || !data.video || !data.video.videoUrl) return
        this._pendingControlUntil = 0
        clearTimeout(this._pendingControlTimer)
        this.video = data.video
        this._forceProxy = false
        this._playingDirect = false
        this._videoReadyKey = ''
        this.syncEmbedState(this.video)
        this.pages = (this.video && this.video.pages) ? this.video.pages.slice() : []
        this.selectedPart = (this.video && this.video.part) || ''
        this.pendingState = data.state || { playing: false, time: 0, rate: 1 }

        // #ifndef H5
        this.mpPlayUrl = this.buildMpPlayUrl(this.video)
        // #endif

        if (this.dp) {
          this.dp.destroy()
          this.dp = null
        }
        if (this._hls) {
          this._hls.destroy()
          this._hls = null
        }

        this.$nextTick(() => {
          // #ifdef H5
          this.initPlayer(this.video.videoUrl)
          this.updateQrcode()
          // #endif
          // #ifndef H5
          if (this.pendingState) {
            this.applyState(this.pendingState)
            this.pendingState = null
          }
          // #endif
        })

        this.startSyncIfHost()
      },

      async resolveRoomBili() {
        const url = this.roomBiliUrl.trim()
        if (!url) {
          this.error = '请先粘贴视频链接'
          return
        }
        this.roomResolving = true
        this.error = ''
        try {
          const data = await requestJSON(`${getServerBase()}/api/video/resolve`, {
            method: 'POST',
            data: { url }
          })
          if (data.error) {
            throw new Error(data.error || '解析失败')
          }
          this.emitUpdateVideo(data)
          this.roomBiliUrl = ''
        } catch (err) {
          this.error = err.message || '解析失败'
        } finally {
          this.roomResolving = false
        }
      },


        onRoomBiliPaste(e) {
          try {
            const ce = e.clipboardData || (e.originalEvent && e.originalEvent.clipboardData) || (e.detail && e.detail.clipboardData)
            const text = ce && ce.getData('text')
            if (text) {
              this.roomBiliUrl = text.trim()
            }
          } catch (err) {
            // 忽略粘贴事件读取异常，浏览器默认粘贴仍然会生效
          }
        },

        onRoomBiliInput(e) {
          const dt = e.detail
          const value = dt && dt.value !== undefined ? dt.value : ((e.target && e.target.value !== undefined) ? e.target.value : ((e.currentTarget && e.currentTarget.value !== undefined) ? e.currentTarget.value : (e.srcElement && e.srcElement.value)))
          if (value === undefined || value === null) return
          this.roomBiliUrl = String(value)
        },

        focusRoomBiliInput() {
          // #ifdef H5
          this.$nextTick(() => {
            const el = this.$refs.roomBiliInput
            const inner = el && (el.querySelector ? el.querySelector('input') : (el.$el && el.$el.querySelector('input')))
            if (inner && inner.focus) inner.focus()
          })
          // #endif
        },

        pasteRoomBiliLink() {
          uni.getClipboardData({
            success: (res) => {
              const text = String((res && res.data) || '').trim()
              if (!text) {
                this.error = '剪贴板里没有内容，请先复制视频链接'
              } else {
                this.roomBiliUrl = text
                this.error = ''
              }
            },
            fail: () => {
              this.error = '无法读取剪贴板，请长按输入框手动粘贴'
            }
          })
        },

      formatDuration(seconds) {
        const s = Math.max(0, Math.floor(Number(seconds) || 0))
        const m = Math.floor(s / 60)
        const r = s % 60
        return `${m}:${r < 10 ? '0' : ''}${r}`
      },

      selectPart(p) {
        if (!this.socket || !this.video || !p || !p.cid) return
        if (this.selectedPart === p.part) return
        this.socket.emit('video-select-part', {
          roomId: this.roomId,
          bvid: this.video.bvid,
          cid: p.cid,
          part: p.part
        })
      },

      emitUpdateVideo(video) {
        if (!this.socket) return
        this.socket.emit('update-video', {
          roomId: this.roomId,
          video
        })
      },

    // 视频源变化时同步「是否走网页嵌入」
    syncEmbedState(video) {
      const embed = !!(video && video.kind === 'embed' && video.embedUrl)
      this.isEmbed = embed
      // #ifdef H5
      this.embedHtml = embed ? this.buildEmbedHtml(video.embedUrl) : ''
      // #endif
      if (embed) {
        this.needTapToPlay = false
        // 嵌入模式下用不到 DPlayer，销毁掉避免空占位
        if (this.dp) {
          this.dp.destroy()
          this.dp = null
        }
        if (this._hls) {
          this._hls.destroy()
          this._hls = null
        }
      }
    },

    // #ifdef H5
    buildEmbedHtml(url) {
      const safe = String(url).replace(/"/g, '&quot;')
      return `<iframe src="${safe}" frameborder="0" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen scrolling="no" style="width:100%;height:100%;border:0;display:block"></iframe>`
    },
    // #endif

    // 普通 mp4 直链优先让手机直连源站：视频流量不经过自家上传和隧道，
    // 只有同步控制消息走隧道。直连失败（防盗链/跨域/源站限制）再自动回退代理。
    buildPlayUrl(video) {
      if (!video || !video.videoUrl) return ''
      if (video.isLocal) return absoluteUrl(video.videoUrl)
      // 观众端 B 站自动降一档：房主 720P，观众 480P，走代理也不至于把隧道打满
      const sourceUrl = (!this.isHost && video.videoUrlLow) ? video.videoUrlLow : video.videoUrl
      const candidate = { ...video, videoUrl: sourceUrl }
      if (this._forceProxy) return this.proxyPlayUrl(candidate)
      if (this.canDirectMp4(candidate)) return sourceUrl
      return this.proxyPlayUrl(candidate)
    },

    proxyPlayUrl(video) {
      const ref = video.referer ? `&ref=${encodeURIComponent(video.referer)}` : ''
      return `${getServerBase()}/api/vproxy?url=${encodeURIComponent(video.videoUrl)}${ref}`
    },

    isBiliLike(video) {
      if (!video) return false
      if (video.isBili || video.source === 'bilibili') return true
      const s = `${video.videoUrl || ''} ${video.videoUrlLow || ''} ${video.referer || ''}`
      return /bilibili|bilivideo|hdslb|b23\.tv|mountaintoys/i.test(s)
    },

    canDirectMp4(video) {
      if (!video || !video.videoUrl) return false
      if (video.isLocal || video.isHls || video.kind === 'embed') return false
      // B 站 CDN 校验 Referer，浏览器直连必然 403，别让它先失败再回退
      if (this.isBiliLike(video)) return false
      const url = String(video.videoUrl)
      if (!/^https?:\/\//i.test(url)) return false
      // 页面是 https 时，http 视频会被浏览器按混合内容拦掉，只能走代理
      if (typeof window !== 'undefined' && window.location.protocol === 'https:' && !/^https:/i.test(url)) return false
      return /\.(mp4|m4v)(?:$|[?#])/i.test(url)
    },

    async initPlayer(url) {
      // #ifdef H5
      if (!url || this.dp) return
      // 网页嵌入模式不走播放器（视频块单独渲染 iframe）
      if (this.isEmbed || (this.video && this.video.kind === 'embed')) return

      // DPlayer 约 300KB，改为进房间要用时再下载（之前是 head 同步加载，手机首屏被它拖慢）
      try {
        await ensureDPlayer()
      } catch (e) {
        this.error = '播放器资源加载失败，请检查网络后刷新页面'
        return
      }
      // 等下载的这段时间里可能已经有别的流程把播放器建起来了
      if (this.dp) return

      const DPlayer = typeof window !== 'undefined' ? window.DPlayer : null
      if (!DPlayer) {
        this.error = '播放器初始化失败，请刷新页面重试'
        return
      }

      const container = document.getElementById('dplayer')
      if (!container) return

      const isM3u8 = this.video && this.video.isHls
        ? true
        : /\.m3u8(\?|$)/i.test(url)
      // HLS 才需要 hls.js（约 350KB），普通 mp4 不下载
      let Hls = null
      if (isM3u8) {
        try {
          await ensureHls()
          Hls = typeof window !== 'undefined' ? window.Hls : null
        } catch (e) {
          console.warn('hls.js 加载失败，尝试用浏览器原生 HLS 播放')
        }
      }
      if (this.dp) return
        this._currentVideoUrl = url

      // 统一下游代理地址：B 站防盗链、任意站点 Referer、m3u8 分片重写都靠它
      const playUrl = this.buildPlayUrl(this.video) || url
      this._playingDirect = !!this.video && !this._forceProxy && this.canDirectMp4(this.video)

      this.dp = new DPlayer({
        container,
        video: {
          url: playUrl,
          type: isM3u8 ? 'customHls' : 'auto'
        },
        customType: {
          customHls: (video, player) => {
            if (Hls && Hls.isSupported()) {
              const hls = new Hls()
              // 不能用 video.src：DPlayer 调 customType 时还没把地址写进 video.src，
              // 这里直接用我们算好的 playUrl，否则 loadSource('') 会静默失败
              hls.loadSource(playUrl)
              hls.attachMedia(video)
              hls.on(Hls.Events.ERROR, (evt, data) => {
                // 网络类错误交给 hls 自己重试，致命错误才提示
                if (data && data.fatal) {
                  console.warn('[hls] 播放失败', data.type, data.details)
                  this.error = '这个 m3u8 流播放失败，可能是地址失效或不支持的分片格式'
                }
              })
              this._hls = hls
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
              // iOS Safari 走原生 HLS：必须设置真实地址（原来的 video.src = video.src 是空操作）
              video.src = playUrl
            }
          }
        },
        autoplay: false,
        theme: '#fb7299',
        lang: 'zh-cn',
        screenshot: false,
        hotkey: true,
        preload: 'auto'
      })

      this.dp.on('play', () => { this.needTapToPlay = false })
      this.dp.on('play', this.onHostPlay)
      this.dp.on('pause', this.onHostPause)
      this.dp.on('seeked', this.onHostSeeked)
      this.dp.on('ratechange', this.onHostRatechange)
      this.dp.on('loadedmetadata', () => {
        if (this.pendingState) {
          this.applyState(this.pendingState)
          this.pendingState = null
        }
        // 元数据到了才知道真实时长，这时候再对一次位置最准
        this.catchUpOnce()
        })

      // 盯着缓冲状态：网慢的时候不要反复 seek 把缓冲打断
      this.bindBufferState(this.dp.video)
      this.startFollowLoop()
      // #endif
    },

    safePlay() {
      if (!this.dp || !this.dp.video) return
      try {
        const ret = this.dp.video.play()
        if (ret && typeof ret.catch === 'function') {
          ret.catch(() => { this.needTapToPlay = true })
        }
      } catch (err) {
        this.needTapToPlay = true
      }
    },

    resumePlay() {
      this.needTapToPlay = false
      if (!this.dp || !this.dp.video) return
      try {
        const ret = this.dp.video.play()
        if (ret && typeof ret.catch === 'function') ret.catch(() => {})
      } catch (err) {
        // 仍被拦截时保持提示
      }
    },

    applyState(state) {
      if (!state) return
      // 统一存成「时间轴」格式：time 是 at 那一刻的位置，之后按 rate 往前走
      const st = {
        time: Number(state.time) || 0,
        playing: !!state.playing,
        rate: Number(state.rate) || 1,
        at: Number(state.at) || 0
      }
      this.remoteState = st
      // 刚进房 / 换片：允许一次「定位加载」，之后小偏差不再硬跳
      this._initialSynced = false
      // #ifdef H5
      if (!this.dp) return

      this.suppressControl = true
      clearTimeout(this._suppressTimer)

      const target = positionAt(st)
      if (Math.abs(this.dp.video.currentTime - target) > 1) {
        this.seekQuiet(target)
        if (this.dp.video.readyState >= 2) this._initialSynced = true
      }

      if (st.rate && Math.abs(this.dp.video.playbackRate - st.rate) > 0.01) {
        this.dp.playbackRate = st.rate
      }

      if (st.playing) {
        this.safePlay()
      } else {
        this.dp.pause()
      }

      this._suppressTimer = setTimeout(() => {
        this.suppressControl = false
      }, 500)
      // #endif
      // #ifndef H5
      this.applyMpState(st)
      // #endif
    },

    // 自己的跳转不算「卡住了」，用一个短暂的保护窗口把它排除在外
    seekQuiet(target) {
      if (!this.dp || !this.dp.video) return
      const t = Number(target)
      if (!Number.isFinite(t) || t < 0) return
      const now = Date.now()
      this._seekGuardUntil = now + 2200
      // 记下每次硬跳的时间，跳太频繁说明这条线路撑不住，后面改成慢慢追
      this._seekTimes = (this._seekTimes || []).filter((ts) => now - ts < 20000)
      this._seekTimes.push(now)
      try {
        this.dp.seek(t)
      } catch (err) {
        // 极少数情况下播放器还没准备好，忽略这一次
      }
    },

    // 加减速追进度：比直接 seek 温和，不会把已缓冲的数据扔掉
    setNudgeRate(rate) {
      if (!this.dp || !this.dp.video) return
      const r = Math.min(2, Math.max(0.5, Number(rate) || 1))
      if (Math.abs(this.dp.video.playbackRate - r) > 0.005) {
        this._seekGuardUntil = this._seekGuardUntil || 0
        // 这个赋值同样会触发 ratechange，打个时间戳让 onHostRatechange 别把它当成用户变速
        this._nudgeAt = Date.now()
        this.dp.video.playbackRate = r
      }
    },

    bindBufferState(video) {
      if (!video || video.__lookBound) return
      video.__lookBound = true
      const markBuffering = () => {
        // 刚自己跳转过导致的等待不算，否则会陷入「跳→等→判卡→再跳」
        if (Date.now() < (this._seekGuardUntil || 0)) return
        this.buffering = true
      }
      const markReady = () => {
        this.buffering = false
        this.reportVideoReady()
        this.catchUpOnce()
      }
      video.addEventListener('waiting', markBuffering)
      video.addEventListener('stalled', markBuffering)
      video.addEventListener('canplay', markReady)
      video.addEventListener('playing', markReady)
      video.addEventListener('seeked', () => {
        this.buffering = false
        this.catchUpOnce()
      })
      video.addEventListener('error', () => this.onDirectVideoError())
    },

    reportVideoReady() {
      if (!this.socket || !this.roomId) return
      if (this.isEmbed) {
        this.socket.emit('video-ready', { roomId: this.roomId })
        return
      }
      const v = this.dp && this.dp.video
      if (!v || v.readyState < 3) return
      // 至少 1 秒前瞻缓冲；没有 buffered 信息的浏览器用 readyState=4 兜底
      let ahead = 0
      try {
        const b = v.buffered
        const cur = v.currentTime || 0
        for (let i = 0; i < b.length; i += 1) {
          if (b.start(i) <= cur + 0.25) ahead = Math.max(ahead, b.end(i) - cur)
        }
      } catch (e) {}
      const noRange = !v.buffered || !v.buffered.length
      if (ahead < 1 && !(noRange && v.readyState >= 4)) return
      const key = this.video ? (this.video.videoUrl || '') : ''
      if (key && this._videoReadyKey === key) return
      this._videoReadyKey = key
      this.socket.emit('video-ready', { roomId: this.roomId })
    },

    // 直连 mp4 被源站拒绝（防盗链、跨域、403）时，自动回退到后端代理，用户不用手动重开
    onDirectVideoError() {
      if (!this._playingDirect || this._forceProxy || !this.video) return
      this._playingDirect = false
      this._forceProxy = true
      const v = this.dp && this.dp.video
      this.pendingState = {
        time: v ? v.currentTime || 0 : 0,
        playing: v ? !v.paused : false,
        rate: v ? v.playbackRate || 1 : 1,
        at: 0
      }
      if (this.dp) {
        try { this.dp.destroy() } catch (e) {}
        this.dp = null
      }
      if (this._hls) {
        try { this._hls.destroy() } catch (e) {}
        this._hls = null
      }
      this.$nextTick(() => this.initPlayer(this.video ? this.video.videoUrl : ''))
    },

    /**
     * 判断这次该不该硬跳。
     * 明显跑偏（刚进房、换片、别人拖了进度）就直接跳；
     * 只是慢慢落后的情况，20 秒内已经跳了 3 次就别再跳了，改成加减速慢慢追。
     */
    canHardSeek(drift) {
      const now = Date.now()
      this._seekTimes = (this._seekTimes || []).filter((ts) => now - ts < 20000)
      // 20 秒内最多硬跳一次：宁可慢慢追，也不让手机反复重新缓冲
      return this._seekTimes.length < 1
    },

    /**
     * 缓冲刚恢复时对齐一次。
     * 这就是「网慢的人加载完自动跳到正确位置」的那一步——只跳一次，之后靠加减速微调。
     */
    catchUpOnce() {
      if (this._pendingControlUntil && Date.now() < this._pendingControlUntil) return
      if (this.isController || this.isEmbed || !this.dp || !this.remoteState) return
      if (Date.now() < (this._seekGuardUntil || 0)) return
      const v = this.dp.video
      if (!v || v.readyState < 3) return
      const target = positionAt(this.remoteState)
      const drift = target - v.currentTime
      // 第一次能播：如果落后明显，只在这里硬定位一次（这一下不可避免，之后不再反复跳）
      if (!this._initialSynced) {
        this._initialSynced = true
        if (Math.abs(drift) > 1) {
          this.seekQuiet(target)
          if (v.paused && this.remoteState.playing) this.safePlay()
          return
        }
      }
      // 同步循环不再主动硬跳：0~5 秒的内容差都交给很轻的变速处理，避免观众重新缓冲
      if (Math.abs(drift) <= 5) return
      if (!this.canHardSeek(drift)) return
      this.seekQuiet(target)
      if (!v.paused) return
      if (this.remoteState.playing) this.safePlay()
    },

    startFollowLoop() {
      if (this.followTimer) return
      this.followTimer = setInterval(() => this.followTick(), 1000)
    },

    stopFollowLoop() {
      if (this.followTimer) {
        clearInterval(this.followTimer)
        this.followTimer = null
      }
    },

    /**
     * 每秒一次的小幅校正（只对跟随方生效）
     *   偏差 < 1.2s  → 完全不动：允许 0.x~1s 的内容差，画面最稳
     *   偏差 1.2~4s  → 最多 ±3% 极轻变速，能追多少算多少，绝不重新加载
     *   偏差 > 4s    → 才硬跳一次，且 20 秒内最多一次
     */
    followTick() {
      if (this._pendingControlUntil && Date.now() < this._pendingControlUntil) return
      if (this.isController || this.isEmbed || !this.dp || !this.remoteState) return
      const v = this.dp.video
      if (!v) return
      const st = this.remoteState
      const baseRate = Number(st.rate) || 1
      const target = positionAt(st)

      if (!st.playing) {
        this.setNudgeRate(baseRate)
        if (!v.paused) v.pause()
        if (v.readyState >= 2 && Math.abs(target - v.currentTime) > 2.5) this.seekQuiet(target)
        this.catchingUp = false
        return
      }

      if (v.paused) {
        this.safePlay()
        return
      }

      // 正在缓冲：什么都别动，等它自己缓过来
      if (this.buffering || v.readyState < 3) {
        this.catchingUp = true
        return
      }

      const drift = target - v.currentTime
      const abs = Math.abs(drift)

      // 允许 1.2 秒以内的内容差：不 seek、不变速，画面最稳。
      if (abs < 1.2) {
        this.catchingUp = false
        this.setNudgeRate(baseRate)
        return
      }

      // 1.2~4 秒：只做最多 ±3% 的极轻变速，绝不重新加载
      if (abs <= 4) {
        this.catchingUp = true
        const factor = Math.max(-0.03, Math.min(0.03, (abs - 1.2) / 40))
        this.setNudgeRate(baseRate * (drift > 0 ? 1 + factor : 1 - factor))
        return
      }

      // 超过 4 秒才可能硬跳，而且 20 秒内最多一次
      if (!this.canHardSeek(drift)) {
        this.catchingUp = true
        const factor = Math.max(-0.03, Math.min(0.03, drift / 4))
        this.setNudgeRate(baseRate * (1 + factor))
        return
      }

      this.catchingUp = false
      this.setNudgeRate(baseRate)
      this.seekQuiet(target)
    },

    emitControl(action, extra) {
      // 正在被别人操作驱动时不要回环（suppressControl 由 applyXxx 负责开关）
      if (this.suppressControl) return
      if (!this.dp && !this.mpPlayUrl) return
      const opts = extra || {}
      // 人人可控：自己动手后先在本地时间轴上认下来，
      // 否则紧随其后的跟随循环会把自己的暂停 / 拖动立刻拽回去
      this.applyLocalControl(action, opts)
      this.socket.emit('host-control', {
        roomId: this.roomId,
        action,
        // 采样这一刻的服务器时间，服务端据此算出统一的起跑线
        atServer: serverNow(),
        ...opts
      })
    },

    /**
     * 把「自己刚做的操作」写进本地时间轴（乐观更新）。
     * 服务端只负责转告别人，不会再回传给自己，所以这里必须自己算一遍。
     */
    applyLocalControl(action, extra) {
      const prev = this.remoteState
      const base = prev
        ? { time: positionAt(prev), playing: !!prev.playing, rate: Number(prev.rate) || 1 }
        : { time: 0, playing: false, rate: 1 }
      const time = typeof extra.time === 'number' ? extra.time : base.time
      const at = serverNow()
      if (action === 'play') {
        this.remoteState = { time, playing: true, rate: base.rate, at }
      } else if (action === 'pause') {
        this.remoteState = { time, playing: false, rate: base.rate, at }
      } else if (action === 'seek') {
        this.remoteState = { time, playing: base.playing, rate: base.rate, at }
      } else if (action === 'rate') {
        this.remoteState = { time, playing: base.playing, rate: Number(extra.rate) || base.rate, at }
      } else {
        return
      }
      // 刚操作完：比这一刻更旧的同步包不许覆盖，免得画面来回跳一下
      this._localControlAt = at
    },

    onHostPlay() {
      if (this.suppressControl || this._awaitingVideoStart) return
      const t = this.dp.video.currentTime || 0
      // 先暂停本机，等服务端确认观众都 canplay 后统一 video-start；
      // 否则电脑先放、手机还在加载，开头永远对不上。
      this._awaitingVideoStart = true
      this.waitingVideo = true
      this.waitingReady = 0
      this.waitingTotal = 0
      this.suppressControl = true
      clearTimeout(this._videoStartTimer)
      clearTimeout(this._videoWaitClientTimer)
      try { this.dp.video.pause() } catch (e) {}
      setTimeout(() => { this.suppressControl = false }, 400)
      this.socket.emit('host-control', {
        roomId: this.roomId,
        action: 'play',
        time: t,
        wait: true,
        atServer: serverNow()
      })
      // 兜底：服务端/网络异常时别让房主永远停在等待
      this._videoWaitClientTimer = setTimeout(() => {
        if (!this._awaitingVideoStart) return
        this._awaitingVideoStart = false
        this.waitingVideo = false
        this.suppressControl = false
        try { this.dp.video.play() } catch (e) {}
      }, 12000)
    },

    onHostPause() {
      if (this._awaitingVideoStart) return
      this.emitControl('pause', { time: this.dp.video.currentTime })
    },

    onHostSeeked() {
      this.emitControl('seek', { time: this.dp.video.currentTime })
    },

    onHostRatechange() {
      // 跟随方为了追进度会把 playbackRate 微调 ±8%~12%，这同样会触发 ratechange。
      // 那是「内部微调」，不能当成人人可控之后的用户变速广播出去，否则全房速率互相打架。
      if (this._nudgeAt && Date.now() - this._nudgeAt < 400) return
      const rate = this.dp.video.playbackRate
      const base = this.remoteState ? Number(this.remoteState.rate) || 1 : 1
      if (Math.abs(rate - base) < 0.2) return
      this.emitControl('rate', { rate })
    },

    handleHostControl(data) {
      // 人人可控：不管这条指令是房主还是观众发的，都要落到自己身上。
      // 服务端用 socket.to 转发，自己发的不会回来。
      const fromMe = !!(data && data.from && data.from === this.socket.id)
      if (fromMe) return

      // 任何新的播放控制都取消之前等待/预约，避免旧定时器把画面又打开
      clearTimeout(this._videoStartTimer)
      this.waitingVideo = false
      this._awaitingVideoStart = false

      // 新指令先取消旧预约，避免「先预约播放、紧接着暂停」时旧定时器又把播放打开
      clearTimeout(this._pendingControlTimer)
      this._pendingControlUntil = 0

      const prev = this.remoteState
      const playing = data.action === 'play'
        ? true
        : data.action === 'pause'
          ? false
          : (prev ? !!prev.playing : true)
      const rate = typeof data.rate === 'number' ? data.rate : (prev ? prev.rate : 1)
      const time = typeof data.time === 'number'
        ? data.time
        : (prev ? positionAt(prev) : 0)
      // 和昨天能用的版本一致：立即落到播放器，不做预约等待。
      // 晚到的手机只在这里定位一次，之后靠 followTick 平滑追。
      this.applyRemoteControl({
        time,
        playing,
        rate,
        at: Number(data.at) || serverNow()
      }, data)
    },

    handleVideoWaiting(data) {
      this.waitingVideo = true
      this.waitingReady = Number(data && data.ready) || 0
      this.waitingTotal = Number(data && data.total) || 0
    },

    handleVideoStart(data) {
      this.waitingVideo = false
      this._awaitingVideoStart = false
      clearTimeout(this._videoWaitClientTimer)
      clearTimeout(this._videoStartTimer)
      const state = {
        time: Math.max(0, Number(data && data.time) || 0),
        playing: true,
        rate: Number(data && data.rate) || 1,
        at: Number(data && data.at) || serverNow()
      }
      const apply = () => {
        this._videoStartTimer = null
        this.applyRemoteControl(state, { action: 'play' })
        this._initialSynced = true
      }
      const delay = state.at - serverNow()
      if (delay > 30) {
        this._videoStartTimer = setTimeout(apply, Math.min(delay, 5000))
      } else {
        apply()
      }
    },

    applyRemoteControl(state, data) {
      this.remoteState = state
      this._initialSynced = true
      // 别人动手了，自己刚才那次操作的保护窗口立刻作废
      this._localControlAt = 0
      // #ifdef H5
      if (this.dp && this.dp.video) {
        this.suppressControl = true
        clearTimeout(this._suppressTimer)

        const target = positionAt(state)
        if (data.action === 'rate') {
          this.dp.video.playbackRate = state.rate
        } else if (Math.abs(this.dp.video.currentTime - target) > 0.3) {
          this.seekQuiet(target)
        }

        if (state.playing) {
          this.safePlay()
        } else {
          this.dp.pause()
        }

        this._suppressTimer = setTimeout(() => {
          this.suppressControl = false
        }, 500)
      }
      // #endif
      // #ifndef H5
      this.applyMpHostControl({
        ...data,
        time: state.time,
        at: state.at
      })
      // #endif
    },
    handleSync(data) {
      if (this._pendingControlUntil && Date.now() < this._pendingControlUntil) return
      if (this.isController) return
      // 自己刚操作过：比那一刻更旧的同步包是「上一秒的历史」，
      // 拿来用会把自己刚按下的暂停/拖动盖回去，直接丢掉
      const at = Number(data.at) || 0
      if (this._localControlAt && at && at < this._localControlAt) return
      // 只更新「时间轴」，不立刻动手：位置由每秒的校正循环按需微调，
      // 这样网慢的人不会每 5 秒被打断一次缓冲
      const prev = this.remoteState
      this.remoteState = {
        time: Number(data.time) || 0,
        playing: !!data.playing,
        rate: Number(data.rate) || (prev ? prev.rate : 1),
        at: Number(data.at) || 0
      }
      // #ifdef H5
      if (this.dp) this.followTick()
      // #endif
      // #ifndef H5
      this.applyMpSync(data)
      // #endif
    },

    handleMemberUpdated(data) {
      this.memberCount = data.count || 0
    },

    handleHostChanged(data) {
      const isMe = data.hostId === this.socket.id
      this.isHost = isMe
      // 房主换人时不自动抢控制权：控制权只看 controller-changed
      if (this.isController) this.startSyncIfHost()
    },

    handleControllerChanged(data) {
      const isMe = data.controllerId === this.socket.id
      this.isController = isMe
      if (isMe) {
        this.startSyncIfHost()
      } else {
        this.stopSync()
      }
    },

    handleRoomError(data) {
      const message = (data && data.message) || '房间加入失败'
      // 房间本身不存在/满员属于致命问题，其余（例如播放控制被拒）只提示一下
      if (/不存在|已结束|已满|人数已满/.test(message)) {
        this.fatalError = message
      } else {
        this.error = message
      }
      this.loading = false
    },

    startSyncIfHost() {
      if (!this.isController || this.syncTimer) return
      this.syncTimer = setInterval(() => {
        if (!this.dp || !this.socket) return
        const v = this.dp.video
        const time = v.currentTime
        const playing = !v.paused
        const rate = v.playbackRate
        // 掌控者自己卡了：时间轴不能再往前推算，否则别人会被带到「未来的位置」
        const stalled = playing && (this.buffering || v.readyState < 3)
        if (stalled) {
          if (!this._stallSince) this._stallSince = Date.now()
        } else {
          this._stallSince = 0
        }
        const longStall = stalled && Date.now() - this._stallSince > 1500
        this.socket.emit('sync', {
          roomId: this.roomId,
          time,
          playing: playing && !longStall,
          rate,
          atServer: serverNow()
        })
      }, 1500)
    },

    stopSync() {
      if (this.syncTimer) {
        clearInterval(this.syncTimer)
        this.syncTimer = null
      }
    },

    buildShareLink() {
      if (typeof window === 'undefined') return ''
      const { protocol, pathname } = window.location
      // shareBase 优先：可能是公网隧道（https 域名），也可能是局域网 IP
      const base = (this.shareBase || `${protocol}//${window.location.host}`).replace(/\/+$/, '')
      return `${base}${pathname}#/pages/room/room?roomId=${this.roomId}`
    },

    // 分享地址要选「别人真能打开」的那个：
    //   有内网穿透 → 公网域名（家里、外地、4G 流量都能进）
    //   本机 localhost 打开 → 换成本机局域网 IP
    //   已经是域名打开 → 直接用当前域名
    //
    // 具体候选顺序由 utils/share-host.js 统一决定（和五子棋/斗地主/音乐厅共用同一套逻辑，
    // 避免各房间各写一份导致二维码行为不一致）。
    async refreshShareHost() {
      // #ifdef H5
      if (typeof window === 'undefined') return
      try {
        const { bases, tunnelOn } = await resolveShareHosts()
        if (!bases || !bases.length) return
        this.shareBases = bases
        this.shareIndex = 0
        this.tunnelOn = tunnelOn
        this.shareBase = bases[0].base
        this.shareLink = this.buildShareLink()
        this.updateQrcode()
        // 隧道可能比页面晚启动：没拿到公网地址时再补查几次，拿到了就换成公网
        if (!tunnelOn && this.shareRetry < 3) {
          this.shareRetry += 1
          clearTimeout(this.shareRetryTimer)
          this.shareRetryTimer = setTimeout(() => this.refreshShareHost(), 8000)
        }
      } catch (e) {
        console.warn('分享地址解析失败，仍使用当前地址', e)
      }
      // #endif
    },

    // 扫了连不上时，换成下一个候选地址
    cycleShareHost() {
      if (this.shareBases.length < 2) return
      this.shareIndex = (this.shareIndex + 1) % this.shareBases.length
      this.shareBase = this.shareBases[this.shareIndex].base
      this.shareLink = this.buildShareLink()
      this.updateQrcode()
    },

    copyLink() {
      if (!this.shareLink) return
      // #ifdef H5
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(this.shareLink).then(() => {
          uni.showToast({ title: '链接已复制', icon: 'none' })
        })
      } else {
        const ta = document.createElement('textarea')
        ta.value = this.shareLink
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        uni.showToast({ title: '链接已复制', icon: 'none' })
      }
      // #endif
      // #ifndef H5
      uni.setClipboardData({
        data: this.shareLink,
        success: () => {
          uni.showToast({ title: '链接已复制', icon: 'none' })
        }
      })
      // #endif
    },

    updateQrcode() {
      // #ifdef H5
      if (!this.shareLink) return
      // qrcode 库按需加载（23KB），第一次出碼时才下载，之后直接用缓存
      ensureQRCode()
        .then(() => {
          const lib = typeof window !== 'undefined' ? window.QRCode : null
          if (!lib) {
            console.warn('qrcode 库未加载，二维码不可用，可改用“复制分享链接”')
            return
          }
          if (!this.shareLink) return
          // 用 dataURL 渲染 <image>：uni-app H5 的 <canvas> 会被包成 <uni-canvas>，不能当原生 canvas 用
          lib.toDataURL(this.shareLink, { width: 320, margin: 1 }, (err, url) => {
            if (err) {
              console.error('二维码生成失败', err)
              return
            }
            this.qrDataUrl = url
          })
        })
        .catch(() => {
          console.warn('qrcode 库加载失败，二维码不可用，可改用“复制分享链接”')
        })
      // #endif
    },

    // #ifndef H5
    // ---------- 微信小程序端播放器 ----------
    buildMpPlayUrl(video) {
      if (!video || !video.videoUrl) return ''
      // 网页嵌入模式小程序端放不了，交由模板给出提示
      if (video.kind === 'embed') return ''
      if (!video.isHls && /\.m3u8(\?|$)/i.test(video.videoUrl)) return ''
      if (video.isHls) return ''
      return this.buildPlayUrl(video)
    },

    getMpVideoContext() {
      if (this._mpVideoCtx) return this._mpVideoCtx
      this._mpVideoCtx = uni.createVideoContext('mp-video', this)
      return this._mpVideoCtx
    },

    applyMpState(state) {
      const ctx = this.getMpVideoContext()
      if (!ctx) return
      this.suppressControl = true
      clearTimeout(this._suppressTimer)
      if (typeof state.time === 'number' && typeof this._mpTime === 'number' && Math.abs(this._mpTime - state.time) > 0.5) {
        ctx.seek(state.time)
      }
      if (state.rate && this._mpRate && Math.abs(this._mpRate - state.rate) > 0.01) {
        ctx.playbackRate(state.rate)
      }
      if (state.playing) {
        ctx.play()
      } else {
        ctx.pause()
      }
      this._suppressTimer = setTimeout(() => {
        this.suppressControl = false
      }, 500)
    },

    applyMpHostControl(data) {
      const ctx = this.getMpVideoContext()
      if (!ctx) return
      this.suppressControl = true
      clearTimeout(this._suppressTimer)
      if (data.action === 'play') {
        if (typeof data.time === 'number') ctx.seek(data.time)
        ctx.play()
      } else if (data.action === 'pause') {
        if (typeof data.time === 'number') ctx.seek(data.time)
        ctx.pause()
      } else if (data.action === 'seek') {
        if (typeof data.time === 'number') ctx.seek(data.time)
      } else if (data.action === 'rate') {
        if (typeof data.rate === 'number') ctx.playbackRate(data.rate)
      }
      this._suppressTimer = setTimeout(() => {
        this.suppressControl = false
      }, 500)
    },

    applyMpSync(data) {
      const ctx = this.getMpVideoContext()
      if (!ctx) return
      const { time, playing, rate } = data
      this.suppressControl = true
      clearTimeout(this._suppressTimer)
      if (rate && this._mpRate && Math.abs(this._mpRate - rate) > 0.01) {
        ctx.playbackRate(rate)
      }
      if (typeof time === 'number' && typeof this._mpTime === 'number' && Math.abs(this._mpTime - time) > 1.5) {
        ctx.seek(time)
      }
      if (playing) {
        ctx.play()
      } else {
        ctx.pause()
      }
      this._suppressTimer = setTimeout(() => {
        this.suppressControl = false
      }, 300)
    },

    onMpPlay(e) {
      this._mpTime = (e && e.detail && e.detail.currentTime) || 0
      this._mpPaused = false
      this.emitControl('play', { time: this._mpTime })
    },

    onMpPause(e) {
      this._mpTime = (e && e.detail && e.detail.currentTime) || 0
      this._mpPaused = true
      this.emitControl('pause', { time: this._mpTime })
    },


    onMpTimeupdate(e) {
      const t = (e && e.detail && e.detail.currentTime) || 0
      this._mpTime = t
      const now = Date.now()
      if (!this._mpLastSync || now - this._mpLastSync > 5000) {
        this._mpLastSync = now
        if (this.socket && this.roomId) {
          this.socket.emit('sync', {
            roomId: this.roomId,
            time: t,
            playing: !this._mpPaused,
            rate: this._mpRate || 1
          })
        }
      }
    },
    // #endif

    cleanup() {
      this.stopSync()
      this.stopFollowLoop()
      this._pendingControlUntil = 0
      clearTimeout(this._pendingControlTimer)
      stopClockSync()
      clearTimeout(this.shareRetryTimer)
      this.shareRetryTimer = null
      if (this.socket) {
        this.socket.off('room-state', this.handleRoomState)
        this.socket.off('host-control', this.handleHostControl)
        this.socket.off('video-waiting', this.handleVideoWaiting)
        this.socket.off('video-start', this.handleVideoStart)
        this.socket.off('sync', this.handleSync)
        this.socket.off('member-updated', this.handleMemberUpdated)
        this.socket.off('host-changed', this.handleHostChanged)
        this.socket.off('room-error', this.handleRoomError)
          this.socket.off('connect', this.handleConnect)
          this.socket.off('disconnect', this.handleDisconnect)
          this.socket.off('video-updated', this.handleVideoUpdated)
          this.socket.off('controller-changed', this.handleControllerChanged)
        // 离开房间，避免人数统计不准确
        this.socket.emit('leave-room', { roomId: this.roomId })
      }
      if (this.dp) {
        this.dp.destroy()
        this.dp = null
      }
      if (this._hls) {
        this._hls.destroy()
        this._hls = null
      }
      clearTimeout(this._suppressTimer)
    }
  }
}
</script>

<style scoped>
.room-page {
  padding: 16px;
  /* 宽屏下别把播放器和信息卡拉满整屏 */
  max-width: 1000px;
  margin: 0 auto;
  box-sizing: border-box;
}

.video-card {
  padding: 12px;
  overflow: hidden;
}

.video-title {
  font-size: 15px;
  font-weight: 700;
  color: #14342a;
  margin: 2px 4px 10px;
  letter-spacing: 0.2px;
}

.section-title {
  display: block;
  font-size: 15px;
  font-weight: 700;
  color: #14342a;
  margin-bottom: 12px;
}

.part-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-radius: 12px;
  background: #f7fcf9;
  margin-bottom: 8px;
  cursor: pointer;
  border: 1px solid rgba(16, 122, 86, 0.1);
  transition: background 0.18s ease, border-color 0.18s ease;
}

.part-item.active {
  background: #e6f8ee;
  border-color: rgba(16, 157, 99, 0.42);
}

.part-name {
  font-size: 14px;
  color: #37584a;
}

.part-item.active .part-name {
  color: #0b7a4c;
  font-weight: 700;
}

.part-duration {
  font-size: 12px;
  color: #8aa89b;
}

.dplayer {
  width: 100%;
  height: 420px;
  border-radius: 12px;
  overflow: hidden;
  background: #000;
}

/* 网页嵌入模式：站点不给流时整页嵌进来 */
.embed-wrap {
  width: 100%;
  height: 420px;
  border-radius: 12px;
  overflow: hidden;
  background: #000;
}

.embed-frame {
  width: 100%;
  height: 100%;
}

.embed-tip {
  margin-top: 10px;
  padding: 9px 12px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.6;
  color: #8a5a12;
  background: #fff8e8;
  border: 1px solid rgba(217, 152, 36, 0.28);
}

.link-hint {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.6;
  color: #8aa89b;
}

.mp-video {
  width: 100%;
  height: 240px;
  border-radius: 8px;
  background: #000;
}

.mp-video-tip {
  padding: 40px 16px;
  text-align: center;
  color: #6b8a7c;
  font-size: 13px;
  background: #f7fcf9;
  border-radius: 12px;
}

.sync-tip {
  margin-top: 10px;
  font-size: 12px;
  color: #6b8a7c;
  text-align: center;
}

.loading {
  text-align: center;
  padding: 80px 0;
  color: #6b8a7c;
  font-size: 14px;
}

.error {
  background: #fdecec;
  border: 1px solid rgba(217, 83, 79, 0.24);
  color: #c0392b;
  border-radius: 14px;
  padding: 14px 16px;
  font-size: 13px;
  line-height: 1.6;
}

.error-inline {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 12px;
  padding: 11px 13px;
  border-radius: 12px;
  background: #fdecec;
  border: 1px solid rgba(217, 83, 79, 0.22);
}

.error-inline-text {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: #c0392b;
  white-space: normal;
  word-break: break-word;
}

.error-inline-close {
  flex: 0 0 auto;
  font-size: 16px;
  line-height: 1.2;
  color: rgba(192, 57, 43, 0.6);
  padding: 0 2px;
}

.room-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}

.label {
  font-size: 11px;
  letter-spacing: 0.12em;
  color: #8aa89b;
}

.room-id {
  font-size: 30px;
  font-weight: 800;
  letter-spacing: 4px;
  color: #0f7a4f;
}

.badge {
  background: #f1faf5;
  border: 1px solid rgba(16, 122, 86, 0.16);
  color: #37584a;
  border-radius: 999px;
  padding: 6px 16px;
  font-size: 13px;
}

.badge.host {
  background: linear-gradient(135deg, #34d399 0%, #0f9d63 100%);
  border-color: transparent;
  color: #ffffff;
  font-weight: 600;
  box-shadow: 0 8px 18px -12px rgba(15, 157, 99, 0.9);
}

.badge-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.badge.control {
  background: #e6f8ee;
  border-color: rgba(16, 157, 99, 0.4);
  color: #0b7a4c;
  font-weight: 600;
}

.meta-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  color: #5c7c6d;
  font-size: 13.5px;
  margin-bottom: 10px;
}

.copy-btn {
  color: #0b7a4c;
  cursor: pointer;
  font-size: 12.5px;
  font-weight: 600;
  padding: 5px 12px;
  border-radius: 999px;
  background: #e8f7ef;
  border: 1px solid rgba(16, 157, 99, 0.26);
  transition: background 0.18s ease, transform 0.18s ease;
}

.copy-btn:active {
  transform: scale(0.97);
  background: #d9f2e5;
}

.share-link {
  word-break: break-all;
  background: #f7fcf9;
  border: 1px solid rgba(16, 122, 86, 0.12);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 11.5px;
  line-height: 1.6;
  color: #5c7c6d;
}

/* 多网卡 / 公网隧道时切换二维码用的地址 */
.share-switch {
  margin-top: 10px;
  text-align: center;
  font-size: 11.5px;
  color: #0b7a4c;
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: rgba(16, 157, 99, 0.35);
  cursor: pointer;
  transition: color 0.2s ease;
}

.share-switch:hover,
.share-switch:active {
  color: #0f9d63;
}

/* 公网隧道启用时的提示条 */
.share-tip {
  margin-top: 10px;
  padding: 7px 10px;
  border-radius: 9px;
  font-size: 11.5px;
  line-height: 1.5;
  color: #0b7a4c;
  background: #e8f7ef;
  border: 1px solid rgba(16, 157, 99, 0.24);
  text-align: center;
}

.qrcode-wrap {
  margin-top: 16px;
  text-align: center;
}

/* 二维码必须留白底，四周留够静区才好扫 */
.qrcode-img {
  background: #fff;
  padding: 10px;
  border-radius: 14px;
  border: 1px solid rgba(16, 122, 86, 0.12);
  box-shadow: 0 12px 28px -18px rgba(13, 84, 60, 0.6);
}

.qrcode-tip {
  font-size: 12px;
  color: #8aa89b;
  margin-top: 6px;
}

  .connection-tip {
    background: #fff8e8;
    border: 1px solid rgba(217, 152, 36, 0.28);
    color: #8a5a12;
    border-radius: 12px;
    padding: 10px 14px;
    margin-bottom: 12px;
    font-size: 12.5px;
    line-height: 1.6;
    text-align: center;
  }

  .add-video {
    padding: 4px 0;
  }

    .link-actions {
      display: flex;
      align-items: stretch;
      gap: 10px;
      margin-bottom: 10px;
    }

    .link-actions .gl-input {
      flex: 1;
      min-width: 0;
      margin-bottom: 0;
    }

    .btn-secondary {
      background: #f1faf5;
      color: #0b7a4c;
      border: 1px solid rgba(16, 157, 99, 0.24);
      border-radius: 12px;
      padding: 12px 24px;
      font-size: 16px;
      cursor: pointer;
      flex-shrink: 0;
    }

  .divider {
    text-align: center;
    color: #9ab5a7;
    margin: 12px 0;
    font-size: 13px;
  }

  .file-input {
    width: 100%;
    box-sizing: border-box;
    padding: 8px;
    border: 1px dashed rgba(16, 122, 86, 0.24);
    border-radius: 8px;
    background: #f7fcf9;
    font-size: 13px;
    margin-bottom: 10px;
  }

  .file-info {
    margin-bottom: 10px;
    color: #5c7c6d;
    font-size: 13px;
  }

  .wait-video {
    text-align: center;
    color: #6b8a7c;
    padding: 40px 0;
    font-size: 13.5px;
  }

@media (max-width: 600px) {
  .dplayer {
    height: 240px;
  }

  .embed-wrap {
    height: 260px;
  }
}

.qrcode-img {
  width: 160px;
  height: 160px;
  display: inline-block;
}

.tap-to-play {
  margin-top: 10px;
  padding: 12px;
  text-align: center;
  color: #ffffff;
  font-weight: 600;
  font-size: 14px;
  background: linear-gradient(135deg, #34d399 0%, #0f9d63 100%);
  border: none;
  border-radius: 12px;
  cursor: pointer;
  box-shadow: 0 12px 24px -14px rgba(15, 157, 99, 0.9);
}

/* ===== 深海覆盖 ===== */
.video-title,
.section-title { color: var(--c-text); }

.part-item {
  background: rgba(11, 23, 48, 0.72);
  border-color: rgba(184, 198, 255, 0.14);
}
.part-item.active {
  background: rgba(77, 107, 254, 0.18);
  border-color: rgba(110, 231, 255, 0.4);
}
.part-name { color: var(--c-text-2); }
.part-item.active .part-name { color: var(--c-text); }
.part-duration { color: var(--c-text-3); }

.label { color: var(--c-text-3); }
.room-id { color: var(--c-primary-soft); letter-spacing: 5px; }

.badge {
  background: rgba(184, 198, 255, 0.07);
  border-color: rgba(184, 198, 255, 0.18);
  color: var(--c-text-2);
}
.badge.host {
  background: linear-gradient(135deg, #6d8bff 0%, #4d6bfe 100%);
  color: #ffffff;
  box-shadow: 0 8px 18px -12px rgba(77, 107, 254, 0.9);
}
.badge.control {
  background: rgba(77, 107, 254, 0.2);
  border-color: rgba(110, 231, 255, 0.4);
  color: #bfe9ff;
}

.meta-row { color: var(--c-text-2); }
.copy-btn {
  color: #bfe9ff;
  background: rgba(77, 107, 254, 0.16);
  border-color: rgba(110, 231, 255, 0.28);
}
.copy-btn:active { background: rgba(77, 107, 254, 0.26); }

.share-link {
  background: #0a1428;
  border-color: rgba(184, 198, 255, 0.14);
  color: var(--c-text-2);
}
.share-switch { color: var(--c-primary-soft); text-decoration-color: rgba(110, 231, 255, 0.35); }
.share-switch:hover,
.share-switch:active { color: #bfe9ff; }

.share-tip {
  color: #bfe9ff;
  background: rgba(77, 107, 254, 0.14);
  border-color: rgba(110, 231, 255, 0.26);
}

.qrcode-img { border-color: rgba(184, 198, 255, 0.2); box-shadow: 0 14px 30px -22px rgba(0, 0, 0, 0.9); }
.qrcode-tip { color: var(--c-text-3); }

.connection-tip {
  background: rgba(224, 165, 46, 0.1);
  border-color: rgba(224, 165, 46, 0.28);
  color: #f4d48a;
}

.embed-tip {
  background: rgba(224, 165, 46, 0.1);
  border-color: rgba(224, 165, 46, 0.28);
  color: #f4d48a;
}

.link-hint,
.sync-tip,
.loading,
.wait-video,
.mp-video-tip { color: var(--c-text-3); }
.mp-video-tip { background: #0a1428; }

.error,
.error-inline {
  background: rgba(255, 107, 138, 0.1);
  border-color: rgba(255, 107, 138, 0.26);
  color: #ffb3c1;
}
.error-inline-text { color: #ffb3c1; }
.error-inline-close { color: rgba(255, 179, 193, 0.7); }

.btn-secondary {
  background: rgba(184, 198, 255, 0.07);
  color: var(--c-text);
  border-color: rgba(184, 198, 255, 0.2);
}

.divider { color: var(--c-text-3); }
.file-input {
  background: #0a1428;
  border-color: rgba(184, 198, 255, 0.24);
  color: var(--c-text);
}
.file-info { color: var(--c-text-2); }

.tap-to-play {
  background: linear-gradient(135deg, #6d8bff 0%, #4d6bfe 100%);
  box-shadow: 0 12px 24px -14px rgba(77, 107, 254, 0.9);
}

/* ============================================================
   编辑式压平：影院房的大卡片改成细线分节
   ============================================================ */
.room-page .gl-card {
  background: transparent;
  border: 0;
  border-top: 1px solid rgba(184, 198, 255, 0.16);
  border-radius: 0;
  box-shadow: none;
  padding: 22px 0;
  margin: 0 0 6px;
}

.room-page .gl-card::before {
  display: none;
}

.room-page .video-card {
  padding-top: 0;
  border-top: 0;
}

.room-page .room-id {
  font-size: clamp(2.6rem, 6vw, 4rem);
  font-weight: 300;
  letter-spacing: 0.12em;
  line-height: 1.1;
  color: var(--c-primary-soft);
}

.room-page .badge {
  background: transparent;
  border: 1px solid rgba(184, 198, 255, 0.22);
  border-radius: 999px;
  color: var(--c-text-2);
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  padding: 5px 12px;
}

.room-page .badge.host {
  background: transparent;
  border-color: rgba(110, 231, 255, 0.5);
  color: var(--c-primary-soft);
  box-shadow: none;
}

.room-page .badge.control {
  background: transparent;
  border-color: rgba(110, 231, 255, 0.42);
  color: var(--c-primary-soft);
}

.room-page .gl-input {
  height: 46px;
  line-height: 46px;
  padding: 0;
  border: 0;
  border-bottom: 1px solid rgba(184, 198, 255, 0.22);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.room-page .gl-btn {
  display: inline-block;
  width: auto;
  height: auto;
  line-height: 1.4;
  padding: 8px 0;
  background: transparent;
  border: 0;
  box-shadow: none;
  color: var(--c-primary-soft);
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.08em;
  text-decoration: underline;
  text-underline-offset: 4px;
  text-decoration-color: rgba(110, 231, 255, 0.35);
}

.room-page .gl-btn:active {
  background: transparent;
  box-shadow: none;
  opacity: 0.65;
}

.room-page .section-title {
  font-weight: 300;
  font-size: 1.15rem;
  letter-spacing: 0.04em;
}

.room-page .copy-btn {
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(110, 231, 255, 0.4);
  border-radius: 0;
  padding: 6px 0;
  color: var(--c-primary-soft);
}

.room-page .copy-btn:active {
  background: transparent;
  opacity: 0.65;
}

/* 主操作小圆角 */
.room-page .gl-btn {
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
}

.room-page .gl-btn:active {
  transform: scale(0.98);
  background: rgba(77, 107, 254, 0.24);
  opacity: 1;
}

.room-page .copy-btn {
  background: rgba(77, 107, 254, 0.12);
  border: 1px solid rgba(110, 231, 255, 0.28);
  border-radius: 10px;
  padding: 7px 14px;
  color: var(--c-text);
  text-decoration: none;
  font-size: 12px;
}

.room-page .copy-btn:active {
  background: rgba(77, 107, 254, 0.22);
  opacity: 1;
}


</style>
