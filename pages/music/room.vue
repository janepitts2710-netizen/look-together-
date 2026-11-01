<template>
  <view class="container music-room-page">
    <aurora-bg />
    <ann-banner />
    <view v-if="error" class="error">{{ error }}</view>
    <view v-else-if="loading" class="loading">正在连接房间...</view>

    <view v-else>
      <view class="top-bar">
        <button class="btn-back" @click="back">返回</button>
        <view class="tb-center">
          <text class="room-title">星梦听歌房</text>
          <!-- #ifdef H5 -->
          <button
            class="btn-local"
            hover-class="btn-local--active"
            title="导入本地音频文件"
            @click="pickLocalAudio"
          >
            <text class="btn-local-inner">{{ localUploading ? localUploadPercent + '%' : '＋' }}</text>
          </button>
          <!-- #endif -->
        </view>
        <view class="room-id">{{ room.id }}</view>
      </view>

      <!-- 邀请卡片：只有房主才显示（访客扫码进来后不需要再邀请别人，也免得占满手机屏幕） -->
      <share-qr
        v-if="isHost"
        :room-id="(room && room.id) || ''"
        page-path="/pages/music/room"
        title="扫码一起听"
        subtitle="好友扫码直接进房，播放进度实时同步"
      />

      <!-- 本地上传进度（浮在顶栏下方，不挡播放器操作） -->
      <view v-if="localUploading" class="upload-float">
        <view class="upload-float-head">
          <text class="upload-float-name">{{ localUploadName || '本地音频' }}</text>
          <text class="upload-float-pct">{{ localUploadPercent }}%</text>
        </view>
        <view class="upload-float-bar">
          <view class="upload-float-fill" :style="{ width: localUploadPercent + '%' }"></view>
        </view>
        <text class="upload-float-tip">正在上传到本房间，完成后自动加入播放队列</text>
      </view>

      <view class="room-layout">
        <!-- 左栏：播放器 + 推荐 + 搜索 -->
        <view class="room-main">

          <view class="card now-playing" :class="{ 'is-playing': playing }">
            <view class="np-head">
              <text class="np-label">正在播放</text>
              <text class="np-badge" :class="{ 'is-playing': playing }">{{ playing ? '播放中' : '已暂停' }}</text>
            </view>

            <!-- 点击空白/封面区域：封面 ⇄ 歌词 -->
            <view class="np-stage" :class="{ 'show-lyrics': showLyrics }" @click="toggleLyrics">
              <view v-show="!showLyrics" class="disc-wrap">
                <view class="disc" :class="{ 'is-playing': playing }">
                  <image v-if="currentSong && currentSong.pic" class="disc-cover" :src="coverUrl(currentSong.pic)" mode="aspectFill" />
                  <view v-else class="disc-core">
                    <view class="eq">
                      <view v-for="n in 5" :key="n" class="eq-bar" :style="{ animationDelay: (n * 0.12) + 's' }"></view>
                    </view>
                  </view>
                </view>
              </view>

              <view v-if="showLyrics" class="lyric-wrap">
                <scroll-view
                  class="lyric-scroll"
                  scroll-y
                  :scroll-top="lyricScrollTop"
                  :scroll-with-animation="true"
                >
                  <view class="lyric-spacer"></view>
                  <view
                    v-for="(line, i) in lyricLines"
                    :key="'l' + i"
                    class="lyric-line"
                    :class="{ active: i === activeLyricIndex }"
                    @click.stop="seekToLyric(i)"
                  >{{ line.text }}</view>
                  <view class="lyric-spacer"></view>
                </scroll-view>

                <view v-if="!lyricLines.length" class="lyric-empty">
                  <text v-if="lyricLoading">歌词加载中…</text>
                  <text v-else-if="lyricError">{{ lyricError }}</text>
                  <text v-else-if="!currentSong">暂无歌曲</text>
                  <text v-else>这首歌暂无歌词</text>
                </view>
              </view>

              <view v-if="!showLyrics" class="np-hint">轻点看歌词</view>
              <view v-else class="np-hint np-hint--lyric" @click.stop="toggleLyrics">轻点歌词跳转 · 收起</view>

              <!-- 一起听的入口：手机浏览器没有用户点击就不许出声，
                   所以访客先点「准备」，房门这边等他准备好，再定一个共同的开播时刻 -->
              <view v-if="gateMode === 'ready'" class="play-gate" @click.stop="becomeReady">
                <view class="play-gate-btn">▶</view>
                <text class="play-gate-text">点一下，准备一起听</text>
                <text class="play-gate-sub">准备好后房主一按播放，两边同时响</text>
              </view>

              <view v-else-if="gateMode === 'loading'" class="play-gate play-gate--wait">
                <view class="play-gate-spin"></view>
                <text class="play-gate-text">正在加载这首歌…</text>
                <text class="play-gate-sub">加载好会自动告诉房主</text>
              </view>

              <view v-else-if="gateMode === 'waiting'" class="play-gate play-gate--wait">
                <view class="play-gate-spin"></view>
                <text class="play-gate-text">{{ isHost ? '等好友准备好…' : '已准备好，等房主开始' }}</text>
                <text class="play-gate-sub">{{ isHost ? '已就绪 ' + readyCount + '/' + (guestCount + 1) + ' 人，都好了就一起开始' : '房主一按播放，两边同时开始' }}</text>
              </view>

              <view v-else-if="gateMode === 'countdown'" class="play-gate play-gate--count">
                <text class="play-gate-num">{{ startingIn }}</text>
                <text class="play-gate-text">马上一起播放</text>
              </view>

              <view v-else-if="gateMode === 'blocked'" class="play-gate" @click.stop="resumeAudio">
                <view class="play-gate-btn">▶</view>
                <text class="play-gate-text">点一下开始播放</text>
                <text class="play-gate-sub">手机需要一次点击才允许出声</text>
              </view>
            </view>

            <view class="song-info">
              <text class="song-title">{{ currentSong ? currentSong.title : '暂无歌曲' }}</text>
              <text class="song-artist">{{ currentSong && currentSong.author ? currentSong.author : '星梦音乐厅' }}</text>
            </view>

            <view class="progress-block">
              <slider
                class="progress"
                :value="seeking ? seekValue : time"
                :max="maxTime"
                activeColor="#6ee7ff"
                backgroundColor="#20305a"
                block-color="#e6ecff"
                :block-size="22"
                @changing="onSeeking"
                @change="onSeek"
              />
              <view class="time-row">
                <text>{{ formatTime(seeking ? seekValue : time) }}</text>
                <text>{{ currentSong ? formatTime(currentSong.duration || 0) : '--:--' }}</text>
              </view>
            </view>

            <view class="player-controls">
              <button class="control-btn" hover-class="control-btn--pressed" @click="prevSong">
                <text class="ctrl-icon ctrl-prev">◀◀</text>
              </button>
              <button class="control-btn main" hover-class="control-btn--pressed" @click="togglePlay">
                <text class="ctrl-icon">{{ playing ? '❚❚' : '▶' }}</text>
              </button>
              <button class="control-btn" hover-class="control-btn--pressed" @click="nextSong">
                <text class="ctrl-icon ctrl-next">▶▶</text>
              </button>
            </view>

            <!-- #ifdef H5 -->
            <view class="kbd-hint"><text class="kbd">Space</text> 播放 / 暂停</view>
            <!-- #endif -->
          </view>

          <view class="card">
            <view class="section-title">搜索点歌</view>
            <view class="search-row">
              <input class="input-field search-input" v-model="searchKeyword" placeholder="输入歌名 / 歌手搜索" @confirm="searchMusic" placeholder-style="color:#7f93c4" />
              <button class="btn-secondary search-btn" @click="searchMusic">搜索</button>
            </view>
            <view v-if="searching" class="search-tip">搜索中...</view>
            <view v-else-if="!searchResults.length" class="empty-hint">
              <text class="empty-icon">⌕</text>
              <text>输入歌名或歌手，搜索后点「点歌」加入队列</text>
            </view>
            <view v-for="item in searchResults" :key="item.id || item.title" class="search-item">
              <image v-if="item.pic" class="search-cover" :src="coverUrl(item.pic)" mode="aspectFill" />
              <view v-else class="search-cover placeholder">♪</view>
              <view class="queue-info">
                <text class="queue-title">{{ item.title }}</text>
                <text class="queue-sub">{{ songSubtitle(item) }}</text>
              </view>
              <button class="queue-remove" :disabled="addingSongId === item.id" @click="addSearchSong(item)">{{ addingSongId === item.id ? '获取中…' : '点歌' }}</button>
            </view>
          </view>

          <view class="card">
            <view class="section-title">今日歌曲推荐</view>
            <view v-if="loadingRecommend" class="search-tip">正在加载今日推荐...</view>
            <view v-else-if="!recommendSongs.length" class="empty-hint">
              今日推荐暂时加载失败，稍后再试试
            </view>
            <view v-for="item in recommendSongs" :key="item.id || item.title" class="search-item">
              <image v-if="item.pic" class="search-cover" :src="coverUrl(item.pic)" mode="aspectFill" />
              <view v-else class="search-cover placeholder">♪</view>
              <view class="queue-info">
                <text class="queue-title">{{ item.title }}</text>
                <text class="queue-sub">{{ songSubtitle(item) }}</text>
              </view>
              <button class="queue-remove" :disabled="addingSongId === item.id" @click="addSearchSong(item)">{{ addingSongId === item.id ? '获取中…' : '点歌' }}</button>
            </view>
          </view>

        </view>
        <!-- /room-main -->

        <!-- 右栏：播放队列（宽屏常驻，窄屏落到播放器下方） -->
        <view class="room-side">
          <view class="card queue-card">
            <view class="section-title">播放队列 <text class="my-count">（我点了 {{ mySongCount }} 首）</text></view>
            <view v-if="!queue.length" class="empty-queue">
              <text class="empty-icon">♪</text>
              <text class="empty-title">队列空空如也</text>
              <text class="empty-desc">去搜索点歌或查看推荐，加入队列开始听歌</text>
            </view>
            <view
              v-for="(song, index) in queue"
              :key="song.id"
              class="queue-item"
              :class="{ active: index === currentIndex }"
              hover-class="queue-item--hover"
              :hover-stay-time="80"
              @click="playFromQueue(index)"
            >
              <view class="queue-index">
                <view v-if="index === currentIndex" class="queue-bars" :class="{ paused: !playing }">
                  <view v-for="n in 3" :key="n" class="queue-bar" :style="{ animationDelay: (n - 1) * 0.16 + 's' }"></view>
                </view>
                <text v-else class="queue-num">{{ index + 1 }}</text>
              </view>
              <image v-if="song.pic" class="queue-cover" :src="coverUrl(song.pic)" mode="aspectFill" />
              <view v-else class="queue-cover placeholder">♪</view>
              <view class="queue-info">
                <text class="queue-title">{{ song.title }}</text>
                <text class="queue-sub">{{ songSubtitle(song) }}</text>
              </view>
              <text v-if="index === currentIndex" class="queue-now">{{ playing ? '播放中' : '已暂停' }}</text>
              <button
                v-else-if="isHost"
                class="queue-remove"
                hover-class="queue-remove--pressed"
                @click.stop="removeSong(index)"
              >删除</button>
            </view>
          </view>
        </view>
        <!-- /room-side -->
      </view>
      <!-- /room-layout -->
    </view>
  </view>
</template>

<script>
import { getSocket, getServerBase } from '../../utils/socket.js'
import { requestJSON } from '../../utils/request.js'
import { serverNow, positionAt, startClockSync, stopClockSync } from '../../utils/clock.js'

// LRC 里的制作信息行（作词/作曲/录音/出品人…）不算歌词：
// 判断方式是「冒号前那一小段能不能被角色词完整吃掉」，比单纯匹配关键词更不容易误伤歌词
const ROLE_ONLY = /^((作词|作曲|编曲|制作人|制作|和声|录音|混音|母带|监制|出品人|出品方|出品|发行|统筹|企划|策划|吉他|贝斯|鼓|键盘|弦乐|器乐|演唱|原唱|演唱者|人声|伴唱|合唱|口琴|小提琴|大提琴|钢琴|二胡|古筝|琵琶|词|曲|OP|SP|lyricist|composer|arranger|producer|mixing|mastering|vocals|guitar|bass|drums))+$/i

function isCreditLine(text) {
  const m = text.match(/^([^:：]{1,24})[:：]/)
  if (!m) return false
  const head = m[1].replace(/[\s/、＆&·,，]/g, '')
  return !!head && ROLE_ONLY.test(head)
}

export default {
  data() {
    return {
      socket: null,
      room: null,
      isHost: false,
      loading: true,
      error: '',
      queue: [],
      currentIndex: -1,
      playing: false,
      time: 0,
      seeking: false,
      seekValue: 0,
      seekSeq: 0,
      autoplayBlocked: false,
      // 「准备一起听」：手机不给用户点击就没声音，所以访客要先点一次。
      // 这一步同时告诉房主「我加载好了，可以开始」。
      myReady: false,
      // 房主已按播放，正在等别人准备好
      waitingStart: false,
      readyCount: 1,
      guestCount: 0,
      // 预约开播倒计时（秒），到 0 的那一刻两边一起出声
      startingIn: 0,
      // 已预约开播、还没到点（长 setTimeout 已换成逐帧盯表，需要一个稳定的标志位）
      startArmed: false,
      // 点了准备、正在等音频缓冲好
      preparing: false,
      songUrl: '',
      // 本地音频导入（H5）：选择 → 上传 → 自动加入队列
      localUploading: false,
      localUploadName: '',
      localUploadPercent: 0,
      audio: null,
      syncTimer: null,
      // 服务端时间轴：time 是 syncedAt 那一刻的进度，之后按这速度往前走
      remoteState: null,
      // 缓冲中就先别动，免得把已经下好的数据打断
      buffering: false,
      catchingUp: false,
      followTimer: null,
      // 出声守护：房主和访客都要跑，只认「真的在播」这个事实
      gateTimer: null,
      loadTimer: null,
      searchKeyword: '',
      searchResults: [],
      searching: false,
      // 正在取播放地址的那首歌（点歌要等服务端探一次，慢的时候好几秒，得给个反馈）
      addingSongId: '',
      searchServer: 'netease',
      mySongCount: 0,
      recommendSongs: [],
      loadingRecommend: false,
      showLyrics: false,
      enterQuery: null,
      lyricLines: [],
      lyricSongId: '',
      lyricLoading: false,
      lyricError: '',
      lyricScrollTop: 0,
      lyricOffsets: [],
      lyricHeights: [],
      lyricViewH: 0,
      lyricSpacerH: 88,
      // 空格键快捷键（仅 H5 桌面端）
      spaceKeyBound: false
    }
  },

  computed: {
    currentSong() {
      return this.queue[this.currentIndex] || null
    },
    // 访客还没点过「准备」：这时候放不出声，必须先给按钮
    needGesture() {
      return !this.isHost && !this.myReady
    },
    // 唱片上的覆盖层：要准备 / 等开播 / 倒计时，三种状态共用一块区域
    gateMode() {
      // 还没点过准备：有歌就先把「准备」按钮亮出来，别等到播放时才让人找
      if (this.needGesture) return (this.currentSong || this.queue.length) ? 'ready' : ''
      if (this.preparing) return 'loading'
      if (this.waitingStart) return 'waiting'
      if (this.startingIn > 0) return 'countdown'
      if (this.autoplayBlocked) return 'blocked'
      return ''
    },
    maxTime() {
      return this.currentSong && this.currentSong.duration ? this.currentSong.duration : 9999
    },
    // 当前唱到哪一句（没有歌词返回 -1）
    activeLyricIndex() {
      const lines = this.lyricLines
      if (!lines.length) return -1
      const t = this.time + 0.25
      let idx = 0
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].time <= t) idx = i
        else break
      }
      return idx
    }
  },

  watch: {
    currentSong(song) {
      // 同一个队列项（歌曲对象每次广播都会重建，只有 url 被补全过）不算换歌，
      // 否则歌词面板每 2.5 秒被重置一次滚动位置
      const queueItemId = song ? String(song.id || '') : ''
      if (queueItemId && queueItemId === this._lastQueueItemId) return
      this._lastQueueItemId = queueItemId
      const id = this.lyricIdFor(song)
      if (id && id === this.lyricSongId) return
      // 换歌：清掉旧歌词，歌词面板开着的话直接拉新的
      this.lyricLines = []
      this.lyricError = ''
      this.lyricSongId = ''
      this.lyricOffsets = []
      this.lyricHeights = []
      this.lyricScrollTop = 0
      if (this.showLyrics && id) this.loadLyric()
    },
    // 唱到新的一句：把它滚到面板正中间
    activeLyricIndex() {
      this.syncLyricScroll()
    }
  },

  onLoad(query) {
    this.socket = getSocket()
    this.enterQuery = query || {}
    this.bindEvents()
    this.socket.connect()
    this.loadTimer = setTimeout(() => {
      if (this.loading) {
        this.loading = false
        this.error = '加载房间超时，请检查房间号是否正确，或稍后重试'
      }
    }, 8000)

    // 连接（含断线重连）后都尝试进房：socket 若在进房前掉过一次，重连后还能自动补上
    this.socket.on('connect', this.ensureEntered)
    if (this.socket.connected) this.ensureEntered()
  },

  onShow() {
    this.bindSpaceKey()
  },

  onHide() {
    this.unbindSpaceKey()
  },

  onUnload() {
    this.unbindSpaceKey()
    this.clearLoadTimer()
    this.clearStartTimers()
    if (this.syncTimer) clearInterval(this.syncTimer)
    if (this.gateTimer) {
      clearInterval(this.gateTimer)
      this.gateTimer = null
    }
    this.stopFollowLoop()
    stopClockSync()
    if (this.audio) {
      this.audio.stop()
      this.audio.destroy()
      this.audio = null
    }
    if (this.room) {
      this.socket.emit('music-leave', { roomId: this.room.id })
    }
    this.unbindEvents()
  },

  methods: {
    // ---------- 空格键：播放 / 暂停 ----------
    bindSpaceKey() {
      if (typeof window === 'undefined' || this.spaceKeyBound) return
      window.addEventListener('keydown', this.handleSpaceKey)
      this.spaceKeyBound = true
    },

    unbindSpaceKey() {
      if (typeof window === 'undefined' || !this.spaceKeyBound) return
      window.removeEventListener('keydown', this.handleSpaceKey)
      this.spaceKeyBound = false
    },

    handleSpaceKey(e) {
      if (!e || e.repeat || e.isComposing) return
      const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar'
      if (!isSpace) return
      // 正在输入框/搜索框里打空格，不当成播放控制
      const el = e.target || {}
      const tag = String(el.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable) return
      if (!this.room) return
      e.preventDefault()
      this.togglePlay()
    },

    clearLoadTimer() {
      if (this.loadTimer) {
        clearTimeout(this.loadTimer)
        this.loadTimer = null
      }
    },

    formatTime(seconds) {
      const s = Math.max(0, Math.floor(Number(seconds) || 0))
      const m = Math.floor(s / 60)
      const r = s % 60
      return `${m}:${r < 10 ? '0' : ''}${r}`
    },

    coverUrl(pic) {
      if (!pic) return ''
      return `${getServerBase()}/api/music/pic?url=${encodeURIComponent(pic)}`
    },

    // 队列里的播放地址可能是相对路径（本地上传的音频 / 在线歌曲流），补成当前可用的绝对地址。
    // 关键：队列是全房共享的，房主可能是用 localhost 或某个局域网 IP 点歌的，
    // 直接沿用那个绝对地址，手机上的 localhost 就指向手机自己，音频必然播不出来。
    // 所以本服务自己的路径（/uploads、/api）一律按「当前这台设备访问服务的地址」重拼。
    absoluteSongUrl(url) {
      const raw = String(url || '')
      if (!raw) return ''
      if (/^(blob:|data:)/i.test(raw)) return raw
      const base = String(getServerBase() || '').replace(/\/+$/, '')
      const own = raw.match(/^(?:https?:)?\/\/[^/?#]+(\/(?:uploads|api)\/[^]*)$/i) || raw.match(/^(\/(?:uploads|api)\/[^]*)$/i)
      if (own) return base + own[1]
      if (/^(https?:)?\/\//i.test(raw)) return raw
      return base + (raw.charAt(0) === '/' ? raw : '/' + raw)
    },

    // 队列第二行：歌手 · 时长（原来直接显示 stream 地址，太难看）
    songSubtitle(song) {
      if (!song) return ''
      const parts = []
      const author = String(song.author || '').trim()
      if (author) parts.push(author)
      const dur = Number(song.duration) || 0
      if (dur > 0) parts.push(this.formatTime(dur))
      return parts.length ? parts.join(' · ') : '待播放'
    },

    // 点队列里的任意一首直接切过去（当前这首点了就是恢复/暂停）
    playFromQueue(index) {
      if (!this.room) return
      if (index === this.currentIndex) {
        this.togglePlay()
        return
      }
      this.socket.emit('music-play', { roomId: this.room.id, index, time: 0 })
    },

    // 点击封面/空白处：封面 ⇄ 歌词
    toggleLyrics() {
      this.showLyrics = !this.showLyrics
      if (!this.showLyrics) return
      if (this.lyricLines.length) {
        this.measureLyric()
      } else {
        this.loadLyric()
      }
    },

    // 量一遍每句歌词在滚动容器里的位置，用来把当前句精确居中
    measureLyric() {
      this.$nextTick(() => {
        const q = uni.createSelectorQuery().in(this)
        q.select('.lyric-scroll').boundingClientRect()
        q.select('.lyric-spacer').boundingClientRect()
        q.selectAll('.lyric-line').boundingClientRect()
        q.exec((res) => {
          const box = res && res[0]
          const spacer = res && res[1]
          const list = (res && res[2]) || []
          if (!list.length) return
          const base = list[0].top
          this.lyricViewH = box ? box.height : 0
          this.lyricSpacerH = spacer ? spacer.height : 88
          this.lyricOffsets = list.map((r) => r.top - base)
          this.lyricHeights = list.map((r) => r.height)
          this.syncLyricScroll()
        })
      })
    },

    syncLyricScroll() {
      if (!this.showLyrics) return
      const i = this.activeLyricIndex
      if (i < 0 || !this.lyricOffsets.length) return
      const offset = this.lyricOffsets[i] || 0
      const lineH = this.lyricHeights[i] || 34
      const viewH = this.lyricViewH || 236
      // 让当前句落在面板垂直中线，而不是被顶到上边缘（那正好是渐隐区）
      const top = this.lyricSpacerH + offset - (viewH - lineH) / 2
      this.lyricScrollTop = Math.max(0, Math.round(top))
    },

    // 歌词只认「音源歌曲 ID」，队列里的 id 是服务端生成的流水号，不能用
    lyricIdFor(song) {
      if (!song) return ''
      if (song.sourceId) return String(song.sourceId)
      // 老队列没有 sourceId，从播放地址里把网易云 id 抠出来
      const m = String(song.url || '').match(/\/api\/music\/stream\?[^#]*\bid=([^&]+)/)
      return m ? decodeURIComponent(m[1]) : ''
    },

    async loadLyric() {
      const song = this.currentSong
      const id = this.lyricIdFor(song)
      if (!id) {
        this.lyricLines = []
        const isLocalFile = song && /\/uploads\//.test(String(song.url || ''))
        this.lyricError = song ? (isLocalFile ? '本地音频没有歌词' : '这首歌没有可用的歌词') : ''
        return
      }
      if (this.lyricSongId === id && this.lyricLines.length) return
      this.lyricSongId = id
      this.lyricLoading = true
      this.lyricError = ''
      try {
        const data = await requestJSON(`${getServerBase()}/api/music/lyric?id=${encodeURIComponent(id)}`)
        if (this.lyricSongId !== id) return
        const text = (data && (data.lyric || data.lrc)) || ''
        this.lyricLines = this.parseLrc(text)
        if (!this.lyricLines.length) {
          this.lyricError = '这首歌暂无歌词'
        } else if (this.showLyrics) {
          this.measureLyric()
        }
      } catch (err) {
        if (this.lyricSongId !== id) return
        this.lyricLines = []
        this.lyricError = err && err.statusCode === 403 ? '这首歌已被管理员禁播' : '歌词加载失败'
      } finally {
        if (this.lyricSongId === id) this.lyricLoading = false
      }
    },

    // 解析 LRC：支持一行多时间戳、[mm:ss]、[mm:ss.x] / [mm:ss.xx] / [mm:ss.xxx]
    parseLrc(text) {
      const src = String(text || '')
      if (!src.trim()) return []
      const out = []
      src.split(/\r?\n/).forEach((raw) => {
        const stamps = raw.match(/\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/g)
        if (!stamps) return
        const content = raw.replace(/\[[^\]]*\]/g, '').trim()
        if (!content) return
        stamps.forEach((stamp) => {
          const m = stamp.match(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/)
          if (!m) return
          const frac = m[3] || ''
          const ms = frac ? Number(frac) * Math.pow(10, 3 - frac.length) : 0
          const time = Number(m[1]) * 60 + Number(m[2]) + ms / 1000
          if (isCreditLine(content)) return
          out.push({ time, text: content })
        })
      })
      out.sort((a, b) => a.time - b.time)
      // 同一时间点重复的句子只留一条
      return out.filter((line, i) => i === 0 || line.time !== out[i - 1].time)
    },

    bindEvents() {
      this.socket.off('music-room-created', this.handleRoomCreated)
      this.socket.off('music-room-joined', this.handleRoomJoined)
      this.socket.off('music-room-state', this.handleRoomState)
      this.socket.off('music-error', this.handleError)
      this.socket.off('music-member-updated', this.handleMemberUpdated)
      this.socket.off('connect_error', this.handleConnectError)
      this.socket.on('music-room-created', this.handleRoomCreated)
      this.socket.on('music-room-joined', this.handleRoomJoined)
      this.socket.on('music-room-state', this.handleRoomState)
      this.socket.on('music-error', this.handleError)
      this.socket.on('music-member-updated', this.handleMemberUpdated)
      this.socket.on('connect_error', this.handleConnectError)
    },

    unbindEvents() {
      if (!this.socket) return
      this.socket.off('connect', this.ensureEntered)
      this.socket.off('music-room-created', this.handleRoomCreated)
      this.socket.off('music-room-joined', this.handleRoomJoined)
      this.socket.off('music-room-state', this.handleRoomState)
      this.socket.off('music-error', this.handleError)
      this.socket.off('music-member-updated', this.handleMemberUpdated)
      this.socket.off('connect_error', this.handleConnectError)
    },

    // 进房请求：已进房则忽略，重复调用安全（断线重连后可自动补一次）
    ensureEntered() {
      if (!this.socket) return
      // 先对齐时钟，后面按时间轴换算进度才准
      startClockSync(this.socket)
      // 断线重连后 this.room 还在，但服务端已经不认识这个新 socket：
      // 必须重新 join 一次，否则会出现「界面还在房间、服务端没有你」。
      if (this.room) {
        this.socket.emit('music-join-room', { roomId: this.room.id })
        return
      }
      const q = this.enterQuery || {}
      if (q.create) {
        this.socket.emit('music-create-room')
      } else if (q.roomId) {
        this.socket.emit('music-join-room', { roomId: String(q.roomId).toUpperCase() })
      } else {
        this.loading = false
        this.error = '缺少房间信息'
      }
    },

    handleRoomCreated(data) {
      this.clearLoadTimer()
      this.loading = false
      this.applyRoomState(data)
      this.setupAudio()
      this.loadRecommend()
    },

    handleRoomJoined(data) {
      this.clearLoadTimer()
      this.loading = false
      this.applyRoomState(data)
      this.setupAudio()
      this.loadRecommend()
    },

    handleRoomState(data) {
      if (!this.room || this.room.id === data.room.id) {
        this.applyRoomState(data)
      }
    },

    handleMemberUpdated(data) {
      if (this.room && data && data.count) {
        this.room.memberCount = data.count
      }
    },

    handleError(err) {
      this.clearLoadTimer()
      this.loading = false
      const msg = (err && err.message) || '操作失败'
      // 弹一下就够：这类多半是「这次操作被拒绝」或「房间已结束」，
      // 不该一直挂在页面顶部挡住内容（以前一按暂停就永久留一行红字）
      uni.showToast({ title: msg, icon: 'none', duration: 2400 })
      if (!this.room) {
        this.error = msg
      } else {
        setTimeout(() => {
          if (this.error === msg) this.error = ''
        }, 2600)
      }
    },

    handleConnectError() {
      this.clearLoadTimer()
      this.loading = false
      this.error = '网络连接失败，请检查网络后重试'
    },

    applyRoomState(data) {
      if (!data || !data.room) return
      const prevSongId = this.currentSong ? this.currentSong.id : null
      const queueWasEmpty = !this.queue.length
      const isFirstState = !this.room
      this.room = data.room
      this.isHost = !!data.isHost
      // 本地上传的歌在队列里存的是相对路径（/uploads/xxx.mp3），
      // 每个人按自己实际访问的地址补全，换局域网 IP / 换公网隧道都不会互相影响
      this.queue = (data.room.queue || []).map((song) => (
        song && song.url ? Object.assign({}, song, { url: this.absoluteSongUrl(song.url) }) : song
      ))
      this.currentIndex = data.room.currentIndex >= 0 ? data.room.currentIndex : -1
      this.playing = !!data.room.playing
      const seekSeq = Number(data.room.seekSeq) || 0
      const seekChanged = seekSeq !== this.seekSeq
      this.seekSeq = seekSeq
      this.mySongCount = data.room.mySongCount || 0
      this.myReady = this.myReady || !!(data.room.iAmReady || this.isHost)
      // 断线重连后服务端会丢掉「已准备」标记，本机其实早就解锁过，补报一次
      if (this.myReady && !this.isHost && !data.room.iAmReady && this.room && this.socket) {
        this.socket.emit('music-ready', { roomId: this.room.id, ready: true })
      }
      this.waitingStart = !!data.room.waiting
      this.readyCount = Number(data.room.readyCount) || 1
      this.guestCount = Number(data.room.guestCount) || 0

      // 时间轴：time 是 syncedAt 那一刻的进度，换算成「此刻该到哪」
      this.remoteState = {
        time: Number(data.room.time) || 0,
        playing: this.playing,
        rate: 1,
        at: Number(data.room.syncedAt) || 0
      }
      const expected = this.musicExpected()
      // 房间被暂停时，「点一下开始播放」的提示就没意义了
      if (!this.playing) {
        this.autoplayBlocked = false
        this._blockedTicks = 0
      }

      // 服务端定了一个新的「一起开始」时刻：两边掐着同一个毫秒开响。
      // 这是同步的核心——不是让落后的那位去追，而是大家重新约一个起点。
      const startSeq = Number(data.room.startSeq) || 0
      const startAt = Number(data.room.startAt) || 0
      if (startAt && startSeq !== (this._startSeq || 0)) {
        this._startSeq = startSeq
        this.scheduleStart(startAt, expected)
      }

      const nextSongId = this.currentSong ? this.currentSong.id : null
      if (this.audio) {
        if (prevSongId !== nextSongId) {
          // 换歌：直接把该播的位置带进加载流程
          this.time = expected
          this.loadCurrentSong()
        } else if (this.waitingStart || this.armedForStart()) {
          // 正在等开播：进度条先别乱动，等那一刻统一对齐
        } else {
          // 播放/暂停对所有人都以服务端状态为准，房主也不例外。
          // 之前这里把房主排除在外（想的是「房主是播放源头，别自己按停自己」），
          // 结果房主按暂停只广播了一下，本机的 audio 根本没停，听起来就是「点了暂停还在放」。
          if (this.playing && this.audio.paused) {
            // 手机加载慢、晚进房：先定位到当前进度再出声，
            // 不要从 0 开始播再让跟随逻辑去追（那一秒延迟就是这么来的）
            const exp = this.musicExpected()
            if (!this.isHost && exp > 0.5) {
              this._pendingStartUnmute = true
              this.hardSeek(exp)
              this.unmuteAfterSeek()
            } else {
              this.playAudio()
            }
          } else if (!this.playing && !this.audio.paused) {
            this.audio.pause()
          }
          // 进度对齐只有跟随方需要：房主自己就是时间源，别把自己往回调
          // 被自动播放策略拦住的时候更不能对齐：那只会把进度条推着走，声音还是没有
          if (!this.isHost && !this.autoplayBlocked) {
            const drift = Math.abs((this.audio.currentTime || 0) - expected)
            const tol = seekChanged ? 0.4 : 0.6
            if (drift > tol) this.musicSeekQuiet(expected, seekChanged)
          }
        }
      }

      if (this.isHost) {
        this.startMusicSync()
      } else if (!this.isHost && this.syncTimer) {
        clearInterval(this.syncTimer)
        this.syncTimer = null
      }

      // 刚导入的本地歌曲：确认它真的进了队列，再切过去播
      let localPlayHandled = false
      if (this._pendingLocalSongKey && this.isHost && this.queue.length) {
        const last = this.queue[this.queue.length - 1]
        const key = last ? `${last.title}|${Number(last.duration) || 0}` : ''
        if (key === this._pendingLocalSongKey) {
          this._pendingLocalSongKey = ''
          localPlayHandled = true
          this.socket.emit('music-play', { roomId: this.room.id, index: this.queue.length - 1, time: 0 })
        }
      }

      if (!localPlayHandled && this.isHost && !isFirstState && queueWasEmpty && this.queue.length && this.currentIndex < 0 && !this.playing) {
        this.socket.emit('music-play', { roomId: this.room.id, index: 0 })
      }
    },

    setupAudio() {
      if (this.audio) return
      this.audio = uni.createInnerAudioContext()
      this.audio.onPlay(() => {
        if (this._unlocking || this._silentRun) return
        this.playing = true
        this.autoplayBlocked = false
      })
      this.audio.onPause(() => {
        // 解锁用的「静音播一下再停」不算暂停，别让按钮闪一下
        if (this._unlocking || this._silentRun) return
        this.playing = false
      })
      this.audio.onTimeUpdate(() => {
        this.time = this.audio.currentTime || 0
        if (!this.isHost && this.room && this.audio.currentTime) {
          // 非房主不主动回传，防止回声
        }
      })
      this.audio.onEnded(() => {
        if (this.isHost) {
          this.nextSong()
        }
      })
      this.audio.onError(() => {
        const song = this.currentSong || {}
        const songKey = song.id || song.url || ''
        // 同一首歌反复报错就不要再自动跳了，否则整个队列会被一路跳过
        if (songKey && this._errorSongKey === songKey) return
        this._errorSongKey = songKey
        uni.showToast({ title: '这首歌暂时无法播放，可能受版权限制', icon: 'none', duration: 2400 })
        // 只有房主负责换歌，别让整个房间卡在一首放不出来的歌上
        if (!this.isHost || !this.room) return
        setTimeout(() => {
          if (!this.room || this._errorSongKey !== songKey) return
          this.nextSong()
        }, 1200)
      })
      // 缓冲状态：网络慢的时候先别动进度，等它下够了再一次对齐
      if (typeof this.audio.onWaiting === 'function') {
        this.audio.onWaiting(() => {
          if (Date.now() < (this._seekGuardUntil || 0)) return
          this.buffering = true
        })
      }
      if (typeof this.audio.onCanplay === 'function') {
        this.audio.onCanplay(() => {
          this.buffering = false
          this.reportBuffered()
          // 到点时还没缓冲好：等 canplay 后先定位到当前进度，再开声
          if (this._pendingStartUnmute) {
            this._pendingStartUnmute = false
            this.hardSeek(this.musicExpected())
            this.unmuteAfterSeek()
            return
          }
          if (typeof this._pendingMusicSeek === 'number') {
            const t = this._pendingMusicSeek
            this._pendingMusicSeek = null
            this.musicSeekQuiet(t)
            return
          }
          this.musicCatchUp()
        })
      }
      this.loadCurrentSong()
      // 缓冲进度到了 1.5 秒再上报（canplay 本身太早）
      const bufferedMedia = this.mediaEl()
      if (bufferedMedia && typeof bufferedMedia.addEventListener === 'function' && !bufferedMedia.__lookBufferBound) {
        bufferedMedia.__lookBufferBound = true
        bufferedMedia.addEventListener('progress', () => this.reportBuffered())
        bufferedMedia.addEventListener('canplaythrough', () => this.reportBuffered())
      }
      this.startFollowLoop()
      this.startPlayGate()

      if (this.isHost) this.startMusicSync()
    },

    /**
     * 房主每 2.5 秒报一次进度。
     * 报的是「这一刻」的时间戳，别人拿到后自己往后推算，不怕消息迟到。
     * 房主自己卡住时先报 playing=false，免得把大家带到没缓冲到的位置。
     */
    startMusicSync() {
      if (this.syncTimer) return
      this.syncTimer = setInterval(() => {
        if (!this.audio || !this.room) return
        // 刚按过暂停/播放，这一拍先跳过，免得用上一帧的状态把操作顶回去
        if (Date.now() < (this._controlGuardUntil || 0)) return
        // 报的是「此刻」的进度 + 服务器时间，别人自己往后推算，不怕消息迟到。
        // 注意：这里不能因为自己卡了一下就报暂停，否则会把整个房间按停。
        this.socket.emit('music-sync', {
          roomId: this.room.id,
          time: this.audio.currentTime || 0,
          playing: this.playing,
          atServer: serverNow()
        })
      }, 1500)
    },

    /**
     * 出声守护：每 1.2 秒问一次「现在到底有没有真的在播」。
     * 房主也跑 —— 手机建房的人是源头，他不出声整房间都没声。
     * 以前只看 play() 的返回值，而 uni 的 H5 实现把 reject 吞了，
     * 界面就一直显示播放中、进度靠 seek 假装前进，实际全静音。
     */
    startPlayGate() {
      if (this.gateTimer) return
      this.gateTimer = setInterval(() => this.checkPlayGate(), 1200)
    },

    checkPlayGate() {
      if (!this.audio || !this.currentSong) return
      // 访客还没点「准备」：正在等他点，别自作主张去 play（也放不出来）
      if (this.needGesture) {
        this.autoplayBlocked = false
        return
      }
      // 正在等开播 / 已定好开播时刻：这属于「还没开始」，不是故障
      if (this.waitingStart || this.armedForStart() || this._pendingStartUnmute) {
        this._blockedTicks = 0
        this.autoplayBlocked = false
        return
      }
      const wantPlay = !!(this.remoteState && this.remoteState.playing)
      if (!wantPlay) {
        this.autoplayBlocked = false
        this._blockedTicks = 0
        return
      }
      if (this.audioReallyPlaying()) {
        this._hasPlayed = true
        this.autoplayBlocked = false
        this._blockedTicks = 0
        return
      }
      // 已经真正出声过（比如中途切后台被系统停掉），就先按普通暂停处理，别弹按钮
      if (this._hasPlayed) return
      this._blockedTicks = (this._blockedTicks || 0) + 1
      if (this._blockedTicks >= 2) {
        // 试了两轮还是没声：确定是被自动播放策略拦了，亮按钮
        this.autoplayBlocked = true
        return
      }
      this.playAudio()
    },

    playAudio() {
      if (!this.audio) return
      // uni-app H5 的 InnerAudioContext.play() 是 `this._audio.play()` 且不返回 Promise，
      // 浏览器拒绝自动播放时异常被整个吞掉：界面显示「播放中」、进度靠 seek 假装在走，
      // 实际上一声都没有。所以这里直接操作底层 Audio 元素，把 reject 抓住。
      const media = this.mediaEl()
      if (media) {
        try {
          const ret = media.play()
          if (ret && typeof ret.catch === 'function') {
            ret.catch(() => this.markPlayBlocked())
          }
          return
        } catch (err) {
          this.markPlayBlocked()
          return
        }
      }
      // 拿不到底层元素时的兜底（其它平台）
      try {
        const ret = this.audio.play()
        if (ret && typeof ret.catch === 'function') {
          ret.catch(() => this.markPlayBlocked())
        }
      } catch (err) {
        this.markPlayBlocked()
      }
    },

    // uni-h5 内部就是 new Audio()，取出来才能拿到 play() 的 Promise 和 muted/volume
    mediaEl() {
      if (this._media && this._media.play) return this._media
      const inner = this.audio && (this.audio._audio || this.audio.audio)
      if (inner && typeof inner.play === 'function') {
        this._media = inner
        return inner
      }
      return null
    },

    markPlayBlocked() {
      // 没有在放的歌就别提示；明确暂停也别提示
      if (!this.currentSong) return
      if (this.remoteState && this.remoteState.playing === false) return
      this.autoplayBlocked = true
    },

    // 真的在出声吗？paused 才是最可信的信号，不能只看自己维护的 playing
    audioReallyPlaying() {
      const media = this.mediaEl()
      if (media) return !media.paused && !media.ended
      return !!this.audio && !this.audio.paused
    },

    resumeAudio() {
      this.autoplayBlocked = false
      this._blockedTicks = 0
      if (!this.audio) return
      const media = this.mediaEl()
      // 点下去的这一下必须同步 play()，不能等 setTimeout —— 浏览器只认手势当帧
      // 之前被拦住时进度没有跟着走，这里先对到房间当前时间，再出声
      if (this.remoteState && this.remoteState.playing) {
        const target = this.musicExpected()
        const cur = media ? media.currentTime || 0 : this.audio.currentTime || 0
        if (Math.abs(cur - target) > 1.5) {
          this._lastQuietSeekAt = Date.now()
          this._seekGuardUntil = Date.now() + 1500
          this.seekAudio(target)
        }
      }
      if (media) {
        try {
          const ret = media.play()
          if (ret && typeof ret.catch === 'function') {
            ret.catch(() => { this.autoplayBlocked = true })
          }
        } catch (err) {
          this.autoplayBlocked = true
        }
        return
      }
      try {
        const ret = this.audio.play()
        if (ret && typeof ret.catch === 'function') ret.catch(() => { this.autoplayBlocked = true })
      } catch (err) {
        this.autoplayBlocked = true
      }
    },

    // ---------- 一起听：准备 → 统一起跑 ----------

    reportBuffered() {
      if (!this.socket || !this.room || !this.currentSong) return
      const media = this.mediaEl()
      if (!media || media.readyState < 3) return
      // canplay 不等于「够播」：只缓冲了 0.2 秒也会触发，手机接着就卡 0:00。
      // 至少要有 1.5 秒前瞻缓冲，才告诉服务端「可以开播了」。
      let ahead = 0
      try {
        const b = media.buffered
        const cur = media.currentTime || 0
        for (let i = 0; i < b.length; i += 1) {
          if (b.start(i) <= cur + 0.25) ahead = Math.max(ahead, b.end(i) - cur)
        }
      } catch (e) {}
      const noRange = !media.buffered || !media.buffered.length
      if (ahead < 1.5 && !(noRange && media.readyState >= 4)) return
      const key = this.currentSong.id || this.currentSong.url || ''
      if (key && this._bufferedSongKey === key) return
      this._bufferedSongKey = key
      this.socket.emit('music-buffered', { roomId: this.room.id })
    },

    /**
     * 访客点「准备一起听」。
     * 这一下必须当场就 play()：浏览器只认手势当帧，晚一个 tick 就解锁不了声音。
     * 同时告诉服务端「我加载好了」，房主那边就能放行。
     */
    becomeReady() {
      if (this.myReady) return
      this.myReady = true
      this.unlockAudio()
      this.waitLoadedThenReady()
    },

    /**
     * 真正的「加载好了」才报名。
     * 点完准备先等音频缓冲够一次开播（最多等 6 秒，卡住也不能让房主干等）。
     */
    waitLoadedThenReady() {
      const started = Date.now()
      const finish = () => {
        if (this._readySent) return
        this._readySent = true
        this.preparing = false
        if (this.socket && this.room) {
          this.socket.emit('music-ready', { roomId: this.room.id, ready: true })
          if (media && media.readyState >= 3) this.reportBuffered()
        }
      }
      const media = this.mediaEl()
      if (!media || !this.currentSong) {
        finish()
        return
      }
      this.preparing = true
      const tick = () => {
        if (this._readySent) return
        if (media.readyState >= 3) this.reportBuffered()
        if (media.error || media.readyState >= 2 || Date.now() - started > 6000) {
          finish()
          return
        }
        setTimeout(tick, 150)
      }
      tick()
    },

    unlockAudio() {
      const media = this.mediaEl()
      if (!media) {
        try { if (this.audio) this.audio.play() } catch (e) {}
        return
      }
      this._unlocking = true
      try {
        // 静音播一下再停：不发声但拿到了播放许可，之后程序再 play() 就不会被拦
        media.muted = true
        const p = media.play()
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch (e) {}
      setTimeout(() => {
        // 解锁完立刻停下：这时候还没到开播时刻，不能自己先响。
        // 若这期间已经拿到了开播时刻并进入静音起跑，就别打断它。
        if (!this._silentRun && !this.armedForStart()) {
          try {
            media.pause()
            media.muted = false
          } catch (e) {}
        }
        setTimeout(() => { this._unlocking = false }, 240)
      }, 60)
    },

    /**
     * 服务端定了一个开播时刻：先把音频定位到「那一刻该在的位置」并静音起跑，
     * 到点再开声。这样两个设备是在同一毫秒出声，而不是一个先响一个去追。
     */
    scheduleStart(startAt, pos) {
      this.clearStartTimers()
      this.waitingStart = false
      this.autoplayBlocked = false
      this._blockedTicks = 0
      this.startingIn = 0

      const lead = startAt - serverNow()
      // 时刻离得太远（比如手机时间被改过），不预约，等下一次状态再说
      if (!Number.isFinite(lead) || Math.abs(lead) > 15000) return

      // expected 是「开播那一刻该在的位置」，现在还没到，要往回倒 lead 秒。
      // 例：房间正在播到手 J 秒，给刚进房的人约在 J+0.9 秒开始，
      // 那么现在就该定位在 J 秒——已经在放的人一毫秒都不用动。
      const atStart = Math.max(0, Number(pos) || 0)
      const posNow = Math.max(0, atStart - Math.max(0, lead) / 1000)
      const canRun = this.isHost || this.myReady
      if (this.audio) {
        const needSeek = Math.abs((this.audio.currentTime || 0) - posNow) > 0.35
        if (needSeek) this.hardSeek(posNow)
        // 房主本来就在放的，别为了对齐硬拽一下（差一点点听不出来）
        if (canRun && !(this.isHost && this.audioReallyPlaying())) {
          // 刚 seek 过就先等定位落地再起跑，否则会在旧位置上白跑一段，
          // 到点开声时位置是错的，又得跳一次——正是「差一点」的来源
          if (needSeek) {
            setTimeout(() => {
              if (this.armedForStart()) this.playSilent()
            }, 90)
          } else {
            this.playSilent()
          }
        }
      }

      if (lead <= 0) {
        this.commitStart()
        return
      }

      this.startingIn = Math.max(1, Math.round(lead / 1000))
      // 一个长 setTimeout 在主线程忙时可能偏几十到几百毫秒，两台设备偏的量还不一样。
      // 这就是「约好了同一时刻，听起来还是差一点」的第一大来源。
      // 改成：粗唤醒 → 最后 150ms 逐帧盯表，且在到达 startAt 之前绝不出声。
      this.armPreciseStart(startAt)
      this._countTimer = setInterval(() => {
        const left = startAt - serverNow()
        if (left <= 0) {
          this.startingIn = 0
          if (this._countTimer) {
            clearInterval(this._countTimer)
            this._countTimer = null
          }
          return
        }
        this.startingIn = Math.max(1, Math.round(left / 1000))
      }, 200)
    },

    /**
     * 高精度开播定时。
     * 先用较粗的 setTimeout 一步步逼近（每次最多睡 100ms），
     * 最后 160ms 改用 requestAnimationFrame 逐帧检查（页面可见时约 16ms 精度）。
     * 全程只在「服务器时间 >= startAt」那一刻才 commit，永远不会提前出声。
     */
    armPreciseStart(startAt) {
      this.startArmed = true
      const step = () => {
        this._startTimer = null
        this._startRaf = null
        const left = startAt - serverNow()
        if (left <= 0) {
          this.commitStart()
          return
        }
        if (left <= 160) {
          if (typeof requestAnimationFrame === 'function') {
            this._startRaf = requestAnimationFrame(step)
          } else {
            this._startTimer = setTimeout(step, 10)
          }
          return
        }
        // 提前 30ms 醒来，别卡着最后一毫秒，留给 rAF 接手
        this._startTimer = setTimeout(step, Math.min(left - 30, 100))
      }
      step()
    },

    // 是否处在「已预约开播、还没到点」的阶段（含 rAF 微调阶段）
    armedForStart() {
      return !!(this.startArmed || this._startTimer || this._startRaf)
    },

    clearStartTimers() {
      this.startArmed = false
      this._pendingStartUnmute = false
      if (this._startTimer) {
        clearTimeout(this._startTimer)
        this._startTimer = null
      }
      if (this._startRaf) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this._startRaf)
        else clearTimeout(this._startRaf)
        this._startRaf = null
      }
      if (this._countTimer) {
        clearInterval(this._countTimer)
        this._countTimer = null
      }
    },

    // 静音起跑：先把缓冲拉满，到点开声就是无缝的
    playSilent() {
      const media = this.mediaEl()
      if (!media) return
      this._silentRun = true
      try {
        media.muted = true
        const p = media.play()
        if (p && typeof p.catch === 'function') p.catch(() => {})
      } catch (e) {}
    },

    /**
     * 到点了：开声。
     * 这里最重要的原则是——除非真的错位，否则一个 seek 都不要做。
     * seek 会让浏览器丢掉已解码的缓冲、重新拉数据，出声要晚 200~500ms；
     * 两台设备各自晚的量不同，人耳听到的就是「说好一起播，还是差一点」。
     * 静音起跑阶段音频已经在正确位置上跑着了，到点只需要解除静音。
     */
    commitStart() {
      this.clearStartTimers()
      this.startingIn = 0
      this.waitingStart = false
      const media = this.mediaEl()
      if (!media) {
        this.playAudio()
        return
      }
      if (media.readyState < 3) {
        // 手机流量下 1.8 秒常常不够：先记下来，等 canplay 后定位再开声
        this._pendingStartUnmute = true
        this.hardSeek(this.musicExpected())
        return
      }
      const target = this.musicExpected()
      const drift = (media.currentTime || 0) - target
      if (Math.abs(drift) > 0.35) {
        // 静音起跑没起来（还在缓冲 / 被打断）：只能硬对齐，
        // 但必须等定位真正落地再开声，否则先漏出来的是旧位置的声音
        this.hardSeek(target)
        this.unmuteAfterSeek()
        return
      }
      this.unmuteNow()
    },

    // seek 之后等定位落地再开声，最多等 600ms
    unmuteAfterSeek() {
      const media = this.mediaEl()
      if (!media || typeof media.addEventListener !== 'function') {
        this.unmuteNow()
        return
      }
      let done = false
      const fire = () => {
        if (done) return
        done = true
        try { media.removeEventListener('seeked', fire) } catch (e) {}
        this.unmuteNow()
      }
      try { media.addEventListener('seeked', fire) } catch (e) {}
      setTimeout(() => {
        if (done) return
        if (media.readyState >= 3) fire()
        else this._pendingStartUnmute = true
      }, 600)
    },

    // 真正开声：只解静音 + 确保在播，绝不碰 currentTime
    unmuteNow() {
      const media = this.mediaEl()
      if (!media) {
        this.playAudio()
        return
      }
      this._silentRun = false
      if (media.muted) {
        try { media.muted = false } catch (e) {}
      }
      let p = null
      try { p = media.play() } catch (e) { p = null }
      if (p && typeof p.catch === 'function') p.catch(() => this.markPlayBlocked())
      // 开声后短暂锁一下，别让跟随逻辑立刻又来纠正
      this._seekGuardUntil = Date.now() + 800
    },

    // 硬对齐：不受 3 秒冷却限制，只用于「一起开播」这种必须卡的场景
    hardSeek(pos) {
      this.setPlayRate(1)
      this._seekGuardUntil = Date.now() + 1200
      this._lastQuietSeekAt = Date.now()
      this.seekAudio(Math.max(0, Number(pos) || 0))
    },

    onSeeking(e) {
      this.seeking = true
      this.seekValue = Number(e.detail.value) || 0
    },

    loadCurrentSong() {
      if (!this.audio || !this.currentSong) return
      this._pendingStartUnmute = false
      this._bufferedSongKey = ''
      this._errorSongKey = null
      const target = this.time || 0
      this.audio.src = this.currentSong.url
      // 刚换 src 时元数据还没到，这一下 seek 常常失效，记下来等 canplay 补上
      this._pendingMusicSeek = target
      this.seekAudio(target)
      // 手机流量下「点了准备才开始下载」会明显晚一拍：切歌即预加载
      const media = this.mediaEl()
      if (media) {
        try {
          media.preload = 'auto'
          if (typeof media.load === 'function') media.load()
        } catch (e) {}
      }
      // 等待开播 / 已定好开播时刻 / 还没点准备：这时候不能自己先响。
      // 但 src 已经设上了，浏览器会先把音频拉下来——等点「准备」时就有货，
      // 不会出现「点了准备还要等半天加载」。
      if (this.waitingStart || this.armedForStart() || this.needGesture) {
        if (this.audioReallyPlaying()) this.audio.pause()
        return
      }
      if (this.playing) {
        this.playAudio()
      } else {
        this.audio.pause()
      }
    },

    seekAudio(position) {
      try {
        if (typeof this.audio.seek === 'function') {
          this.audio.seek(position)
        } else {
          this.audio.currentTime = position
        }
      } catch (e) {
        // 忽略旧版本 API 的 seek 限制
      }
    },

    // 按时间轴算出「这一刻应该播到第几秒」
    musicExpected() {
      return positionAt(this.remoteState)
    },

    // 带保护的跳转：跳完 1.5 秒内不再判偏差，避免自己触发自己
    // force=true 用于换歌/用户主动操作，自动对齐走冷却，3 秒最多一次
    musicSeekQuiet(target, force) {
      const t = Number(target)
      if (!Number.isFinite(t) || t < 0) return
      if (this.buffering) {
        this._pendingMusicSeek = t
        return
      }
      const now = Date.now()
      // 房主 2.5 秒一次心跳，如果每次同步都跟着 seek，音频就一直重新定位，
      // 网络稍差就永远缓冲不满、永远没声音。自动对齐限流，别把它变成主旋律。
      if (!force && now - (this._lastQuietSeekAt || 0) < 1800) return
      this.setPlayRate(1)
      this._lastQuietSeekAt = now
      this._seekGuardUntil = now + 1500
      this.seekAudio(t)
    },

    // 缓冲结束后补一次对齐——网慢的人加载完就能落到正确的位置
    musicCatchUp() {
      if (this._pendingStartUnmute || this.armedForStart()) return
      if (this.isHost || !this.audio || !this.remoteState) return
      if (Date.now() < (this._seekGuardUntil || 0)) return
      if (this.remoteState.playing && !this.audioReallyPlaying()) {
        // 还没出声，先解决出声的问题，别急着对齐进度
        this.playAudio()
        return
      }
      const target = this.musicExpected()
      if (Math.abs((this.audio.currentTime || 0) - target) > 0.6) {
        this.musicSeekQuiet(target)
      }
    },

    startFollowLoop() {
      if (this.followTimer) return
      this.followTimer = setInterval(() => this.musicFollowTick(), 1000)
    },

    stopFollowLoop() {
      if (this.followTimer) {
        clearInterval(this.followTimer)
        this.followTimer = null
      }
    },

    /**
     * 每秒检查一次进度偏差。
     * 音频不像视频那样能靠加减速悄悄追（会变调），所以只做「够大才跳一次」，
     * 而且缓冲中一律不动。
     */
    musicFollowTick() {
      if (this.isHost || !this.audio || !this.remoteState) return
      if (this.room == null) return
      // 还没点准备、正在等开播、已经定了开播时刻：一律不追进度
      if (this.needGesture || this.waitingStart || this.armedForStart() || this._pendingStartUnmute) return
      // 静音起跑阶段由 commitStart 负责开声，别在这里插手
      if (this._silentRun) return
      const target = this.musicExpected()

      if (!this.remoteState.playing) {
        this.catchingUp = false
        if (this.audio.currentTime && Math.abs(this.audio.currentTime - target) > 1.2) {
          this.musicSeekQuiet(target)
        }
        return
      }
      if (this.buffering) {
        // 缓冲超过 8 秒还没动静，多半是音频元素卡死了，重来一次
        if (!this._bufferingSince) this._bufferingSince = Date.now()
        else if (Date.now() - this._bufferingSince > 8000) {
          this.buffering = false
          this._bufferingSince = 0
          this._seekGuardUntil = 0
          this.musicSeekQuiet(target)
          this.playAudio()
        }
        this.catchingUp = true
        return
      }
      this._bufferingSince = 0

      // 关键：服务端说在放，本地却根本没出声（浏览器拦了自动播放）。
      // 这时一个字节都别 seek —— seek 会把进度条推着往前走，看起来像在播，
      // 实际上一声没有，还让人以为「网速慢」。亮按钮交给 checkPlayGate。
      if (!this.audioReallyPlaying()) {
        this.catchingUp = false
        return
      }

      if (this.audio.paused) {
        this.playAudio()
        return
      }
      if (Date.now() < (this._seekGuardUntil || 0)) return

      const cur = Number(this.audio.currentTime) || 0
      const drift = cur - target
      const abs = Math.abs(drift)

      // 超过 1.2 秒：错位太大，变速要追很久，直接跳一次
      if (abs > 0.6) {
        this._nudgeSince = 0
        this.setPlayRate(1)
        this.catchingUp = true
        this.musicSeekQuiet(target)
        return
      }
      // 0.1 秒以内：已经对齐了，恢复正常速度
      if (abs <= 0.1) {
        this.catchingUp = false
        this._nudgeSince = 0
        this.setPlayRate(1)
        return
      }
      // 0.1~1.2 秒：靠微调播放速度悄悄追上去。
      // 以前这里直接 seek，会顿一下，而且两台设备各跳各的、跳完还是差一点；
      // 变速追 1~3 秒人耳基本察觉不到，却能把差距真正收敛掉。
      this.catchingUp = true
      if (!this._nudgeSince) this._nudgeSince = Date.now()
      if (Date.now() - this._nudgeSince > 8000) {
        // 追了 8 秒还没追上，说明不是「小偏差」而是卡住了，硬跳一次
        this._nudgeSince = 0
        this.setPlayRate(1)
        this.musicSeekQuiet(target, true)
        return
      }
      const nudge = Math.min(0.08, abs * 0.18)
      this.setPlayRate(drift < 0 ? 1 + nudge : 1 - nudge)
    },

    /**
     * 变速对齐。范围锁在 ±6%，并强制不变调，听感上察觉不到，
     * 但能在几秒内把两边拉到 100ms 以内。
     */
    setPlayRate(rate) {
      const r = Math.max(0.9, Math.min(1.1, Number(rate) || 1))
      if (Math.abs((this._appliedRate || 1) - r) < 0.001) return
      this._appliedRate = r
      const media = this.mediaEl()
      if (!media) return
      try {
        if ('preservesPitch' in media) media.preservesPitch = true
        else if ('webkitPreservesPitch' in media) media.webkitPreservesPitch = true
        else if ('mozPreservesPitch' in media) media.mozPreservesPitch = true
        media.playbackRate = r
      } catch (e) {}
    },

    togglePlay() {
      if (!this.currentSong) {
        if (!this.queue.length) {
          uni.showToast({ title: '请先添加歌曲', icon: 'none' })
          return
        }
        this.socket.emit('music-play', { roomId: this.room.id, index: 0 })
        return
      }
      const next = !this.playing
      this._controlGuardUntil = Date.now() + 1200
      if (next) {
        // 关键：不自己先响。先上报，等服务端确认每个都加载好了，
        // 再定一个共同的开播时刻，两边同一毫秒出声。
        // （以前这里是本地先播、别人再追，手机慢一步就永远追不上。）
        this.waitingStart = true
        this.autoplayBlocked = false
        this.socket.emit('music-play', {
          roomId: this.room.id,
          time: this.audio ? this.audio.currentTime : this.time,
          atServer: serverNow()
        })
        return
      }
      this.playing = false
      this.waitingStart = false
      this.clearStartTimers()
      this.startingIn = 0
      if (this.audio) this.audio.pause()
      this.socket.emit('music-pause', {
        roomId: this.room.id,
        time: this.audio ? this.audio.currentTime : this.time,
        atServer: serverNow()
      })
    },

    nextSong() {
      this.socket.emit('music-next', { roomId: this.room.id })
    },

    prevSong() {
      this.socket.emit('music-prev', { roomId: this.room.id })
    },

    onSeek(e) {
      this.seeking = false
      this.seekTo(Number(e.detail.value) || 0)
    },

    // 统一的跳转入口：进度条拖动和点歌词都走这里
    seekTo(time) {
      const t = Math.max(0, Number(time) || 0)
      this.time = t
      this.seekValue = t
      this.seeking = false
      if (!this.currentSong) return
      // 房主的请求一定被接受，本地先跳省一次往返；
      // 成员若是没权限，预跳会造成「跳了又被拉回」，所以等服务端广播确认
      if (this.isHost) this.seekAudio(t)
      if (this.socket && this.room) {
        this.socket.emit('music-seek', { roomId: this.room.id, time: t, atServer: serverNow() })
      }
    },

    // 点歌词某一句 → 跳到该句时间点
    seekToLyric(i) {
      const line = this.lyricLines[i]
      if (!line || !this.currentSong) return
      this.seekTo(line.time)
      // 用户可能手动滚过歌词，这里把点中的那句重新居中
      this.$nextTick(() => {
        const prev = this.lyricScrollTop
        this.syncLyricScroll()
        if (this.lyricScrollTop === prev) {
          // 值没变化时 Vue 不会重绘 scroll-view，偏移 1px 逼它滚一次
          this.lyricScrollTop = prev + 1
          this.$nextTick(() => this.syncLyricScroll())
        }
      })
    },

    async loadRecommend() {
      if (this.loadingRecommend) return
      this.loadingRecommend = true
      try {
        const data = await requestJSON(`${getServerBase()}/api/music/recommend`)
        this.recommendSongs = Array.isArray(data) ? data : []
        if (!this.recommendSongs.length) {
          uni.showToast({ title: '今日推荐加载失败', icon: 'none' })
        }
      } catch (err) {
        this.recommendSongs = []
        uni.showToast({ title: (err && err.message) || '今日推荐加载失败', icon: 'none' })
      } finally {
        this.loadingRecommend = false
      }
    },

    async searchMusic() {
      const keyword = (this.searchKeyword || '').trim()
      if (!keyword) {
        uni.showToast({ title: '请输入搜索关键词', icon: 'none' })
        return
      }
      this.searching = true
      try {
        const data = await requestJSON(`${getServerBase()}/api/music/search?keyword=${encodeURIComponent(keyword)}&server=${this.searchServer}`)
        if (Array.isArray(data)) {
          this.searchResults = data
          if (!data.length) {
            uni.showToast({ title: '没有搜到相关歌曲', icon: 'none' })
          }
        } else {
          this.searchResults = []
          uni.showToast({ title: (data && data.error) || '没有搜索到歌曲', icon: 'none' })
        }
      } catch (err) {
        this.searchResults = []
        uni.showToast({ title: (err && err.message) || '搜索失败', icon: 'none' })
      } finally {
        this.searching = false
      }
    },

    async addSearchSong(item) {
      if (!item || !item.id) {
        uni.showToast({ title: '搜索结果缺少歌曲 ID', icon: 'none' })
        return
      }
      if (this.addingSongId) return
      let url = item.url || ''
      if (!url) {
        this.addingSongId = item.id
        try {
          const data = await this.fetchMusicUrl(item.id)
          url = data && data.url
        } catch (err) {
          uni.showToast({
            title: (err && err.message) || '获取播放地址失败',
            icon: 'none',
            duration: 2600
          })
          return
        } finally {
          this.addingSongId = ''
        }
      }
      if (!url) {
        uni.showToast({ title: '这首歌曲暂时无法获取播放地址', icon: 'none', duration: 2400 })
        return
      }
      this.socket.emit('music-add-song', {
        roomId: this.room.id,
        time: this.audio ? this.audio.currentTime : this.time,
        playing: this.playing,
        song: {
          id: item.id,
          title: item.title,
          author: item.author,
          url,
          duration: Number(item.duration) || 0,
          pic: item.pic || '',
          lrc: item.lrc || ''
        }
      })
      uni.showToast({ title: '已点歌', icon: 'success' })
    },

    // 取播放地址：网络抖动 / 服务端一时探不通时自动重试一次；
    // 但「这首歌是 VIP 或没有版权」这种明确答复不重试，重试也没用。
    async fetchMusicUrl(id) {
      let lastErr = null
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await requestJSON(`${getServerBase()}/api/music/url?id=${encodeURIComponent(id)}&server=${this.searchServer}`)
        } catch (err) {
          lastErr = err
          const code = err && err.statusCode
          const retriable = !code || code >= 500
          if (!retriable || attempt === 1) break
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
      throw lastErr || new Error('获取播放地址失败')
    },

    addSongByUrl() {
      const url = (this.songUrl || '').trim()
      if (!url) {
        uni.showToast({ title: '请先输入音频链接', icon: 'none' })
        return
      }
      const title = url.split('/').pop().split('?')[0] || '在线歌曲'
      this.socket.emit('music-add-song', {
        roomId: this.room.id,
        song: {
          title,
          url,
          duration: 0
        }
      })
      this.songUrl = ''
    },

    // ---------- 本地音频导入 ----------
    // 选一个本地文件 → 上传到本服务 → 作为队列歌曲在这个播放器里播。
    // 不做「只在本地起 blob 地址」的方案：这是多人同步房间，房主每 2.5 秒广播一次进度，
    // 本地文件别人听不到，还会被同步逻辑来回拉扯，谁都听不痛快。
    pickLocalAudio() {
      if (this.localUploading) return
      if (!this.room) return
      // #ifdef H5
      if (typeof document === 'undefined') return
      if (this._localInput && this._localInput.parentNode) {
        this._localInput.parentNode.removeChild(this._localInput)
      }
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'audio/*,.mp3,.m4a,.wav,.aac,.ogg,.flac'
      input.style.position = 'fixed'
      input.style.left = '-9999px'
      input.style.opacity = '0'
      input.onchange = () => {
        const file = input.files && input.files[0]
        if (input.parentNode) input.parentNode.removeChild(input)
        this._localInput = null
        if (file) this.uploadLocalAudio(file)
      }
      this._localInput = input
      document.body.appendChild(input)
      input.click()
      // #endif
      // #ifndef H5
      uni.showToast({ title: '请在电脑网页端导入本地音频', icon: 'none' })
      // #endif
    },

    // 文件名当曲名（去掉扩展名、下划线换空格），没有封面就走播放器的唱片占位动画
    prettyLocalTitle(name) {
      let title = String(name || '').replace(/\.[^.]+$/, '')
      title = title.replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim()
      return title || '本地音频'
    },

    finishLocalUpload() {
      this.localUploading = false
      this.localUploadPercent = 0
      this.localUploadName = ''
    },

    uploadLocalAudio(file) {
      if (!file || !this.room) return
      if (!/^audio\//i.test(file.type || '') && !/\.(mp3|m4a|wav|aac|ogg|flac)$/i.test(file.name || '')) {
        uni.showToast({ title: '请选择音频文件', icon: 'none' })
        return
      }
      this.localUploading = true
      this.localUploadName = this.prettyLocalTitle(file.name)
      this.localUploadPercent = 0
      // 先把时长老老实实探出来，否则进度条右边会一直是 --:--
      this.probeAudioDuration(file).then(
        (duration) => this.doUploadLocalAudio(file, duration),
        () => this.doUploadLocalAudio(file, 0)
      )
    },

    // 用临时 audio 元素读 metadata 拿时长（不加载全曲，几毫秒就回来）
    probeAudioDuration(file) {
      return new Promise((resolve) => {
        let url = ''
        try {
          url = URL.createObjectURL(file)
        } catch (e) {
          return resolve(0)
        }
        const el = document.createElement('audio')
        let done = false
        const finish = (value) => {
          if (done) return
          done = true
          try { URL.revokeObjectURL(url) } catch (e) { /* 忽略 */ }
          el.removeAttribute('src')
          resolve(Number.isFinite(value) && value > 0 ? Math.round(value) : 0)
        }
        el.preload = 'metadata'
        el.onloadedmetadata = () => finish(el.duration)
        el.onerror = () => finish(0)
        setTimeout(() => finish(0), 4000)
        el.src = url
      })
    },

    doUploadLocalAudio(file, duration) {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${getServerBase()}/api/upload`)
      xhr.upload.onprogress = (ev) => {
        if (!ev.lengthComputable) return
        // 留 1% 给服务端落盘，避免进度卡在 100% 却还没响应
        this.localUploadPercent = Math.min(99, Math.round((ev.loaded / ev.total) * 100))
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          let data = {}
          try { data = JSON.parse(xhr.responseText) } catch (e) { data = {} }
          // 优先用相对路径：队列里存 /uploads/xxx，谁打开都能按自己的服务地址拼
          const url = data.path || data.url || ''
          if (!url) {
            this.finishLocalUpload()
            uni.showToast({ title: '上传成功但没拿到文件地址', icon: 'none', duration: 2600 })
            return
          }
          this.localUploadPercent = 100
          this.socket.emit('music-add-song', {
            roomId: this.room.id,
            time: this.audio ? this.audio.currentTime : this.time,
            playing: this.playing,
            song: {
              title: this.prettyLocalTitle(file.name),
              author: '本地导入',
              url,
              duration: duration || 0
            }
          })
          // 房主导入的这首，直接切过去播（队列里已有的歌不受影响，只是当前播放换成这首）
          if (this.isHost) {
            this._pendingLocalSongKey = `${this.prettyLocalTitle(file.name)}|${Number(duration) || 0}`
          }
          const autoPlay = this.isHost
          setTimeout(() => this.finishLocalUpload(), 260)
          uni.showToast({
            title: autoPlay ? '已导入，正在播放' : '已加入播放队列',
            icon: 'none',
            duration: 2000
          })
          return
        }
        let msg = '上传失败，请稍后重试'
        try {
          const body = JSON.parse(xhr.responseText)
          if (body && body.error) msg = body.error
        } catch (e) { /* 非 JSON 就走默认文案 */ }
        if (xhr.status === 413) msg = '文件太大，已超过服务端上传上限'
        this.finishLocalUpload()
        uni.showToast({ title: msg, icon: 'none', duration: 2800 })
      }
      xhr.onerror = () => {
        this.finishLocalUpload()
        uni.showToast({ title: '网络连接失败，音频没有上传成功', icon: 'none', duration: 2600 })
      }
      const form = new FormData()
      form.append('file', file, file.name)
      xhr.send(form)
    },

    removeSong(index) {
      if (!this.isHost) return
      this.socket.emit('music-remove-song', {
        roomId: this.room.id,
        index
      })
    },

    back() {
      uni.navigateBack()
    }
  }
}
</script>

<style scoped>
.music-room-page {
  min-height: 100vh;
  max-width: 560px;
  margin: 0 auto;
  padding: 16px;
  box-sizing: border-box;
  background: transparent;
  color: #14342a;
}

.music-room-page .input-field {
  color: #14342a;
  background: #f6fcf9;
  height: 54px;
  min-height: 54px;
  padding: 0 16px;
  font-size: 16px;
  line-height: 54px;
  border: 1px solid rgba(16, 122, 86, 0.16);
  border-radius: 12px;
  box-sizing: border-box;
}

.music-room-page .input-field input::placeholder,
.music-room-page .input-field .uni-input-placeholder {
  color: #8aa89b !important;
  opacity: 1 !important;
}

.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0 12px;
}

.btn-back {
  width: 56px;
  background: #f1faf5;
  color: #0b7a4c;
  border: 1px solid rgba(16, 157, 99, 0.22);
  border-radius: 10px;
  padding: 6px 0;
  font-size: 14px;
  text-align: center;
  flex-shrink: 0;
}

.room-title {
  flex: 1;
  text-align: center;
  font-size: 18px;
  font-weight: 700;
  color: #14342a;
  white-space: nowrap;
}

.room-id {
  min-width: 70px;
  color: #0f7a4f;
  font-weight: 700;
  letter-spacing: 1px;
  text-align: right;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ---------- 顶栏中间：标题 + 导入本地音频 ---------- */
.tb-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
}

.tb-center .room-title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.btn-local {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  min-width: 26px;
  padding: 0;
  margin: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(110, 231, 255, 0.1);
  border: 1px solid rgba(110, 231, 255, 0.34);
  color: #9fe9ff;
  line-height: 1;
}

.btn-local::after {
  border: none;
}

.btn-local-inner {
  font-size: 15px;
  line-height: 1;
}

.btn-local--active {
  background: rgba(110, 231, 255, 0.26);
  opacity: 1;
}

/* ---------- 本地上传进度浮层 ---------- */
.upload-float {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  width: 320px;
  max-width: calc(100vw - 48px);
  padding: 12px 14px;
  border-radius: 14px;
  background: rgba(9, 18, 38, 0.94);
  border: 1px solid rgba(110, 231, 255, 0.24);
  box-shadow: 0 14px 34px rgba(4, 10, 26, 0.55);
}

.upload-float-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.upload-float-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--c-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.upload-float-pct {
  font-family: var(--font-mono);
  font-size: 12px;
  color: #6ee7ff;
}

.upload-float-bar {
  margin-top: 8px;
  height: 4px;
  border-radius: 999px;
  background: rgba(184, 198, 255, 0.16);
  overflow: hidden;
}

.upload-float-fill {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #4d6bfe, #6ee7ff);
  transition: width 0.2s ease;
}

.upload-float-tip {
  display: block;
  margin-top: 7px;
  font-size: 11px;
  color: var(--c-text-3);
}

/* ---------- 柔光白卡播放器（浅色 Neumorphism） ---------- */
.now-playing {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 22px 22px 26px;
  border: 1px solid rgba(16, 122, 86, 0.08);
  border-radius: 28px;
  background: linear-gradient(145deg, #ffffff 0%, #eff8f3 100%);
  box-shadow:
    -8px -8px 20px rgba(255, 255, 255, 0.95),
    16px 16px 36px rgba(20, 80, 55, 0.16),
    inset 0 1px 0 rgba(255, 255, 255, 0.95);
  color: #1d3b2f;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.music-room-page .card {
  color: #14342a;
}

.music-room-page .now-playing {
  color: #1d3b2f;
}

.np-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.np-label {
  font-size: 11px;
  letter-spacing: 2px;
  color: #7d9a8c;
}

.np-badge {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  color: #4f7363;
  background: #eef8f2;
  box-shadow: inset 2px 2px 5px rgba(20, 80, 55, 0.1), inset -2px -2px 5px rgba(255, 255, 255, 0.95);
}

.np-badge::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #0f9d63;
  box-shadow: 0 0 6px rgba(15, 157, 99, 0.7);
}

.np-badge.is-playing::before {
  animation: np-pulse 1.6s ease-in-out infinite;
}

@keyframes np-pulse {
  0%,
  100% {
    opacity: 1;
    transform: scale(1);
  }

  50% {
    opacity: 0.45;
    transform: scale(0.8);
  }
}

/* 封面 / 歌词 共用的舞台：整块都可点，轻点切换 */
.np-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 236px;
  border-radius: 24px;
  overflow: hidden;
  cursor: pointer;
  user-select: none;
  -webkit-user-select: none;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.3s ease, box-shadow 0.3s ease;
}

.np-stage:active {
  background: rgba(15, 157, 99, 0.06);
}

.np-stage.show-lyrics {
  background: linear-gradient(160deg, #eef8f2 0%, #f7fdfa 100%);
  box-shadow:
    inset 5px 5px 12px rgba(20, 80, 55, 0.08),
    inset -5px -5px 12px rgba(255, 255, 255, 0.95);
}

/* 歌词面板 */
.lyric-wrap {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* 上下渐隐，让滚出边界的句子淡出 */
.lyric-wrap::before,
.lyric-wrap::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 56px;
  pointer-events: none;
  z-index: 2;
}

.lyric-wrap::before {
  top: 0;
  background: linear-gradient(180deg, #f4fcf8 0%, rgba(244, 252, 248, 0) 100%);
}

.lyric-wrap::after {
  bottom: 0;
  background: linear-gradient(0deg, #f4fcf8 0%, rgba(244, 252, 248, 0) 100%);
}

.lyric-scroll {
  width: 100%;
  height: 100%;
}

.lyric-spacer {
  height: 88px;
}

.lyric-line {
  padding: 6px 26px;
  text-align: center;
  font-size: 14px;
  line-height: 1.55;
  color: #9cb3a7;
  word-break: break-word;
  border-radius: 12px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: color 0.35s ease, transform 0.35s ease, text-shadow 0.35s ease,
    background-color 0.18s ease;
}

/* 点一下给个即时反馈，说明这行是可以跳转的 */
.lyric-line:hover {
  color: #4f8a6d;
  background: rgba(15, 157, 99, 0.07);
}

.lyric-line:active {
  background: rgba(15, 157, 99, 0.14);
  color: #2f7a58;
}

.lyric-line.active {
  color: #0b6b46;
  font-weight: 700;
  transform: scale(1.06);
  text-shadow: 0 1px 10px rgba(15, 157, 99, 0.24);
}

.lyric-empty {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  color: #9cb3a7;
  pointer-events: none;
  z-index: 2;
}

.np-hint {
  position: absolute;
  left: 50%;
  bottom: 7px;
  transform: translateX(-50%);
  padding: 3px 11px;
  border-radius: 999px;
  font-size: 10px;
  letter-spacing: 0.5px;
  color: #7d9a8c;
  white-space: nowrap;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 1px 4px rgba(20, 80, 55, 0.08);
  pointer-events: none;
  z-index: 3;
}

/* 歌词状态下的返回提示：压在底部渐隐带上，透明度再低一档，不抢歌词 */
.np-hint--lyric {
  opacity: 0.72;
  background: rgba(255, 255, 255, 0.62);
  /* 歌词态时它就是「收起歌词」的按钮，要能点到 */
  pointer-events: auto;
  cursor: pointer;
  transition: opacity 0.2s ease, background-color 0.2s ease;
}

.np-hint--lyric:hover,
.np-hint--lyric:active {
  opacity: 1;
  background: rgba(255, 255, 255, 0.9);
}

.disc-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6px 0 2px;
}

.disc {
  position: relative;
  width: 172px;
  height: 172px;
  border-radius: 50%;
  background: radial-gradient(circle at 50% 40%, #ffffff 0%, #f1fbf6 44%, #d7ece1 100%);
  box-shadow:
    -7px -7px 16px rgba(255, 255, 255, 0.95),
    10px 10px 24px rgba(20, 80, 55, 0.16),
    inset 0 0 0 1px rgba(16, 122, 86, 0.14),
    inset 0 0 0 9px rgba(255, 255, 255, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.disc-cover {
  width: 124px;
  height: 124px;
  border-radius: 50%;
  box-shadow: 0 4px 12px rgba(20, 80, 55, 0.18);
}

.disc.is-playing .disc-cover {
  animation: np-spin 18s linear infinite;
}

.disc-core {
  width: 124px;
  height: 124px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(145deg, #e6f6ee, #fafefc);
  box-shadow: inset 6px 6px 12px rgba(20, 80, 55, 0.14), inset -6px -6px 12px rgba(255, 255, 255, 0.95), inset 0 0 0 1px rgba(16, 122, 86, 0.08);
}

.eq {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 38px;
}

.eq-bar {
  width: 4px;
  height: 10px;
  border-radius: 2px;
  background: linear-gradient(180deg, #6ee7b7 0%, #0f9d63 100%);
  animation: np-eq 1.1s ease-in-out infinite alternate;
  animation-play-state: paused;
}

.disc.is-playing .eq-bar {
  animation-play-state: running;
}

@keyframes np-eq {
  from {
    height: 8px;
  }

  to {
    height: 34px;
  }
}

@keyframes np-spin {
  to {
    transform: rotate(360deg);
  }
}

.song-info {
  text-align: center;
}

.song-title {
  display: block;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: 0.3px;
  color: #14342a;
}

.song-artist {
  display: block;
  margin-top: 6px;
  font-size: 12px;
  color: #7d9a8c;
}

.progress-block {
  margin-top: 2px;
}

.progress {
  width: 100%;
  margin: 0;
  padding: 0 2px;
  box-sizing: border-box;
}

.time-row {
  display: flex;
  justify-content: space-between;
  padding: 0 6px;
  margin-top: -2px;
  font-size: 11px;
  color: #7d9a8c;
}

.player-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 34px;
  margin-top: 8px;
  padding: 2px 0;
  width: 100%;
}

/* 空格键快捷键提示（仅 H5 桌面端） */
.kbd-hint {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-top: 2px;
  font-size: 11px;
  color: #8aa89b;
  letter-spacing: 0.5px;
}

.kbd {
  padding: 2px 7px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.9);
  border: 1px solid rgba(16, 122, 86, 0.18);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.9), 0 2px 5px rgba(20, 80, 55, 0.1);
  font-size: 10px;
  color: #4f7363;
  letter-spacing: 1px;
}

.control-btn {
  width: 54px;
  height: 54px;
  padding: 0;
  margin: 0;
  border: none;
  border-radius: 50%;
  background: linear-gradient(145deg, #ffffff, #eef8f2);
  color: #4f7363;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow:
    -6px -6px 14px rgba(255, 255, 255, 0.95),
    8px 8px 18px rgba(20, 80, 55, 0.14);
  transition: box-shadow 0.18s ease, transform 0.18s ease;
}

.control-btn::after {
  border: none;
}

.control-btn:active,
.control-btn--pressed {
  transform: scale(0.96);
  background: linear-gradient(145deg, #e7f4ec, #f7fdfa);
  box-shadow:
    inset 6px 6px 12px rgba(20, 80, 55, 0.14),
    inset -5px -5px 10px rgba(255, 255, 255, 0.9);
}

.control-btn.main {
  width: 66px;
  height: 66px;
  color: #ffffff;
  background: linear-gradient(145deg, #34d399 0%, #0f9d63 100%);
  box-shadow:
    -4px -4px 12px rgba(255, 255, 255, 0.8),
    8px 10px 22px rgba(15, 157, 99, 0.35);
}

.control-btn.main:active,
.control-btn.main.control-btn--pressed {
  background: linear-gradient(145deg, #0f9d63 0%, #0b7a4c 100%);
  box-shadow:
    inset 7px 7px 14px rgba(6, 60, 38, 0.45),
    inset -4px -4px 10px rgba(255, 255, 255, 0.18);
}

.ctrl-icon {
  color: inherit;
  font-size: 20px;
  line-height: 1;
}

.ctrl-prev,
.ctrl-next {
  font-size: 13px;
  letter-spacing: -1px;
}

.control-btn.main .ctrl-icon {
  font-size: 21px;
}

/* 盖在唱片上的「点一下开始播放」：手机没有这个就永远没声音 */
.play-gate {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: rgba(8, 18, 34, 0.62);
  backdrop-filter: blur(3px);
  -webkit-backdrop-filter: blur(3px);
}

.play-gate-btn {
  width: 68px;
  height: 68px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  color: #06121f;
  background: linear-gradient(160deg, #a8f0ff, #57d3ff);
  box-shadow: 0 10px 26px -10px rgba(110, 231, 255, 0.9);
  animation: playGatePulse 1.8s ease-in-out infinite;
}

.play-gate-text {
  font-size: 14px;
  font-weight: 700;
  color: #eaf6ff;
}

.play-gate-sub {
  font-size: 11px;
  color: rgba(234, 246, 255, 0.7);
}

/* 等好友准备好：转圈，别让人以为卡住了 */
.play-gate--wait {
  background: rgba(8, 18, 34, 0.72);
}

.play-gate-spin {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  border: 3px solid rgba(110, 231, 255, 0.22);
  border-top-color: #6ee7ff;
  animation: playGateSpin 0.9s linear infinite;
}

@keyframes playGateSpin {
  to { transform: rotate(360deg); }
}

/* 倒计时：数到 0 就一起响 */
.play-gate--count {
  background: rgba(8, 18, 34, 0.42);
}

.play-gate-num {
  font-size: 46px;
  font-weight: 800;
  line-height: 1;
  color: #6ee7ff;
  text-shadow: 0 0 26px rgba(110, 231, 255, 0.55);
}

@media (prefers-reduced-motion: reduce) {
  .play-gate-spin { animation: none; }
}

@keyframes playGatePulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.06); }
}

@media (prefers-reduced-motion: reduce) {
  .play-gate-btn { animation: none; }
}

@media (prefers-reduced-motion: reduce) {
  .disc.is-playing .disc-cover,
  .disc.is-playing .eq-bar,
  .np-badge.is-playing::before,
  .queue-bar {
    animation: none !important;
  }
}

.search-cover,
.queue-cover {
  width: 38px;
  height: 38px;
  border-radius: 8px;
  flex-shrink: 0;
  background: #eef8f2;
  text-align: center;
  line-height: 38px;
  font-size: 20px;
}

.search-cover.placeholder,
.queue-cover.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
}

.file-input {
  width: 100%;
  box-sizing: border-box;
  padding: 8px;
  margin: 10px 0;
  border: 1px dashed rgba(16, 122, 86, 0.24);
  border-radius: 8px;
  background: #f7fcf9;
  font-size: 13px;
}

.tip-center {
  text-align: center;
  color: #6b8a7c;
  font-size: 13px;
  margin: 12px 0;
}

.my-count {
  font-size: 13px;
  font-weight: normal;
  color: #0f9d63;
}

.search-tip {
  margin-top: 10px;
  font-size: 12px;
  color: #0f9d63;
}

.empty-hint {
  margin-top: 12px;
  padding: 16px 12px;
  border: 1px dashed #cfe6da;
  border-radius: 12px;
  text-align: center;
  color: #7d9a8c;
  font-size: 13px;
  line-height: 1.6;
}

.empty-queue {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24px 12px;
  color: #7d9a8c;
}

.empty-icon {
  font-size: 34px;
}

.empty-title {
  margin-top: 8px;
  font-size: 15px;
  color: #37584a;
}

.empty-desc {
  margin-top: 4px;
  font-size: 12px;
  color: #8aa89b;
}

.search-row {
  display: flex;
  gap: 8px;
}

.search-input {
  flex: 1;
  margin-bottom: 0;
}

.search-btn {
  width: 80px;
  margin-top: 0;
  height: 54px;
  line-height: 54px;
  padding: 0;
  background: #f4fbf7;
  color: #0b7a4c;
  border: 1px solid rgba(16, 122, 86, 0.2);
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
}

.search-btn::after {
  border: none;
}

.search-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid rgba(16, 122, 86, 0.08);
}

.queue-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 10px;
  margin: 0 -10px;
  border-radius: 12px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background-color 0.2s ease;
}

.queue-item::after {
  content: '';
  position: absolute;
  left: 92px;
  right: 10px;
  bottom: 0;
  height: 1px;
  background: rgba(16, 122, 86, 0.08);
  transition: opacity 0.2s ease;
}

.queue-item:last-child::after {
  display: none;
}

.queue-item--hover,
.queue-item:active {
  background: rgba(15, 157, 99, 0.06);
}

.queue-item.active {
  color: #0f9d63;
  background: rgba(15, 157, 99, 0.08);
}

.queue-item.active::after {
  opacity: 0;
}

.queue-item.active .queue-title {
  color: #0b7a4c;
  font-weight: 700;
}

.queue-index {
  width: 24px;
  flex: 0 0 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.queue-num {
  font-size: 12px;
  color: #9ab5a7;
  font-variant-numeric: tabular-nums;
}

.queue-item.active .queue-num {
  color: #0f9d63;
  font-weight: 700;
}

/* 当前曲目：三根跳动的音量条代替序号 */
.queue-bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 16px;
}

.queue-bar {
  width: 3px;
  height: 10px;
  border-radius: 2px;
  background: linear-gradient(180deg, #6ee7b7 0%, #0f9d63 100%);
  animation: queue-eq 0.9s ease-in-out infinite alternate;
}

.queue-bars.paused .queue-bar {
  animation: none;
  opacity: 0.55;
  height: 5px;
}

.queue-bars.paused .queue-bar:nth-child(2) {
  height: 10px;
}

@keyframes queue-eq {
  0% {
    height: 6px;
    opacity: 0.7;
  }
  100% {
    height: 16px;
    opacity: 1;
  }
}

.queue-info {
  flex: 1;
  min-width: 0;
}

.queue-title {
  display: block;
  font-size: 15px;
  color: #233f34;
}

.queue-sub {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: #8aa89b;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-now {
  flex: 0 0 auto;
  font-size: 11px;
  color: #0b7a4c;
  font-weight: 600;
  background: rgba(15, 157, 99, 0.12);
  border-radius: 999px;
  padding: 3px 9px;
}

.queue-remove {
  background: #fdecec;
  color: #c0392b;
  border: none;
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 12px;
}

.queue-remove--pressed {
  background: #fbdede;
}

.loading {
  text-align: center;
  padding: 80px 0;
  color: #6b8a7c;
}

.error {
  background: #fdecec;
  color: #c0392b;
  border: 1px solid rgba(217, 83, 79, 0.22);
  border-radius: 12px;
  padding: 12px 14px;
  margin-bottom: 16px;
  font-size: 13px;
  line-height: 1.6;
}

/* 两栏布局：宽屏时播放队列常驻在播放器右侧，窄屏自动落到下方 */
.room-layout {
  display: flex;
  flex-direction: column;
}

.room-main,
.room-side {
  min-width: 0;
}

.room-side {
  display: flex;
  flex-direction: column;
}

/* 桌面端给播放器更舒展的比例 */
@media (min-width: 900px) {
  .music-room-page {
    max-width: 1120px;
    padding: 20px;
  }

  .room-layout {
    flex-direction: row;
    align-items: flex-start;
    gap: 20px;
  }

  .room-main {
    flex: 1 1 420px;
    max-width: 660px;
  }

  .room-side {
    flex: 0 0 348px;
    position: sticky;
    top: 18px;
  }

  /* 队列卡撑到视口高度，队列长时在卡内滚动，播放器不被顶走 */
  .room-side .queue-card {
    height: calc(100vh - 128px);
    max-height: 780px;
    box-sizing: border-box;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .room-side .queue-card::-webkit-scrollbar {
    width: 6px;
  }

  .room-side .queue-card::-webkit-scrollbar-thumb {
    background: rgba(15, 157, 99, 0.22);
    border-radius: 999px;
  }

  .room-side .queue-card::-webkit-scrollbar-track {
    background: transparent;
  }

  .disc {
    width: 190px;
    height: 190px;
  }

  .disc-cover,
  .disc-core {
    width: 138px;
    height: 138px;
  }

  .now-playing {
    padding: 26px 26px 30px;
    gap: 16px;
  }

  .np-stage {
    height: 256px;
  }

  .lyric-line {
    font-size: 15px;
    padding: 7px 30px;
  }

  .lyric-spacer {
    height: 98px;
  }
}

/* ============================================================
   深海覆盖：外壳 + 深色 Neumorphism 播放器
   ============================================================ */
.music-room-page { color: var(--c-text); }
.music-room-page .card { color: var(--c-text); }
.music-room-page .now-playing { color: var(--c-text); }

.top-bar { border-bottom: none; }
.btn-back {
  background: rgba(11, 23, 48, 0.72);
  color: var(--c-text);
  border-color: var(--c-line);
}
.room-title { color: var(--c-text); }
.room-id { color: var(--c-primary-soft); }

.music-room-page .input-field {
  color: var(--c-text);
  background: #0a1428;
  border-color: rgba(184, 198, 255, 0.18);
}
.music-room-page .input-field input::placeholder,
.music-room-page .input-field .uni-input-placeholder { color: #7f93c4 !important; }

/* ---------- 深色挤压播放器 ---------- */
.now-playing {
  background: linear-gradient(145deg, #101f3c 0%, #0a1428 100%);
  border-color: rgba(184, 198, 255, 0.16);
  box-shadow:
    -8px -8px 20px rgba(110, 231, 255, 0.06),
    14px 14px 34px rgba(0, 0, 0, 0.55),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.np-label { color: var(--c-text-3); }

.np-badge {
  color: var(--c-text-2);
  background: rgba(6, 10, 22, 0.72);
  box-shadow: inset 2px 2px 5px rgba(0, 0, 0, 0.4), inset -2px -2px 5px rgba(255, 255, 255, 0.05);
}
.np-badge::before {
  background: var(--c-primary-soft);
  box-shadow: 0 0 8px rgba(110, 231, 255, 0.7);
}

.np-stage:active { background: rgba(110, 231, 255, 0.05); }
.np-stage.show-lyrics {
  background: linear-gradient(160deg, #0a1428 0%, #0d1a33 100%);
  box-shadow:
    inset 5px 5px 12px rgba(0, 0, 0, 0.45),
    inset -5px -5px 12px rgba(255, 255, 255, 0.04);
}

.lyric-wrap::before { background: linear-gradient(180deg, #0d1a33 0%, rgba(13, 26, 51, 0) 100%); }
.lyric-wrap::after { background: linear-gradient(0deg, #0d1a33 0%, rgba(13, 26, 51, 0) 100%); }
.lyric-line { color: #7f93c4; }
.lyric-line:hover { color: var(--c-text-2); background: rgba(110, 231, 255, 0.06); }
.lyric-line:active { color: var(--c-text); background: rgba(110, 231, 255, 0.12); }
.lyric-line.active { color: var(--c-primary-soft); text-shadow: 0 1px 12px rgba(110, 231, 255, 0.35); }
.lyric-empty { color: var(--c-text-3); }

.np-hint {
  color: var(--c-text-3);
  background: rgba(6, 10, 22, 0.72);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4);
}
.np-hint--lyric { background: rgba(6, 10, 22, 0.72); }
.np-hint--lyric:hover,
.np-hint--lyric:active { background: rgba(16, 32, 64, 0.9); }

.disc {
  background: radial-gradient(circle at 50% 40%, #16294d 0%, #0d1a33 48%, #080f1f 100%);
  box-shadow:
    -7px -7px 16px rgba(110, 231, 255, 0.07),
    10px 10px 24px rgba(0, 0, 0, 0.55),
    inset 0 0 0 1px rgba(184, 198, 255, 0.16),
    inset 0 0 0 9px rgba(255, 255, 255, 0.035);
}
.disc-cover { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5); }
.disc-core {
  background: linear-gradient(145deg, #0a1428, #101f3c);
  box-shadow:
    inset 6px 6px 12px rgba(0, 0, 0, 0.5),
    inset -6px -6px 12px rgba(255, 255, 255, 0.05),
    inset 0 0 0 1px rgba(184, 198, 255, 0.1);
}
.eq-bar { background: linear-gradient(180deg, #6ee7ff 0%, #4d6bfe 100%); }

.song-title { color: var(--c-text); }
.song-artist { color: var(--c-text-3); }
.time-row { color: var(--c-text-3); }

.kbd-hint { color: var(--c-text-3); }
.kbd {
  background: rgba(11, 23, 48, 0.8);
  border-color: rgba(184, 198, 255, 0.18);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.05), 0 2px 5px rgba(0, 0, 0, 0.3);
  color: var(--c-text-2);
}

.control-btn {
  background: linear-gradient(145deg, #101f3c, #0a1428);
  color: var(--c-text-2);
  box-shadow:
    -6px -6px 14px rgba(110, 231, 255, 0.05),
    8px 8px 18px rgba(0, 0, 0, 0.5);
}
.control-btn:active,
.control-btn--pressed {
  background: linear-gradient(145deg, #0a1428, #101f3c);
  box-shadow:
    inset 6px 6px 12px rgba(0, 0, 0, 0.55),
    inset -5px -5px 10px rgba(110, 231, 255, 0.07);
}
.control-btn.main {
  background: linear-gradient(145deg, #6d8bff 0%, #4d6bfe 100%);
  box-shadow:
    -4px -4px 12px rgba(110, 231, 255, 0.12),
    8px 10px 22px rgba(77, 107, 254, 0.4);
}
.control-btn.main:active,
.control-btn.main.control-btn--pressed {
  background: linear-gradient(145deg, #4d6bfe 0%, #3b55e0 100%);
  box-shadow:
    inset 7px 7px 14px rgba(12, 24, 70, 0.7),
    inset -4px -4px 10px rgba(255, 255, 255, 0.14);
}

.play-gate {
  background: rgba(3, 8, 18, 0.58);
}

.section-title,
.queue-title { color: var(--c-text); }
.my-count,
.search-tip { color: var(--c-primary-soft); }

.search-btn {
  background: rgba(11, 23, 48, 0.72);
  color: var(--c-text);
  border-color: rgba(184, 198, 255, 0.2);
}
.search-item { border-bottom-color: rgba(184, 198, 255, 0.1); }
.search-cover,
.queue-cover { background: #0a1428; }

.queue-item::after { background: rgba(184, 198, 255, 0.1); }
.queue-item--hover,
.queue-item:active { background: rgba(110, 231, 255, 0.05); }
.queue-item.active { color: var(--c-primary-soft); background: rgba(77, 107, 254, 0.16); }
.queue-item.active .queue-title { color: var(--c-primary-soft); }
.queue-num { color: var(--c-text-3); }
.queue-item.active .queue-num { color: var(--c-primary-soft); }
.queue-bar { background: linear-gradient(180deg, #6ee7ff 0%, #4d6bfe 100%); }
.queue-sub { color: var(--c-text-3); }
.queue-now {
  color: #bfe9ff;
  background: rgba(110, 231, 255, 0.12);
}
.queue-remove {
  background: rgba(255, 107, 138, 0.12);
  color: #ffb3c1;
}
.queue-remove--pressed { background: rgba(255, 107, 138, 0.2); }

.empty-queue,
.empty-desc,
.tip-center,
.loading { color: var(--c-text-3); }
.empty-title { color: var(--c-text-2); }
.empty-hint {
  border-color: rgba(184, 198, 255, 0.22);
  color: var(--c-text-3);
}

.file-input {
  background: #0a1428;
  border-color: rgba(184, 198, 255, 0.24);
  color: var(--c-text);
}

.error {
  background: rgba(255, 107, 138, 0.1);
  color: #ffb3c1;
  border-color: rgba(255, 107, 138, 0.26);
}

@media (min-width: 900px) {
  .room-side .queue-card::-webkit-scrollbar-thumb {
    background: rgba(110, 231, 255, 0.22);
  }
}

.empty-icon,
.search-cover.placeholder,
.queue-cover.placeholder {
  color: var(--c-primary-soft);
}
/* ============================================================
   编辑式压平：去掉大卡片面板，让唱片/文字落在画布上
   ============================================================ */
.music-room-page .now-playing {
  background: transparent;
  border: 0;
  border-radius: 0;
  box-shadow: none;
  padding: 6px 0 26px;
}

.music-room-page .card:not(.now-playing) {
  background: transparent;
  border: 0;
  border-top: 1px solid rgba(184, 198, 255, 0.16);
  border-radius: 0;
  box-shadow: none;
  padding: 20px 0;
  margin-bottom: 0;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.np-badge {
  background: transparent;
  border: 1px solid rgba(184, 198, 255, 0.18);
  box-shadow: none;
}

.np-hint {
  background: transparent;
  border: 1px solid rgba(184, 198, 255, 0.16);
  box-shadow: none;
}

.player-controls {
  gap: 22px;
  margin-top: 14px;
}

.control-btn {
  width: 44px;
  height: 44px;
  background: transparent;
  border: 1px solid rgba(184, 198, 255, 0.22);
  box-shadow: none;
  color: var(--c-text-2);
}

.control-btn:active,
.control-btn--pressed {
  background: rgba(110, 231, 255, 0.08);
  box-shadow: none;
  transform: scale(0.95);
}

.control-btn.main {
  width: 56px;
  height: 56px;
  background: rgba(77, 107, 254, 0.12);
  border-color: rgba(110, 231, 255, 0.5);
  color: var(--c-primary-soft);
  box-shadow: 0 0 30px rgba(77, 107, 254, 0.18);
}

.control-btn.main:active,
.control-btn.main.control-btn--pressed {
  background: rgba(77, 107, 254, 0.22);
  box-shadow: inset 0 0 0 1px rgba(110, 231, 255, 0.2);
}

.search-btn {
  width: auto;
  min-width: 64px;
  height: 46px;
  padding: 0 2px;
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(110, 231, 255, 0.32);
  border-radius: 0;
  color: var(--c-primary-soft);
  text-decoration: none;
}

.search-btn::after {
  border: none;
}

.search-btn:active {
  opacity: 0.65;
}

.music-room-page .section-title {
  font-weight: 300;
  font-size: 1.15rem;
  letter-spacing: 0.04em;
}

.music-room-page .top-bar {
  border-bottom: 1px solid rgba(184, 198, 255, 0.1);
  padding-bottom: 14px;
  margin-bottom: 18px;
}

/* 输入框 / 返回按钮也压成细线 */
.music-room-page .input-field {
  background: transparent;
  border: 0;
  border-bottom: 1px solid rgba(184, 198, 255, 0.22);
  border-radius: 0;
  padding: 0;
  box-shadow: none;
}

.btn-back {
  width: auto;
  padding: 6px 0;
  background: transparent;
  border: 0;
  border-radius: 0;
  color: var(--c-text-3);
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 4px;
}

.room-title {
  font-weight: 300;
  letter-spacing: 0.1em;
}

.room-id {
  font-family: var(--font-mono);
  font-weight: 400;
  font-size: 13px;
}

.song-title {
  font-weight: 300;
  font-size: 1.6rem;
  letter-spacing: 0.04em;
}

.song-artist {
  margin-top: 8px;
}

.search-btn {
  min-width: 0;
  width: auto;
  height: 38px;
  line-height: 38px;
  padding: 0 16px;
  background: rgba(77, 107, 254, 0.14);
  border: 1px solid rgba(110, 231, 255, 0.3);
  border-radius: 10px;
  color: var(--c-text);
  font-size: 12.5px;
  font-weight: 500;
}

.search-btn:active {
  background: rgba(77, 107, 254, 0.24);
  opacity: 1;
}

/* ---------- 手机端适配 ---------- */
@media (max-width: 768px) {
  /* 「Space 播放 / 暂停」是键盘提示，手机上没有键盘，纯噪音 */
  .kbd-hint {
    display: none !important;
  }

  /* 手机浏览器必须点一次才允许出声，这个提示要够显眼才有人点 */
  .play-gate { gap: 10px; }
  .play-gate-btn { width: 76px; height: 76px; font-size: 26px; }
  .play-gate-text { font-size: 15px; }
}
</style>

<style>
.music-room-page .input-field .uni-input-wrapper,
.music-room-page .input-field .uni-input-input,
.music-room-page .input-field input {
  height: 52px;
  min-height: 52px;
  line-height: 52px;
  font-size: 16px;
}
.music-room-page .input-field input {
  color: var(--c-text);
}

/* 让原生 slider 的滑块也带一点柔光 */
.music-room-page .uni-slider-handle,
.music-room-page .uni-slider-thumb {
  box-shadow: 0 3px 10px rgba(110, 231, 255, 0.35) !important;
  border: 2px solid #e6ecff !important;
}
.music-room-page .uni-slider-track {
  border-radius: 999px !important;
}
</style>
