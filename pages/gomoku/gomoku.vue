<template>
  <view class="container gomoku-page">
    <aurora-bg />
    <ann-banner />
    <!-- 未进入房间：创建 / 加入 -->
    <view v-if="!room && !isAiMode" class="lobby gl-lobby">
      <view class="gl-orbs">
        <view class="gl-orb orb-a"></view>
        <view class="gl-orb orb-b"></view>
        <view class="gl-orb orb-c"></view>
      </view>

      <view class="hero">
        <text class="title">星梦五子棋</text>
        <text class="subtitle">星河对弈 · 落子成诗</text>
      </view>

      <view class="gl-col">
        <view class="gl-card">
          <text class="gl-kicker">01 · 单机陪练</text>
          <text class="gl-card__title">人机对战</text>
          <button class="gl-btn" @click="startAiGame">开始人机对战</button>
          <text class="gl-note">本机即可玩，首局你执黑先手，之后每局交换先手</text>
        </view>

        <view class="gl-card">
          <text class="gl-kicker">02 · 联机对战</text>
          <text class="gl-card__title">创建五子棋房间</text>
          <button class="gl-btn" :disabled="connecting" @click="createRoom">
            {{ connecting ? '创建中...' : '创建房间' }}
          </button>
          <text class="gl-note">创建后出二维码：对方扫码直接坐上来，异地也能扫；也能发房间号</text>
        </view>

        <view class="gl-card">
          <text class="gl-kicker">03 · 快速加入</text>
          <text class="gl-card__title">加入房间</text>
          <input
            class="gl-input"
            type="text"
            ref="joinInput"
            placeholder="请输入 6 位房间号"
            @click="focusJoinInput"
            @input="onJoinRoomInput"
          />
          <button class="gl-btn" :disabled="connecting" @click="joinRoom">
            {{ connecting ? '加入中...' : '加入房间' }}
          </button>
        </view>
      </view>

      <view v-if="error" class="error">{{ error }}</view>
    </view>

    <!-- 已进入房间：棋盘 -->
    <view v-else class="game">
      <view v-if="room" class="room-bar">
        <view>
          <view class="label">房间号</view>
          <view class="room-id">{{ room.id }}</view>
        </view>
        <view class="badge" :class="{ host: isHost }">{{ isHost ? '房主' : '玩家' }}</view>
      </view>

        <view v-else class="room-bar ai-bar">
          <view>
            <view class="label">模式</view>
            <view class="room-id">人机对战</view>
          </view>
          <view class="badge host">你执{{ myColor === 'black' ? '黑' : '白' }} · 电脑执{{ myColor === 'black' ? '白' : '黑' }}</view>
        </view>


      <view class="player-row">
        <view class="player" :class="{ active: myColor === 'black' && !winner }">
          <view class="stone-mini black"></view>
          <text>黑棋</text>
          <text class="player-name">{{ myColor === 'black' ? '你' : (opponentName || '等待中') }}</text>
        </view>
        <view class="vs">VS</view>
        <view class="player" :class="{ active: myColor === 'white' && !winner }">
          <view class="stone-mini white"></view>
          <text>白棋</text>
          <text class="player-name">{{ myColor === 'white' ? '你' : (opponentName || '等待中') }}</text>
        </view>
      </view>

      <view class="status">{{ statusText }}</view>
      <view v-if="!winner && (!!room || isAiMode)" class="turn-timer" :class="{ urgent: timeLeft <= 10 }">⏱ {{ timeLeft }}s</view>

      <!-- 等对手时：扫码直接进这局棋（放在棋盘上方，进房第一眼就能看到） -->
      <share-qr
        v-if="room && !isAiMode && room.memberCount < 2"
        :room-id="room.id"
        page-path="/pages/gomoku/gomoku"
        title="扫码进这局棋"
        subtitle="对方扫码直接坐上来，不用输房间号"
      />

      <view class="board-wrap">
        <view class="board-aura">
          <view class="aura-dot d1"></view>
          <view class="aura-dot d2"></view>
          <view class="aura-dot d3"></view>
          <view class="aura-dot d4"></view>
          <view class="aura-dot d5"></view>
          <view class="aura-dot d6"></view>
        </view>

        <view
          class="board"
          :class="{ 'is-win': !!winner }"
          @touchstart="onBoardTouchStart"
          @touchend="onBoardTouchEnd"
          @touchcancel="clearPendingTap"
          @tap="onBoardTap"
        >
          <view class="board-grid">
            <view v-for="(row, r) in board" :key="r" class="row">
              <view
                v-for="(cell, c) in row"
                :key="c"
                class="cell"
                :class="{
                  'last-move': lastMove && lastMove.row === r && lastMove.col === c,
                  'win-cell': isWinCell(r, c)
                }"
              >
                <view v-if="cell" class="stone" :class="cell"></view>
                <view v-if="!cell && isStarPoint(r, c)" class="star-dot"></view>
              </view>
            </view>

            <view v-if="winBeamStyle" class="win-beam" :style="winBeamStyle"></view>
          </view>

          <view v-if="winner" class="win-flash"></view>
        </view>
      </view>

      <view class="actions">
        <button class="btn-secondary" :disabled="!canUndo" @click="undoMove">悔棋</button>
        <button class="btn-secondary" :disabled="!canRestart" @click="restart">重新开始</button>
        <button class="btn-secondary" @click="leaveRoom">{{ isAiMode ? '返回' : '离开房间' }}</button>
      </view>

    </view>
  </view>
</template>

<script>
import { getSocket } from '../../utils/socket.js'

const BOARD_SIZE = 15
const EMPTY_BOARD = () => Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null))

function cloneBoard(board) {
  return board.map(row => row.slice())
}

function checkLocalWin(board, row, col, color) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
  for (const [dr, dc] of dirs) {
    let count = 1
    const line = [[row, col]]
    for (let step = 1; step < 5; step++) {
      const r = row + dr * step
      const c = col + dc * step
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE || board[r][c] !== color) break
      count++
      line.push([r, c])
    }
    for (let step = 1; step < 5; step++) {
      const r = row - dr * step
      const c = col - dc * step
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE || board[r][c] !== color) break
      count++
      line.unshift([r, c])
    }
    if (count >= 5) return line
  }
  return null
}

function scorePoint(board, row, col, color) {
  let total = 0
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]]
  for (const [dr, dc] of dirs) {
    let count = 1
    let open = 0
    for (let step = 1; step < 5; step++) {
      const r = row + dr * step
      const c = col + dc * step
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) break
      if (board[r][c] === color) count++
      else if (!board[r][c]) { open++; break }
      else break
    }
    for (let step = 1; step < 5; step++) {
      const r = row - dr * step
      const c = col - dc * step
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) break
      if (board[r][c] === color) count++
      else if (!board[r][c]) { open++; break }
      else break
    }
    if (count >= 5) total += 100000
    else if (open === 2) total += count * count * 10
    else if (open === 1) total += count * count * 5
  }
  return total
}

// 附近 range 格内是否有棋子（用来把候选点收缩到已有战场周围）
function hasNeighborStone(board, row, col, range) {
  for (let dr = -range; dr <= range; dr++) {
    for (let dc = -range; dc <= range; dc++) {
      if (!dr && !dc) continue
      const r = row + dr
      const c = col + dc
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) continue
      if (board[r][c]) return true
    }
  }
  return false
}

function findBestAIMove(board, aiColor, humanColor) {
  // 空盘直接占天元，否则所有候选点得分都是 0，会随机落到角落
  let stoneCount = 0
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c]) stoneCount++
    }
  }
  if (!stoneCount) return { row: 7, col: 7 }

  let bestScore = -1
  let bestMoves = []
  for (let r = 0; r < BOARD_SIZE; r++) {
    for (let c = 0; c < BOARD_SIZE; c++) {
      if (board[r][c]) continue
      if (!hasNeighborStone(board, r, c, 2)) continue
      const attack = scorePoint(board, r, c, aiColor)
      const defend = scorePoint(board, r, c, humanColor)
      const score = Math.max(attack * 1.05, defend)
      if (score > bestScore) {
        bestScore = score
        bestMoves = [{ row: r, col: c }]
      } else if (score === bestScore) {
        bestMoves.push({ row: r, col: c })
      }
    }
  }
  if (!bestMoves.length) {
    // 兜底：理论上不会走到这里，避免返回 null 导致「电脑不落子」
    for (let r = 7; r >= 0; r--) {
      for (let c = 7; c >= 0; c--) {
        if (!board[r][c]) return { row: r, col: c }
      }
    }
    return null
  }
  return bestMoves[Math.floor(Math.random() * bestMoves.length)]
}


export default {
  data() {
    return {
      socket: null,
      room: null,
      board: EMPTY_BOARD(),
      currentTurn: 'black',
      myColor: '',
      isHost: false,
      winner: null,
      winLine: [],
      lastMove: null,
      joinRoomId: '',
      connecting: false,
      error: '',
        isAiMode: false,
        aiThinking: false,
        aiTimer: null,
        pendingTapPoint: null
,
        moveHistory: [],
        turnSeconds: 30,
        turnStartedAt: 0,
        timeLeft: 30,
        timerInterval: null
    }
  },

  onLoad(query) {
    // 扫码 / 带房号的链接进来：直接进房，不用再手动点一次「加入房间」
    const wantJoin = query && query.roomId ? String(query.roomId).toUpperCase().trim() : ''
    if (wantJoin) {
      this.joinRoomId = wantJoin
    }
    this.socket = getSocket()
    this.bindEvents()
    this.socket.connect()
    if (wantJoin) {
      this.$nextTick(() => this.joinRoom())
    }
  },

  onUnload() {
      this.clearAiTimer()
      this.clearCountdown()

    this.unbindEvents()
    if (this.socket && this.socket.connected && this.room) {
      this.socket.emit('gomoku-leave', { roomId: this.room.id })
    }
  },

  methods: {
    bindEvents() {
      this.socket.on('gomoku-room-state', this.handleRoomState)
      this.socket.on('gomoku-move', this.handleMove)
      this.socket.on('gomoku-restart', this.handleRestart)
      this.socket.on('gomoku-player-left', this.handlePlayerLeft)
      this.socket.on('gomoku-error', this.handleError)
      this.socket.on('connect', this.handleConnect)
      this.socket.on('disconnect', this.handleDisconnect)
    },

    unbindEvents() {
      this.socket.off('gomoku-room-state', this.handleRoomState)
      this.socket.off('gomoku-move', this.handleMove)
      this.socket.off('gomoku-restart', this.handleRestart)
      this.socket.off('gomoku-player-left', this.handlePlayerLeft)
      this.socket.off('gomoku-error', this.handleError)
      this.socket.off('connect', this.handleConnect)
      this.socket.off('disconnect', this.handleDisconnect)
    },

    handleConnect() {
      // 断线重连后 socket.id 会变，服务端已把旧连接移出房间，需要重新加入
      if (this.room && this.room.id) {
        this.socket.emit('gomoku-join-room', { roomId: this.room.id })
      }
    },

    handleDisconnect() {
      this.error = '连接已断开，正在自动重连...'
    },

    createRoom() {
      if (this.connecting) return
      this.error = ''
      this.connecting = true
      this.socket.off('gomoku-room-created', this.handleRoomCreated)
      this.socket.on('gomoku-room-created', this.handleRoomCreated)
      this.socket.off('gomoku-error', this.handleError)
      this.socket.on('gomoku-error', this.handleError)

      if (this.socket.connected) {
        this.emitCreateRoom()
      } else {
        this.socket.once('connect', this.emitCreateRoom)
      }
    },

    emitCreateRoom() {
      this.socket.emit('gomoku-create-room')
    },

    handleRoomCreated(data) {
      this.connecting = false
      this.applyRoomState(data)
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
      this.connecting = true
      this.socket.off('gomoku-room-created', this.handleRoomCreated)
      this.socket.off('gomoku-room-joined', this.handleRoomJoined)
      this.socket.on('gomoku-room-joined', this.handleRoomJoined)
      this.socket.off('gomoku-error', this.handleError)
      this.socket.on('gomoku-error', this.handleError)

      if (this.socket.connected) {
        this.emitJoinRoom(roomId)
      } else {
        this.socket.once('connect', () => this.emitJoinRoom(roomId))
      }
    },

    emitJoinRoom(roomId) {
      this.socket.emit('gomoku-join-room', { roomId })
    },

    handleRoomJoined(data) {
      this.connecting = false
      this.applyRoomState(data)
    },

    handleRoomState(data) {
      this.applyRoomState(data)
    },

    applyRoomState(data) {
      this.room = data.room
      this.myColor = data.color || ''
      this.isHost = !!data.isHost
      this.board = (data.room && data.room.board) ? data.room.board.map(row => row.slice()) : EMPTY_BOARD()
      this.currentTurn = (data.room && data.room.currentTurn) || 'black'
      this.winner = (data.room && data.room.winner) || null
      this.winLine = (data.room && data.room.winLine) || []
      this.lastMove = (data.room && data.room.lastMove) || null
      this.error = ''
      this.moveHistory = []
      this.syncCountdown(data.room)
    },


    handleMove(data) {
      const { row, col, color, board, currentTurn, winner, winLine, lastMove, turnSeconds, turnStartedAt } = data
      this.board = board ? board.map(r => r.slice()) : this.board
      if (typeof row === 'number' && typeof col === 'number' && color) {
        this.board[row][col] = color
      }
      this.currentTurn = currentTurn || this.currentTurn
      this.winner = winner || null
      this.winLine = winLine || []
      this.lastMove = lastMove || null
      this.error = ''
      this.moveHistory = []
      this.syncCountdown({ turnSeconds, turnStartedAt })
    },


    handleRestart(data) {
      this.board = (data && data.board) ? data.board.map(r => r.slice()) : EMPTY_BOARD()
      this.currentTurn = (data && data.currentTurn) || 'black'
      this.winner = null
      this.winLine = []
      this.lastMove = null
      this.error = ''
      this.moveHistory = []
      this.syncCountdown(data)
    },

    handlePlayerLeft(data) {
      if (!data || !data.message) return
      this.error = data.message
      // 对手离开后保留棋盘，方便重新开局或离开
    },

    handleError(err) {
      this.connecting = false
      this.error = (err && err.message) || '操作失败'
    },

    leaveRoom() {
      if (this.socket && this.room) {
        this.socket.emit('gomoku-leave', { roomId: this.room.id })
      }
      this.socket.off('gomoku-room-created', this.handleRoomCreated)
      this.socket.off('gomoku-room-joined', this.handleRoomJoined)
      this.room = null
      this.board = EMPTY_BOARD()
      this.currentTurn = 'black'
      this.myColor = ''
      this.isHost = false
      this.winner = null
      this.winLine = []
      this.lastMove = null
      uni.navigateBack()
    },

      startAiGame() {
        this.clearAiTimer()
        this.room = null
        this.isAiMode = true
        this.myColor = 'black'
        this.isHost = false
        this.resetLocalGame()
        this.error = ''
      },

      resetLocalGame() {
        this.board = EMPTY_BOARD()
        this.currentTurn = 'black'
        this.winner = null
        this.winLine = []
        this.lastMove = null
        this.aiThinking = false
        this.moveHistory = []
        this.clearCountdown()
        this.startCountdown(30)
      },

      clearAiTimer() {
        if (this.aiTimer) {
          clearTimeout(this.aiTimer)
          this.aiTimer = null
        }
      },

      clearCountdown() {
        if (this.timerInterval) {
          clearInterval(this.timerInterval)
          this.timerInterval = null
        }
      },

      syncCountdown(roomOrData) {
        this.clearCountdown()
        const room = roomOrData && roomOrData.room ? roomOrData.room : roomOrData
        const seconds = Number((room && room.turnSeconds) || 30)
        const startedAt = Number((room && room.turnStartedAt) || 0)
        this.turnSeconds = seconds
        this.turnStartedAt = startedAt
        if (!this.isAiMode && room && room.memberCount < 2) {
          this.timeLeft = seconds
          return
        }
        const update = () => {
          const elapsed = startedAt ? Math.max(0, (Date.now() - startedAt) / 1000) : 0
          this.timeLeft = Math.max(0, Math.ceil(seconds - elapsed))
          if (this.winner) {
            this.timeLeft = 0
            this.clearCountdown()
            return
          }
          if (this.timeLeft <= 0) {
            this.clearCountdown()
            this.handleTurnTimeout()
          }
        }
        update()
        if (this.winner || this.timeLeft <= 0) return
        this.timerInterval = setInterval(update, 200)
      },

      startCountdown(seconds, startedAt) {
        this.clearCountdown()
        this.turnSeconds = seconds || 30
        this.turnStartedAt = startedAt || Date.now()
        this.timeLeft = this.turnSeconds
        this.timerInterval = setInterval(() => {
          const elapsed = Math.max(0, (Date.now() - this.turnStartedAt) / 1000)
          this.timeLeft = Math.max(0, Math.ceil(this.turnSeconds - elapsed))
          if (this.winner) {
            this.timeLeft = 0
            this.clearCountdown()
            return
          }
          if (this.timeLeft <= 0) {
            this.clearCountdown()
            this.handleTurnTimeout()
          }
        }, 200)
      },

      handleTurnTimeout() {
        if (this.winner) return
        if (this.isAiMode) {
          const aiColor = this.myColor === 'black' ? 'white' : 'black'
          if (this.currentTurn === this.myColor) {
            // 玩家超时判负
            this.winner = aiColor
            this.winLine = []
            this.aiThinking = false
            this.clearAiTimer()
            return
          }
          // 轮到电脑却超时，说明思考链断了：立刻让它落子，避免卡死
          this.aiThinking = false
          this.kickoffAiMove(0)
          return
        }
        if (this.room && this.room.memberCount >= 2 && this.myColor === this.currentTurn) {
          this.socket.emit('gomoku-timeout', { roomId: this.room.id })
        }
      },

      applyLocalMove(row, col, color) {
        this.board[row][col] = color
        this.lastMove = { row, col }
        this.moveHistory.push({ row, col, color })
        const winLine = checkLocalWin(this.board, row, col, color)
        if (winLine) {
          this.winner = color
          this.winLine = winLine
        } else {
          this.currentTurn = color === 'black' ? 'white' : 'black'
          this.startCountdown(30)
        }
      },

      aiMove() {
        this.aiTimer = null
        if (this.winner) {
          this.aiThinking = false
          return
        }
        const aiColor = this.myColor === 'black' ? 'white' : 'black'
        // 防御：不是电脑的回合就别落子，避免和玩家抢手
        if (this.currentTurn !== aiColor) {
          this.aiThinking = false
          return
        }
        this.aiThinking = false
        const humanColor = this.myColor
        const move = findBestAIMove(this.board, aiColor, humanColor)
        if (!move) {
          this.aiThinking = false
          return
        }
        this.applyLocalMove(move.row, move.col, aiColor)
      },

      // 轮到电脑就先手落子（重新开始换色、超时兜底都要走这里）
      kickoffAiMove(delay = 420) {
        if (!this.isAiMode || this.winner) return
        const aiColor = this.myColor === 'black' ? 'white' : 'black'
        if (this.currentTurn !== aiColor) return
        this.clearAiTimer()
        this.aiThinking = true
        this.aiTimer = setTimeout(() => {
          this.aiMove()
        }, delay)
      },

      isStarPoint(r, c) {
        const stars = [[3, 3], [3, 11], [11, 3], [11, 11], [7, 7]]
        return stars.some(([sr, sc]) => sr === r && sc === c)
      },

      // 五连的五个点：服务端与本机都是 [[r, c], ...] 形式
      isWinCell(r, c) {
        const line = this.winLine || []
        return line.some((p) => {
          if (Array.isArray(p)) return p[0] === r && p[1] === c
          return p && p.row === r && p.col === c
        })
      },

      getTapPoint(e) {
        if (!e) return null
        const touch = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])
        if (touch && typeof touch.clientX === 'number' && typeof touch.clientY === 'number') {
          return { x: touch.clientX, y: touch.clientY }
        }
        if (typeof e.clientX === 'number' && typeof e.clientY === 'number') {
          return { x: e.clientX, y: e.clientY }
        }
        if (e.detail && typeof e.detail.x === 'number' && typeof e.detail.y === 'number') {
          return { x: e.detail.x, y: e.detail.y }
        }
        return null
      },

      onBoardTouchStart(e) {
        this.pendingTapPoint = null
      },

      onBoardTouchEnd(e) {
        const touch = e && e.changedTouches && e.changedTouches[0]
        if (touch && typeof touch.clientX === 'number' && typeof touch.clientY === 'number') {
          this.pendingTapPoint = { x: touch.clientX, y: touch.clientY }
        }
      },

      clearPendingTap() {
        this.pendingTapPoint = null
      },

      onBoardTap(e) {
        const point = this.pendingTapPoint || this.getTapPoint(e)
        this.pendingTapPoint = null
        if (point) this.placeAt(point)
      },

      placeAt(point) {
        if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') return
        uni.createSelectorQuery().in(this).select('.board').boundingClientRect((rect) => {
          if (!rect || !rect.width || !rect.height) return
          const padding = 8
          const stepX = (rect.width - padding * 2) / BOARD_SIZE
          const stepY = (rect.height - padding * 2) / BOARD_SIZE
          let col = Math.floor((point.x - rect.left - padding) / stepX + 0.45)
          let row = Math.floor((point.y - rect.top - padding) / stepY + 0.45)
          col = Math.min(BOARD_SIZE - 1, Math.max(0, col))
          row = Math.min(BOARD_SIZE - 1, Math.max(0, row))
          this.onCellClick(row, col)
        }).exec()
      },

      onCellClick(row, col) {
        if ((!this.room && !this.isAiMode) || this.winner || this.aiThinking) return
        if (this.board[row][col]) return
        if (this.myColor !== this.currentTurn) {
          this.error = '还没轮到你哦'
          return
        }
        this.error = ''
        if (this.isAiMode) {
          const aiColor = this.myColor === 'black' ? 'white' : 'black'
          this.applyLocalMove(row, col, this.myColor)
          if (!this.winner && this.currentTurn === aiColor) {
            this.kickoffAiMove(400)
          }
          return
        }
        this.socket.emit('gomoku-move', {
          roomId: this.room.id,
          row,
          col
        })
      },

      restart() {
        if (this.isAiMode) {
          this.clearAiTimer()
          this.aiThinking = false
          // 每局换先：这一局电脑执黑的话，重开后要由电脑先落子
          this.myColor = this.myColor === 'black' ? 'white' : 'black'
          this.resetLocalGame()
          this.kickoffAiMove(520)
          return
        }
        if (!this.room) return
        this.socket.emit('gomoku-restart', { roomId: this.room.id })
      },

      undoMove() {
        if (this.winner) {
          this.error = '本局已结束，不能悔棋'
          return
        }
        if (this.isAiMode) {
          this.undoLocalMove()
          return
        }
        if (!this.room || !this.lastMove) {
          this.error = '还没有可悔棋的棋子'
          return
        }
        this.error = ''
        this.socket.emit('gomoku-undo', { roomId: this.room.id })
      },

      undoLocalMove() {
        if (!this.moveHistory.length) {
          this.error = '还没有可悔棋的棋子'
          return
        }
        this.clearAiTimer()
        this.aiThinking = false
        const removed = this.moveHistory.pop()
        this.board[removed.row][removed.col] = null
        if (removed.color !== this.myColor && this.moveHistory.length && this.moveHistory[this.moveHistory.length - 1].color === this.myColor) {
          const prev = this.moveHistory.pop()
          this.board[prev.row][prev.col] = null
        }
        this.lastMove = this.moveHistory.length ? this.moveHistory[this.moveHistory.length - 1] : null
        this.currentTurn = this.myColor
        this.winner = null
        this.winLine = []
        this.error = ''
        this.startCountdown(30)
      },

      leaveRoom() {
        if (this.isAiMode) {
          this.clearAiTimer()
          this.isAiMode = false
          this.resetLocalGame()
          uni.navigateBack()
          return
        }
        if (this.socket && this.room) {
          this.socket.emit('gomoku-leave', { roomId: this.room.id })
        }
        this.socket.off('gomoku-room-created', this.handleRoomCreated)
        this.socket.off('gomoku-room-joined', this.handleRoomJoined)
        this.room = null
        this.board = EMPTY_BOARD()
        this.currentTurn = 'black'
        this.myColor = ''
        this.isHost = false
        this.winner = null
        this.winLine = []
        this.lastMove = null
        uni.navigateBack()

        /*
          const dt = e.detail
          const value = dt && dt.value !== undefined ? dt.value : ((e.target && e.target.value !== undefined) ? e.target.value : ((e.currentTarget && e.currentTarget.value !== undefined) ? e.currentTarget.value : (e.srcElement && e.srcElement.value)))
          if (value === undefined || value === null) return
          */

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
      }

  },

  computed: {
    opponentName() {
      // 后端暂时只传颜色，这里用“对方”表示
      if (this.isAiMode) return '电脑'
        return this.room && this.room.memberCount > 1 ? '对方' : ''
    },
    canRestart() {
      return (!!this.room || this.isAiMode) && !!this.winner
    },
    canUndo() {
      if (this.winner) return false
      if (this.isAiMode) return this.moveHistory.length > 0
      return !!this.room && !!this.lastMove
    },
    // 沿五连方向画一条发光带：把格子坐标换算成百分比
    winBeamStyle() {
      const line = this.winLine || []
      if (!line.length) return null
      const pts = line.map((p) => (Array.isArray(p) ? { row: p[0], col: p[1] } : p))
      const a = pts[0]
      const b = pts[pts.length - 1]
      if (!a || !b) return null
      const step = 100 / 15
      const x1 = (a.col + 0.5) * step
      const y1 = (a.row + 0.5) * step
      const x2 = (b.col + 0.5) * step
      const y2 = (b.row + 0.5) * step
      const len = Math.sqrt((x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1))
      const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI
      return {
        left: x1 + '%',
        top: y1 + '%',
        width: len + '%',
        marginTop: '-2px',
        transform: 'rotate(' + angle + 'deg)'
      }
    },
    statusText() {
      if (this.isAiMode) {
        if (this.winner) {
          return this.winner === this.myColor ? '🎉 你赢了！' : '🤖 电脑赢了'
        }
        if (this.aiThinking) return '电脑思考中...'
        return this.currentTurn === this.myColor ? '轮到你落子' : '电脑思考中...'
      }
      if (!this.room) return ''
      if (this.winner) {
        return this.winner === this.myColor ? '🎉 你赢了！' : '😢 对方赢了'
      }
      if (this.room.memberCount < 2) {
        return '等待对方加入...'
      }
      return this.currentTurn === this.myColor ? '轮到你落子' : '等待对方落子...'
    }

  }
}
</script>

<style scoped>
.gomoku-page {
  min-height: 100vh;
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
}

.section-title {
  font-size: 16px;
  font-weight: 700;
  color: #14342a;
  margin-bottom: 12px;
}

.tip {
  margin-top: 8px;
  font-size: 12px;
  color: #8aa89b;
}

.divider {
  text-align: center;
  color: #8aa89b;
  font-size: 13px;
  margin: 6px 0 14px;
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

/* ================= 对局界面：清新棋院风 ================= */

/* ---------- 顶部房间信息 ---------- */
.room-bar {
  position: relative;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 13px 16px;
  margin-bottom: 10px;
  border-radius: 16px;
  background: #ffffff;
  border: 1px solid rgba(16, 122, 86, 0.1);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.9),
    0 16px 34px -26px rgba(13, 84, 60, 0.6);
}

.ai-bar {
  background:
    radial-gradient(120% 160% at 0% 0%, rgba(167, 243, 208, 0.5) 0%, rgba(167, 243, 208, 0) 62%),
    #ffffff;
}

.label {
  display: block;
  font-size: 11px;
  letter-spacing: 0.12em;
  color: #8aa89b;
}

.room-id {
  display: block;
  font-size: 22px;
  font-weight: 800;
  color: #0f7a4f;
  letter-spacing: 3px;
}

.badge {
  padding: 5px 14px;
  border-radius: 999px;
  font-size: 12px;
  color: #37584a;
  background: #f1faf5;
  border: 1px solid rgba(16, 122, 86, 0.16);
}

.badge.host {
  color: #ffffff;
  font-weight: 600;
  background: linear-gradient(135deg, #34d399 0%, #0f9d63 100%);
  border-color: transparent;
  box-shadow: 0 8px 18px -12px rgba(15, 157, 99, 0.9);
}

/* ---------- 双方信息条 ---------- */
.player-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 9px 12px;
  margin-bottom: 10px;
  border-radius: 16px;
  background: #ffffff;
  border: 1px solid rgba(16, 122, 86, 0.1);
  box-shadow: 0 14px 30px -26px rgba(13, 84, 60, 0.6);
}

.player {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 11px;
  border-radius: 999px;
  font-size: 13px;
  color: #37584a;
  border: 1px solid transparent;
  transition: background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

/* active = 这一边是你 */
.player.active {
  color: #0b7a4c;
  font-weight: 600;
  background: #e8f7ef;
  border-color: rgba(16, 157, 99, 0.4);
}

.stone-mini {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  flex-shrink: 0;
}

.stone-mini.black {
  background: radial-gradient(circle at 32% 28%, #7b8a82 0%, #2b3a33 46%, #060b08 88%);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.24);
}

.stone-mini.white {
  background: radial-gradient(circle at 32% 28%, #ffffff 0%, #f1f8f4 52%, #c9dcd1 100%);
  box-shadow: 0 0 0 1px rgba(16, 122, 86, 0.18), inset 0 -1px 2px rgba(90, 120, 105, 0.35);
}

.player-name {
  color: #8aa89b;
  font-size: 11.5px;
}

.vs {
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: #b6cbbf;
}

.status {
  text-align: center;
  font-size: 15px;
  font-weight: 700;
  color: #14342a;
  margin-bottom: 8px;
}

.turn-timer {
  text-align: center;
  font-size: 13.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: #0b7a4c;
  margin-bottom: 12px;
}

.turn-timer.urgent {
  color: #c0392b;
  animation: timer-alert 1s ease-in-out infinite;
}

@keyframes timer-alert {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

/* ---------- 棋盘 ---------- */
.board-wrap {
  position: relative;
  display: flex;
  justify-content: center;
  margin-bottom: 16px;
}

/* 棋盘外缓慢上浮的微光点（纯 transform，代价很低） */
.board-aura {
  position: absolute;
  top: -28px;
  right: 0;
  bottom: -28px;
  left: 0;
  overflow: hidden;
  pointer-events: none;
}

.aura-dot {
  position: absolute;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #a7f3d0;
  box-shadow: 0 0 8px rgba(52, 211, 153, 0.7);
  opacity: 0;
  animation: aura-float 9s ease-in-out infinite;
}

.aura-dot.d1 {
  left: 9%;
  bottom: 4%;
  animation-delay: 0s;
}

.aura-dot.d2 {
  left: 22%;
  bottom: 16%;
  width: 3px;
  height: 3px;
  background: #bbf7d0;
  box-shadow: 0 0 8px rgba(167, 243, 208, 0.8);
  animation-delay: 1.7s;
}

.aura-dot.d3 {
  left: 47%;
  bottom: 2%;
  animation-delay: 3.2s;
}

.aura-dot.d4 {
  right: 21%;
  bottom: 11%;
  width: 3px;
  height: 3px;
  background: #f0abfc;
  box-shadow: 0 0 8px rgba(209, 250, 229, 0.9);
  animation-delay: 4.6s;
}

.aura-dot.d5 {
  right: 8%;
  bottom: 24%;
  animation-delay: 2.4s;
}

.aura-dot.d6 {
  left: 34%;
  bottom: 28%;
  width: 2.5px;
  height: 2.5px;
  animation-delay: 5.8s;
}

@keyframes aura-float {
  0% {
    transform: translate3d(0, 0, 0) scale(0.85);
    opacity: 0;
  }
  16% {
    opacity: 0.55;
  }
  70% {
    opacity: 0.32;
  }
  100% {
    transform: translate3d(12px, -130px, 0) scale(1.3);
    opacity: 0;
  }
}

.board {
  position: relative;
  width: 100%;
  max-width: 360px;
  box-sizing: border-box;
  padding: 10px;
  border-radius: 18px;
  /* 浅绿棋院桌面：白到薄荷的柔和过渡，衬得黑白子都清楚 */
  background:
    radial-gradient(130% 110% at 50% 0%, #f8fefa 0%, #dff1e7 58%, #cde6d9 100%);
  border: 1px solid rgba(16, 122, 86, 0.16);
  box-shadow:
    0 2px 6px -4px rgba(13, 84, 60, 0.25),
    0 26px 54px -30px rgba(13, 84, 60, 0.65),
    inset 0 1px 0 rgba(255, 255, 255, 0.95);
  touch-action: manipulation;
  -webkit-user-select: none;
  user-select: none;
  cursor: pointer;
  transition: box-shadow 0.45s ease;
}

/* 缓慢掠过棋盘的一道光，像玻璃反光 */
.board::before {
  content: '';
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  border-radius: inherit;
  pointer-events: none;
  background: linear-gradient(115deg, rgba(255, 255, 255, 0) 32%, rgba(255, 255, 255, 0.75) 46%, rgba(255, 255, 255, 0) 60%);
  background-size: 240% 240%;
  /* 手机端不跑这道光：动 background-position 会让整块棋盘每帧重绘 */
  background-position: 55% 0;
}

@media (min-width: 900px) {
  .board::before {
    animation: board-sheen 11s ease-in-out infinite;
  }
}

@keyframes board-sheen {
  0%,
  100% {
    background-position: 130% 0;
  }
  50% {
    background-position: -30% 0;
  }
}

/* 四角角标：淡淡的绿色细线 */
.board::after {
  content: '';
  position: absolute;
  top: 5px;
  right: 5px;
  bottom: 5px;
  left: 5px;
  border-radius: 14px;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(16, 157, 99, 0.45), rgba(16, 157, 99, 0.45)),
    linear-gradient(rgba(16, 157, 99, 0.45), rgba(16, 157, 99, 0.45)),
    linear-gradient(rgba(16, 157, 99, 0.45), rgba(16, 157, 99, 0.45)),
    linear-gradient(rgba(16, 157, 99, 0.45), rgba(16, 157, 99, 0.45)),
    linear-gradient(rgba(16, 157, 99, 0.45), rgba(16, 157, 99, 0.45)),
    linear-gradient(rgba(16, 157, 99, 0.45), rgba(16, 157, 99, 0.45)),
    linear-gradient(rgba(16, 157, 99, 0.45), rgba(16, 157, 99, 0.45)),
    linear-gradient(rgba(16, 157, 99, 0.45), rgba(16, 157, 99, 0.45));
  background-repeat: no-repeat;
  background-size: 15px 1.5px, 1.5px 15px, 15px 1.5px, 1.5px 15px, 15px 1.5px, 1.5px 15px, 15px 1.5px, 1.5px 15px;
  background-position:
    left top, left top,
    right top, right top,
    left bottom, left bottom,
    right bottom, right bottom;
}

/* 五连达成：整块棋盘亮起来 */
.board.is-win {
  border-color: rgba(16, 157, 99, 0.5);
  box-shadow:
    0 0 0 2px rgba(52, 211, 153, 0.24),
    0 0 60px -10px rgba(16, 157, 99, 0.55),
    inset 0 1px 0 rgba(255, 255, 255, 0.95);
}

.board-grid {
  position: relative;
}

.row {
  display: flex;
}

.cell {
  position: relative;
  width: 6.66666667%;
  height: 0;
  padding-bottom: calc(6.66666667% - 1px);
  box-sizing: border-box;
  border-left: 1px solid rgba(16, 122, 86, 0.16);
  border-top: 1px solid rgba(16, 122, 86, 0.16);
}

.row:last-child .cell {
  border-bottom: 1px solid rgba(16, 122, 86, 0.32);
  padding-bottom: calc(6.66666667% - 2px);
}

.cell:last-child {
  border-right: 1px solid rgba(16, 122, 86, 0.32);
}

/* 最后一手：绿色脉冲环 */
.cell.last-move::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 88%;
  height: 88%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  border: 1.5px solid rgba(15, 157, 99, 0.9);
  box-shadow: 0 0 10px rgba(16, 157, 99, 0.55);
  pointer-events: none;
  z-index: 2;
  animation: last-move-pulse 1.8s ease-in-out infinite;
}

@keyframes last-move-pulse {
  0%,
  100% {
    opacity: 0.95;
    transform: translate(-50%, -50%) scale(0.9);
  }
  50% {
    opacity: 0.35;
    transform: translate(-50%, -50%) scale(1.14);
  }
}

.star-dot {
  position: absolute;
  top: 0;
  left: 0;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(16, 122, 86, 0.5);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.stone {
  position: absolute;
  top: 0;
  left: 0;
  width: 80%;
  height: 80%;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  z-index: 1;
  box-sizing: border-box;
}

.stone.black {
  background: radial-gradient(circle at 32% 26%, #6d7d76 0%, #2c3a34 34%, #0d1512 72%, #050a08 100%);
  box-shadow:
    0 2px 5px rgba(10, 40, 28, 0.45),
    inset 0 1.5px 3px rgba(255, 255, 255, 0.2),
    inset 0 -2px 5px rgba(0, 0, 0, 0.55);
}

.stone.white {
  background: radial-gradient(circle at 34% 26%, #ffffff 0%, #f7fdf9 36%, #b7d2c4 100%);
  box-shadow:
    0 0 0 1.5px rgba(13, 84, 60, 0.5),
    0 3px 7px rgba(10, 40, 28, 0.34),
    inset 0 2px 3px rgba(255, 255, 255, 0.95),
    inset 0 -3px 6px rgba(88, 128, 108, 0.55);
}

/* 新落的子：弹一下 */
.cell.last-move .stone {
  animation: stone-drop 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

@keyframes stone-drop {
  0% {
    transform: translate(-50%, -50%) scale(0.15);
    opacity: 0;
  }
  65% {
    transform: translate(-50%, -50%) scale(1.14);
    opacity: 1;
  }
  100% {
    transform: translate(-50%, -50%) scale(1);
  }
}

/* 五连的五个子：持续发亮 */
.cell.win-cell .stone {
  animation: win-glow 1.15s ease-in-out infinite alternate;
}

@keyframes win-glow {
  from {
    box-shadow:
      0 0 0 1.5px rgba(15, 157, 99, 0.7),
      0 0 12px rgba(16, 157, 99, 0.5),
      0 2px 5px rgba(10, 40, 28, 0.35);
  }
  to {
    box-shadow:
      0 0 0 2.5px rgba(15, 157, 99, 0.9),
      0 0 26px rgba(16, 157, 99, 0.75),
      0 2px 7px rgba(10, 40, 28, 0.4);
  }
}

/* 贯穿五连的光带 */
.win-beam {
  position: absolute;
  height: 4px;
  border-radius: 999px;
  transform-origin: left center;
  background: linear-gradient(
    90deg,
    rgba(52, 211, 153, 0) 0%,
    rgba(52, 211, 153, 0.95) 16%,
    rgba(16, 157, 99, 1) 50%,
    rgba(52, 211, 153, 0.95) 84%,
    rgba(52, 211, 153, 0) 100%
  );
  box-shadow: 0 0 16px rgba(16, 157, 99, 0.6);
  pointer-events: none;
  z-index: 5;
  animation: beam-in 0.5s ease-out both;
}

@keyframes beam-in {
  from {
    opacity: 0;
    filter: brightness(1.8);
  }
  to {
    opacity: 1;
    filter: brightness(1);
  }
}

/* 胜利瞬间的柔光闪 */
.win-flash {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  border-radius: inherit;
  pointer-events: none;
  z-index: 6;
  background: radial-gradient(closest-side, rgba(167, 243, 208, 0.55), rgba(167, 243, 208, 0) 72%);
  animation: win-flash 1.1s ease-out both;
}

@keyframes win-flash {
  0% {
    opacity: 0;
  }
  16% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}

/* ---------- 底部按钮 ---------- */
.actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  margin-top: 4px;
  flex-wrap: wrap;
}

.btn-secondary {
  padding: 9px 20px;
  border-radius: 999px;
  font-size: 13.5px;
  font-weight: 600;
  color: #0b7a4c;
  background: #ffffff;
  border: 1px solid rgba(16, 157, 99, 0.26);
  box-shadow: 0 8px 18px -14px rgba(13, 84, 60, 0.55);
  cursor: pointer;
  transition: background 0.18s ease, transform 0.18s ease, border-color 0.18s ease;
}

.btn-secondary:active {
  transform: scale(0.97);
  background: #eef8f2;
  border-color: rgba(16, 157, 99, 0.45);
}

.btn-secondary[disabled] {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 尊重「减少动态效果」系统设置 */
@media (prefers-reduced-motion: reduce) {
  .board::before,
  .aura-dot,
  .cell.last-move::after,
  .cell.last-move .stone,
  .cell.win-cell .stone,
  .win-beam,
  .win-flash,
  .turn-timer.urgent {
    animation: none;
  }
}

/* 横屏适配 */
@media (orientation: landscape) {
  .gomoku-page {
    padding: 10px 20px;
  }

  .hero {
    padding: 8px 0 10px;
  }

  .board {
    max-width: 320px;
  }
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

/* ===== 深海覆盖：对局界面 ===== */
.player-row {
  background: rgba(11, 23, 48, 0.78);
  border-color: var(--c-line);
  box-shadow: 0 20px 44px -34px rgba(0, 0, 0, 0.9);
}
.player { color: var(--c-text-2); }
.player.active {
  color: var(--c-text);
  background: rgba(77, 107, 254, 0.18);
  border-color: rgba(110, 231, 255, 0.4);
}
.player-name { color: var(--c-text-3); }
.vs { color: rgba(184, 198, 255, 0.45); }
.stone-mini.black {
  background: radial-gradient(circle at 32% 28%, #7488b8 0%, #2a3550 46%, #060a14 88%);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.2);
}
.stone-mini.white {
  background: radial-gradient(circle at 32% 28%, #ffffff 0%, #e6ecff 52%, #9fb0d8 100%);
  box-shadow: 0 0 0 1px rgba(184, 198, 255, 0.3), inset 0 -1px 2px rgba(60, 80, 130, 0.35);
}

.status { color: var(--c-text); }
.turn-timer { color: var(--c-primary-soft); }
.turn-timer.urgent { color: #ff8fa3; }

.board {
  background:
    radial-gradient(130% 110% at 50% 0%, #162b56 0%, #0b1730 58%, #070f20 100%);
  border-color: rgba(110, 231, 255, 0.22);
  box-shadow:
    0 2px 6px -4px rgba(0, 0, 0, 0.6),
    0 26px 54px -30px rgba(0, 0, 0, 0.9),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
.board::before {
  background: linear-gradient(115deg, rgba(110, 231, 255, 0) 32%, rgba(110, 231, 255, 0.16) 46%, rgba(110, 231, 255, 0) 60%);
}
.board::after { display: none; }
.board.is-win {
  border-color: rgba(110, 231, 255, 0.5);
  box-shadow:
    0 0 0 2px rgba(110, 231, 255, 0.18),
    0 0 60px -10px rgba(77, 107, 254, 0.55),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.cell {
  border-left-color: rgba(184, 198, 255, 0.18);
  border-top-color: rgba(184, 198, 255, 0.18);
}
.row:last-child .cell { border-bottom-color: rgba(184, 198, 255, 0.32); }
.cell:last-child { border-right-color: rgba(184, 198, 255, 0.32); }
.cell.last-move::after {
  border-color: rgba(110, 231, 255, 0.9);
  box-shadow: 0 0 10px rgba(110, 231, 255, 0.55);
}
.star-dot { background: rgba(184, 198, 255, 0.5); }

.stone.black {
  background: radial-gradient(circle at 32% 26%, #7d8dbd 0%, #2b3654 34%, #0a1020 72%, #04070f 100%);
  box-shadow:
    0 2px 5px rgba(0, 0, 0, 0.55),
    inset 0 1.5px 3px rgba(255, 255, 255, 0.2),
    inset 0 -2px 5px rgba(0, 0, 0, 0.6);
}
.stone.white {
  background: radial-gradient(circle at 34% 26%, #ffffff 0%, #eef3ff 36%, #b9c8ea 100%);
  box-shadow:
    0 0 0 1.5px rgba(184, 198, 255, 0.45),
    0 3px 7px rgba(0, 0, 0, 0.4),
    inset 0 2px 3px rgba(255, 255, 255, 0.95),
    inset 0 -3px 6px rgba(120, 140, 190, 0.55);
}

.aura-dot {
  background: #6ee7ff;
  box-shadow: 0 0 8px rgba(110, 231, 255, 0.7);
}

.btn-secondary {
  background: rgba(11, 23, 48, 0.72);
  color: var(--c-text);
  border-color: rgba(184, 198, 255, 0.2);
  box-shadow: 0 10px 22px -18px rgba(0, 0, 0, 0.9);
}
.btn-secondary:active {
  background: rgba(16, 32, 64, 0.9);
  border-color: rgba(110, 231, 255, 0.4);
}

/* 顶部房间 / 模式卡 */
.room-bar {
  background: rgba(11, 23, 48, 0.78);
  border-color: var(--c-line);
  color: var(--c-text);
  box-shadow: 0 20px 44px -34px rgba(0, 0, 0, 0.9);
}
.room-bar .label { color: var(--c-text-3); }
.room-bar .room-id { color: var(--c-text); }
.badge.host {
  background: linear-gradient(135deg, #6d8bff 0%, #4d6bfe 100%);
  color: #ffffff;
  border-color: transparent;
}
.btn-secondary[disabled] {
  background: rgba(184, 198, 255, 0.05);
  color: var(--c-text-3);
  opacity: 0.6;
}
</style>
