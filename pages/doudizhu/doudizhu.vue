<template>
  <view class="container ddz-page">
    <aurora-bg />
    <ann-banner />
    <!-- 大厅 -->
    <view v-if="phase === 'lobby'" class="lobby gl-lobby">
      <view class="gl-orbs">
        <view class="gl-orb orb-a"></view>
        <view class="gl-orb orb-b"></view>
        <view class="gl-orb orb-c"></view>
      </view>

      <view class="hero">
        <text class="title">星梦斗地主</text>
        <text class="subtitle">星河牌局 · AI 陪玩 / 在线联机</text>
      </view>

      <view class="gl-col">
        <view class="gl-card">
          <text class="gl-kicker">01 · 单机陪玩</text>
          <text class="gl-card__title">人机斗地主</text>
          <button class="gl-btn" @click="startGame">开始游戏</button>
          <text class="gl-note">本机即可玩，你和两位 AI 随机成为地主 / 农民</text>
        </view>

        <view class="gl-card">
          <text class="gl-kicker">02 · 联机对战</text>
          <text class="gl-card__title">创建斗地主房间</text>
          <button class="gl-btn" :disabled="connecting" @click="createOnlineRoom">
            {{ connecting ? '创建中...' : '创建房间' }}
          </button>
          <text class="gl-note">创建后出二维码：两个好友扫码直接进桌，异地也能扫；也能发房间号</text>
        </view>

        <view class="gl-card">
          <text class="gl-kicker">03 · 快速加入</text>
          <text class="gl-card__title">加入房间</text>
          <input
            class="gl-input"
            type="text"
            v-model="joinRoomId"
            placeholder="请输入 6 位房间号"
          />
          <button class="gl-btn" :disabled="connecting" @click="joinOnlineRoom">
            {{ connecting ? '加入中...' : '加入房间' }}
          </button>
        </view>
      </view>

      <view class="gl-foot">支持：单张 · 对子 · 三张 · 三带一 · 三带一对 · 顺子 · 连对 · 飞机 · 炸弹 · 王炸 · 四带二</view>
    </view>

    <!-- 游戏界面 -->
    <view v-else class="game">
      <view class="top-bar">
        <button class="btn-back" @click="backToLobby">返回</button>
        <text class="game-title">斗地主</text>
        <view class="spacer"></view>
      </view>

        <!-- 等待加入 -->
        <view v-if="mode === 'online' && room && phase === 'waiting'" class="waiting-panel">
          <view class="waiting-title">等待玩家加入</view>
          <view class="waiting-room">房间号：{{ room.id }}</view>
          <view class="waiting-status">{{ statusText || '把房间号发给两个好友，或让他们扫下面的码，三人满后自动开局' }}</view>
          <view class="seat-list">
            <view v-for="(p, i) in room.players" :key="i" class="seat-item" :class="{ filled: !!p }">
              <text>{{ p ? p.name : '等待加入' }}</text>
              <text v-if="p" class="seat-role">{{ p.isHost ? '房主' : '' }}</text>
            </view>
          </view>

          <!-- 等人时：扫码直接进这张牌桌 -->
          <share-qr
            :room-id="room.id"
            page-path="/pages/doudizhu/doudizhu"
            title="扫码加入牌局"
            subtitle="好友扫码直接进房，三人满自动开局"
          />

          <button class="btn-secondary" @click="backToLobby">返回大厅</button>
        </view>

        <template v-else>


      <!-- 两名 AI -->
      <view class="opponents">
        <view v-for="idx in [1, 2]" :key="idx" class="opponent">
          <view class="opponent-head">
            <text class="opponent-name">{{ players[idx].name }}</text>
            <text class="role-badge" :class="{ landlord: players[idx].isLandlord }">{{ players[idx].isLandlord ? '地主' : '农民' }}</text>
          </view>
          <view class="opponent-info">
            <text class="card-count">剩余 {{ players[idx].cardCount }} 张</text>
            <text class="thinking" v-if="phase === 'playing' && currentPlayer === idx">思考中...</text>
          </view>
        </view>
      </view>

      <!-- 桌面 -->
      <view class="table">
        <view class="bottom-row">
          <text class="bottom-label">底牌</text>
          <view class="mini-cards">
            <view v-for="card in bottomCards" :key="card.id" class="mini-card" :class="{ red: isRedCard(card) }">
              <template v-if="card.rank >= 16">
                <view class="mini-joker">
                  <text v-for="ch in 'JOKER'" :key="ch" class="mini-joker-letter">{{ ch }}</text>
                </view>
              </template>
              <template v-else>
                <text class="mini-rank">{{ rankText(card.rank) }}</text>
                <text class="mini-suit">{{ card.suit }}</text>
              </template>
            </view>
            <text v-if="!bottomCards.length" class="muted">--</text>
          </view>
        </view>

        <view class="last-play-area">
          <text class="last-label">{{ lastPlay ? `${players[lastPlay.player].name} 出牌` : '新一轮' }}</text>
          <view v-if="lastPlay" class="played-cards">
            <view v-for="card in lastPlay.cards" :key="card.id" class="played-card" :class="{ red: isRedCard(card) }">
              <template v-if="card.rank >= 16">
                <view class="mini-joker">
                  <text v-for="ch in 'JOKER'" :key="ch" class="mini-joker-letter">{{ ch }}</text>
                </view>
              </template>
              <template v-else>
                <text class="mini-rank">{{ rankText(card.rank) }}</text>
                <text class="mini-suit">{{ card.suit }}</text>
              </template>
            </view>
          </view>
          <view v-else class="muted">{{ phase === 'bidding' ? '正在叫地主...' : (currentPlayer === mySeat ? '轮到你出牌' : '等待出牌') }}</view>
        </view>

        <view class="status">{{ statusText }}</view>
      </view>

      <!-- 我的手牌 -->
      <view class="hand-wrap">
        <view class="hand">
          <view
            v-for="card in humanHand"
            :key="card.id"
            class="hand-card"
            :class="{ selected: isSelected(card.id), red: isRedCard(card) }"
            @click="toggleCard(card)"
          >
            <template v-if="card.rank >= 16">
              <view class="joker-vertical">
                <text v-for="ch in 'JOKER'" :key="ch" class="joker-letter">{{ ch }}</text>
              </view>
              <text class="joker-sub">{{ card.rank === 17 ? '大' : '小' }}</text>
            </template>
            <template v-else>
              <view class="card-corner">
                <text class="card-rank">{{ rankText(card.rank) }}</text>
                <text class="card-suit">{{ card.suit }}</text>
              </view>
              <text class="card-suit-big">{{ card.suit }}</text>
            </template>
          </view>
        </view>
      </view>

      <!-- 操作按钮（叫地主阶段这一排全是禁用态，收起来，把位置让给叫地主按钮） -->
      <view v-if="!(phase === 'bidding' && currentPlayer === mySeat)" class="actions">
        <button class="btn-action" :disabled="!canPass" @click="pass">不出</button>
        <button class="btn-action primary" :disabled="phase !== 'playing' || currentPlayer !== mySeat" @click="playCards">出牌</button>
        <button class="btn-action" :disabled="phase !== 'playing' || currentPlayer !== mySeat" @click="hint">提示</button>
        <button class="btn-action" @click="restartOrLeave">{{ mode === 'online' ? '退出房间' : '重新发牌' }}</button>
      </view>

      <!-- 叫地主操作 -->
      <view v-if="phase === 'bidding' && currentPlayer === mySeat" class="bid-actions">
        <button v-if="!bidding.hasBid" class="btn-action primary" @click="handleBid('call')">叫地主</button>
        <button v-else class="btn-action primary" @click="handleBid('grab')">抢地主</button>
        <button class="btn-action" @click="handleBid('pass')">{{ bidding.hasBid ? '不抢' : '不叫' }}</button>
      </view>

      <!-- 结算 -->
      <view v-if="phase === 'ended'" class="overlay">
        <view class="result-card">
          <text class="result-title">本局结束</text>
          <text class="result-text">{{ statusText }}</text>
          <button v-if="mode !== 'online'" class="btn-primary" @click="startGame">再来一局</button>
          <button v-else-if="isRoomHost" class="btn-primary" @click="restartOnline">重新开局</button>
          <button v-else class="btn-secondary" disabled>等待房主重新开局</button>
          <button class="btn-secondary" @click="backToLobby">返回大厅</button>
        </view>
      </view>
        </template>

    </view>
  </view>
</template>

<script>
import { getSocket } from '../../utils/socket.js'

const RANK_TEXT = {
  3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王'
}

let cardUid = 0

function createDeck() {
  const deck = []
  const suits = ['♠', '♥', '♣', '♦']
  for (const suit of suits) {
    for (let rank = 3; rank <= 15; rank++) {
      deck.push({ id: ++cardUid, rank, suit })
    }
  }
  deck.push({ id: ++cardUid, rank: 16, suit: 'joker' })
  deck.push({ id: ++cardUid, rank: 17, suit: 'joker' })
  return deck
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}

function sortHand(hand) {
  hand.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank
    return String(a.suit || '').localeCompare(String(b.suit || ''))
  })
  return hand
}

function rankText(rank) {
  return RANK_TEXT[rank] || String(rank)
}

function cardText(card) {
  if (card.rank >= 16) return RANK_TEXT[card.rank]
  return RANK_TEXT[card.rank] + card.suit
}

function isRedCard(card) {
  return card.rank === 17 || card.suit === '♥' || card.suit === '♦'
}

function groupByRank(hand) {
  const map = new Map()
  for (const card of hand) {
    if (!map.has(card.rank)) map.set(card.rank, [])
    map.get(card.rank).push(card)
  }
  return map
}

function parseCards(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return null
  const counts = new Map()
  for (const card of cards) {
    counts.set(card.rank, (counts.get(card.rank) || 0) + 1)
  }
  const entries = [...counts.entries()].sort((a, b) => a[0] - b[0])
  const n = cards.length
  const max = entries[entries.length - 1][0]
  const min = entries[0][0]
  const isConsecutive = entries.every((e, i) => i === 0 || e[0] === entries[i - 1][0] + 1)
  const allCount = (c) => entries.every(e => e[1] === c)
  const trios = entries.filter(e => e[1] === 3)
  const pairs = entries.filter(e => e[1] === 2)
  const singles = entries.filter(e => e[1] === 1)

  if (n === 2 && counts.has(16) && counts.has(17)) return { type: 'rocket', rank: 17, length: 2 }
  if (n === 4 && entries.length === 1) return { type: 'bomb', rank: max, length: 4 }
  if (n === 1) return { type: 'single', rank: max, length: 1 }
  if (n === 2 && entries.length === 1) return { type: 'pair', rank: max, length: 2 }
  if (n === 3 && entries.length === 1) return { type: 'trio', rank: max, length: 3 }
  if (n === 4 && trios.length === 1 && entries.length === 2) return { type: 'trio_single', rank: trios[0][0], length: 4 }
  if (n === 5 && trios.length === 1 && pairs.length === 1 && entries.length === 2) return { type: 'trio_pair', rank: trios[0][0], length: 5 }
  if (n >= 5 && entries.every(e => e[1] === 1) && isConsecutive && max < 15) return { type: 'straight', rank: max, length: n }
  if (n >= 6 && n % 2 === 0 && allCount(2) && isConsecutive && max < 15) return { type: 'double_straight', rank: max, length: n }
  if (n >= 6 && n % 3 === 0 && allCount(3) && isConsecutive && max < 15) return { type: 'airplane', rank: max, length: n }

  if (n >= 8 && n % 4 === 0) {
    const k = n / 4
    if (trios.length === k && singles.length === k) {
      const trioRanks = trios.map(e => e[0]).sort((a, b) => a - b)
      if (trioRanks[trioRanks.length - 1] < 15 && trioRanks[trioRanks.length - 1] - trioRanks[0] === k - 1) {
        return { type: 'airplane_single', rank: trioRanks[trioRanks.length - 1], length: n }
      }
    }
  }

  if (n >= 10 && n % 5 === 0) {
    const k = n / 5
    if (trios.length === k && pairs.length === k) {
      const trioRanks = trios.map(e => e[0]).sort((a, b) => a - b)
      if (trioRanks[trioRanks.length - 1] < 15 && trioRanks[trioRanks.length - 1] - trioRanks[0] === k - 1) {
        return { type: 'airplane_pair', rank: trioRanks[trioRanks.length - 1], length: n }
      }
    }
  }

  if (n === 6) {
    const bomb = entries.find(e => e[1] === 4)
    if (bomb && entries.length === 3 && singles.length === 2) {
      return { type: 'four_two_single', rank: bomb[0], length: 6 }
    }
  }

  if (n === 8) {
    const bomb = entries.find(e => e[1] === 4)
    if (bomb && entries.length === 3 && pairs.length === 2) {
      return { type: 'four_two_pair', rank: bomb[0], length: 8 }
    }
  }

  return null
}

function canBeat(play, lastPlay) {
  if (!lastPlay) return true
  if (play.type === 'rocket') return true
  if (lastPlay.type === 'rocket') return false
  if (play.type === 'bomb' && lastPlay.type !== 'bomb') return true
  if (play.type === lastPlay.type && play.length === lastPlay.length && play.rank > lastPlay.rank) return true
  return false
}

function collectPlays(hand) {
  const group = groupByRank(hand)
  const plays = []
  const ranks = [...group.keys()].sort((a, b) => a - b)

  // 单张
  for (const [rank, cards] of group) {
    plays.push([cards[0]])
  }

  // 对子
  for (const [rank, cards] of group) {
    if (cards.length >= 2) plays.push(cards.slice(0, 2))
  }

  // 三张
  for (const [rank, cards] of group) {
    if (cards.length >= 3) plays.push(cards.slice(0, 3))
  }

  // 炸弹
  for (const [rank, cards] of group) {
    if (cards.length === 4) plays.push(cards.slice(0, 4))
  }

  // 王炸
  if (group.has(16) && group.has(17)) {
    plays.push([group.get(16)[0], group.get(17)[0]])
  }

  // 三带一
  for (const [trioRank, trioCards] of group) {
    if (trioCards.length < 3) continue
    const trio = trioCards.slice(0, 3)
    for (const [rank, cards] of group) {
      if (rank === trioRank || cards.length < 1) continue
      plays.push([...trio, cards[0]])
    }
  }

  // 三带一对
  for (const [trioRank, trioCards] of group) {
    if (trioCards.length < 3) continue
    const trio = trioCards.slice(0, 3)
    for (const [rank, cards] of group) {
      if (rank === trioRank || cards.length < 2) continue
      plays.push([...trio, ...cards.slice(0, 2)])
    }
  }

  // 顺子
  for (let len = 5; len <= 12; len++) {
    for (let start = 3; start + len - 1 <= 14; start++) {
      let ok = true
      const chosen = []
      for (let r = start; r < start + len; r++) {
        if (group.has(r) && group.get(r).length >= 1) {
          chosen.push(group.get(r)[0])
        } else {
          ok = false
          break
        }
      }
      if (ok) plays.push(chosen)
    }
  }

  // 连对
  for (let pairCount = 3; pairCount <= 12; pairCount++) {
    for (let start = 3; start + pairCount - 1 <= 14; start++) {
      let ok = true
      const chosen = []
      for (let r = start; r < start + pairCount; r++) {
        if (group.has(r) && group.get(r).length >= 2) {
          chosen.push(...group.get(r).slice(0, 2))
        } else {
          ok = false
          break
        }
      }
      if (ok) plays.push(chosen)
    }
  }

  // 飞机（不带）
  for (let n = 2; n <= 10; n++) {
    for (let start = 3; start + n - 1 <= 14; start++) {
      let ok = true
      const chosen = []
      for (let r = start; r < start + n; r++) {
        if (group.has(r) && group.get(r).length >= 3) {
          chosen.push(...group.get(r).slice(0, 3))
        } else {
          ok = false
          break
        }
      }
      if (ok) plays.push(chosen)
    }
  }

  // 飞机带单
  for (let n = 2; n <= 6; n++) {
    for (let start = 3; start + n - 1 <= 14; start++) {
      const trioRanks = []
      let ok = true
      const chosen = []
      for (let r = start; r < start + n; r++) {
        if (group.has(r) && group.get(r).length >= 3) {
          chosen.push(...group.get(r).slice(0, 3))
          trioRanks.push(r)
        } else {
          ok = false
          break
        }
      }
      if (!ok) continue
      const kickers = []
      for (const [rank, cards] of group) {
        if (trioRanks.includes(rank)) continue
        if (cards.length >= 1) kickers.push(cards[0])
      }
      if (kickers.length >= n) {
        plays.push([...chosen, ...kickers.slice(0, n)])
      }
    }
  }

  // 飞机带对
  for (let n = 2; n <= 6; n++) {
    for (let start = 3; start + n - 1 <= 14; start++) {
      const trioRanks = []
      let ok = true
      const chosen = []
      for (let r = start; r < start + n; r++) {
        if (group.has(r) && group.get(r).length >= 3) {
          chosen.push(...group.get(r).slice(0, 3))
          trioRanks.push(r)
        } else {
          ok = false
          break
        }
      }
      if (!ok) continue
      const kickers = []
      for (const [rank, cards] of group) {
        if (trioRanks.includes(rank)) continue
        if (cards.length >= 2) kickers.push(cards.slice(0, 2))
      }
      if (kickers.length >= n) {
        const wingCards = []
        for (let i = 0; i < n; i++) wingCards.push(...kickers[i])
        plays.push([...chosen, ...wingCards])
      }
    }
  }

  // 四带二（两单）
  for (const [bombRank, bombCards] of group) {
    if (bombCards.length < 4) continue
    const bomb = bombCards.slice(0, 4)
    const singles = []
    for (const [rank, cards] of group) {
      if (rank === bombRank) continue
      if (cards.length >= 1) singles.push(cards[0])
    }
    for (let i = 0; i < singles.length; i++) {
      for (let j = i + 1; j < singles.length; j++) {
        plays.push([...bomb, singles[i], singles[j]])
      }
    }
  }

  // 四带两对
  for (const [bombRank, bombCards] of group) {
    if (bombCards.length < 4) continue
    const bomb = bombCards.slice(0, 4)
    const pairRanks = []
    for (const [rank, cards] of group) {
      if (rank === bombRank) continue
      if (cards.length >= 2) pairRanks.push(rank)
    }
    for (let i = 0; i < pairRanks.length; i++) {
      for (let j = i + 1; j < pairRanks.length; j++) {
        plays.push([...bomb, ...group.get(pairRanks[i]).slice(0, 2), ...group.get(pairRanks[j]).slice(0, 2)])
      }
    }
  }

  return plays
}

function findLegalPlays(hand, lastPlay) {
  const all = collectPlays(hand)
  if (!lastPlay) return all
  return all.filter(play => {
    const parsed = parseCards(play)
    return parsed && canBeat(parsed, lastPlay)
  })
}

function typeWeight(type) {
  const order = {
    single: 1,
    pair: 2,
    trio: 3,
    trio_single: 4,
    trio_pair: 5,
    straight: 6,
    double_straight: 7,
    airplane: 8,
    airplane_single: 9,
    airplane_pair: 10,
    bomb: 11,
    rocket: 12,
    four_two_single: 13,
    four_two_pair: 14
  }
  return order[type] || 99
}

function chooseAiPlay(hand, lastPlay) {
  const legal = sortHintPlays(findLegalPlays(hand, lastPlay))
  if (!legal.length) return null

  // 自由出牌：不要总是出单牌，适当出对子、三张、顺子等组合
  if (!lastPlay) {
    const combos = legal.filter(play => {
      const t = parseCards(play).type
      return t !== 'single' && t !== 'bomb' && t !== 'rocket'
    })
    if (combos.length && (hand.length > 6 || Math.random() < 0.5)) {
      // 优先从较小组合里随机选一个，避免每次都出同一个牌型
      const pickCount = Math.min(3, combos.length)
      return combos[Math.floor(Math.random() * pickCount)]
    }
    return legal[0]
  }

  // 跟牌：非炸弹里优先挑，但偶尔在多个可管牌里随机选，避免总是最小单张
  const nonBomb = legal.filter(play => {
    const t = parseCards(play).type
    return t !== 'bomb' && t !== 'rocket'
  })
  const source = nonBomb.length ? nonBomb : legal
  if (source.length > 1 && Math.random() < 0.35) {
    const pickCount = Math.min(3, source.length)
    return source[Math.floor(Math.random() * pickCount)]
  }
  return source[0]
}

function sortHintPlays(plays) {
  return plays.slice().sort((a, b) => {
    const pa = parseCards(a)
    const pb = parseCards(b)
    if (typeWeight(pa.type) !== typeWeight(pb.type)) return typeWeight(pa.type) - typeWeight(pb.type)
    if (pa.rank !== pb.rank) return pa.rank - pb.rank
    return pa.length - pb.length
  })
}

function aiHandScore(hand) {
  const group = groupByRank(hand)
  let score = 0
  for (const [rank, cards] of group) {
    if (cards.length === 4) score += 4
    else if (cards.length === 3) score += 2
    if (rank === 16 || rank === 17) score += 3
    else if (rank === 15) score += 2
    else if (rank === 14 || rank === 13) score += 1
  }
  return score
}

const TYPE_NAMES = {
  single: '单张',
  pair: '对子',
  trio: '三张',
  trio_single: '三带一',
  trio_pair: '三带一对',
  straight: '顺子',
  double_straight: '连对',
  airplane: '飞机',
  airplane_single: '飞机带单',
  airplane_pair: '飞机带对',
  bomb: '炸弹',
  rocket: '王炸',
  four_two_single: '四带二',
  four_two_pair: '四带两对'
}

function describePlay(play) {
  if (!play) return ''
  const name = TYPE_NAMES[play.type] || play.type
  if (play.type === 'rocket') return name
  return `${name}(${rankText(play.rank)})`
}

export default {
  data() {
    return {
      mode: '',
      phase: 'lobby',
      socket: null,
      connecting: false,
      roomTimer: null,
      room: null,
      isRoomHost: false,
      mySeat: 0,
      joinRoomId: '',
      players: [
        { name: '你', hand: [], cardCount: 0, isLandlord: false },
        { name: '电脑 1', hand: [], cardCount: 0, isLandlord: false },
        { name: '电脑 2', hand: [], cardCount: 0, isLandlord: false }
      ],
      currentPlayer: 0,
      landlordIndex: -1,
      lastPlay: null,
      passCount: 0,
      bottomCards: [],
      selectedIds: [],
      hintIndex: 0,
      statusText: '',
      timers: [],
      bidding: {
        current: 0,
        hasBid: false,
        lastBidder: -1,
        acted: [false, false, false]
      }
    }
  },

  computed: {
    humanHand() {
      return this.players[this.mySeat] ? this.players[this.mySeat].hand : []
    },
    selectedCards() {
      return this.humanHand.filter(card => this.selectedIds.includes(card.id))
    },
    canPass() {
      return this.phase === 'playing' && this.currentPlayer === this.mySeat && !!this.lastPlay
    }
  },

  onLoad(query) {
    if (query && query.roomId) {
      this.joinRoomId = String(query.roomId).toUpperCase()
      this.joinOnlineRoom()
    }
  },

  onUnload() {
    this.clearTimers()
    if (this.mode === 'online') {
      this.leaveOnlineRoom()
    }
    this.unbindSocketEvents()
  },

  methods: {
    cardText(card) {
      return cardText(card)
    },

    rankText(rank) {
      return rankText(rank)
    },

    isRedCard(card) {
      return isRedCard(card)
    },

    clearTimers() {
      this.timers.forEach(timer => clearTimeout(timer))
      this.timers = []
    },

    pushTimer(timer) {
      this.timers.push(timer)
    },

    clearRoomTimer() {
      if (this.roomTimer) {
        clearTimeout(this.roomTimer)
        this.roomTimer = null
      }
    },

    bindSocketEvents() {
      this.socket = getSocket()
      this.socket.off('ddz-room-created', this.handleDdzRoomCreated)
      this.socket.off('ddz-room-joined', this.handleDdzRoomJoined)
      this.socket.off('ddz-room-state', this.handleDdzRoomState)
      this.socket.off('ddz-error', this.handleDdzError)
      this.socket.off('ddz-player-left', this.handleDdzPlayerLeft)
      this.socket.off('connect_error', this.handleDdzConnectError)
      this.socket.on('ddz-room-created', this.handleDdzRoomCreated)
      this.socket.on('ddz-room-joined', this.handleDdzRoomJoined)
      this.socket.on('ddz-room-state', this.handleDdzRoomState)
      this.socket.on('ddz-error', this.handleDdzError)
      this.socket.on('ddz-player-left', this.handleDdzPlayerLeft)
      this.socket.on('connect_error', this.handleDdzConnectError)
    },

    unbindSocketEvents() {
      if (!this.socket) return
      this.socket.off('ddz-room-created', this.handleDdzRoomCreated)
      this.socket.off('ddz-room-joined', this.handleDdzRoomJoined)
      this.socket.off('ddz-room-state', this.handleDdzRoomState)
      this.socket.off('ddz-error', this.handleDdzError)
      this.socket.off('ddz-player-left', this.handleDdzPlayerLeft)
      this.socket.off('connect_error', this.handleDdzConnectError)
    },

    createOnlineRoom() {
      this.connecting = true
      this.mode = 'online'
      this.clearRoomTimer()
      this.roomTimer = setTimeout(() => {
        if (this.connecting) {
          this.connecting = false
          uni.showToast({
            title: '创建房间超时，请稍后重试',
            icon: 'none',
            duration: 3000
          })
        }
      }, 8000)
      this.bindSocketEvents()
      this.socket.connect()
      this.socket.off('ddz-room-created', this.handleDdzRoomCreated)
      this.socket.on('ddz-room-created', this.handleDdzRoomCreated)
      if (this.socket.connected) {
        this.emitCreateOnlineRoom()
      } else {
        this.socket.once('connect', () => this.emitCreateOnlineRoom())
      }
    },

    emitCreateOnlineRoom() {
      this.socket.emit('ddz-create-room')
    },

    joinOnlineRoom() {
      let roomId = (this.joinRoomId || '').trim().toUpperCase()
      if (!roomId) {
        uni.showToast({ title: '请输入房间号', icon: 'none' })
        return
      }
      this.connecting = true
      this.mode = 'online'
      this.clearRoomTimer()
      this.roomTimer = setTimeout(() => {
        if (this.connecting) {
          this.connecting = false
          uni.showToast({
            title: '加入房间超时，请检查房间号或稍后重试',
            icon: 'none',
            duration: 3000
          })
        }
      }, 8000)
      this.bindSocketEvents()
      this.socket.connect()
      this.socket.off('ddz-room-joined', this.handleDdzRoomJoined)
      this.socket.on('ddz-room-joined', this.handleDdzRoomJoined)
      if (this.socket.connected) {
        this.emitJoinOnlineRoom(roomId)
      } else {
        this.socket.once('connect', () => this.emitJoinOnlineRoom(roomId))
      }
    },

    emitJoinOnlineRoom(roomId) {
      this.socket.emit('ddz-join-room', { roomId })
    },

    handleDdzRoomCreated(data) {
      this.clearRoomTimer()
      this.connecting = false
      this.applyOnlineRoomState(data)
    },

    handleDdzRoomJoined(data) {
      this.clearRoomTimer()
      this.connecting = false
      this.applyOnlineRoomState(data)
    },

    handleDdzRoomState(data) {
      if (this.room && data.room && this.room.id !== data.room.id) return
      this.applyOnlineRoomState(data)
    },

    handleDdzConnectError() {
      this.clearRoomTimer()
      this.connecting = false
      uni.showToast({
        title: '网络连接失败，请检查网络后重试',
        icon: 'none',
        duration: 2500
      })
    },

    handleDdzError(err) {
      this.clearRoomTimer()
      this.connecting = false
      uni.showToast({
        title: (err && err.message) || '斗地主房间操作失败',
        icon: 'none',
        duration: 2500
      })
    },

    handleDdzPlayerLeft(data) {
      if (data && data.message) {
        uni.showToast({ title: data.message, icon: 'none', duration: 2500 })
      }
      if (data && data.room) {
        this.applyOnlineRoomState(data)
      } else if (data && data.roomState) {
        this.applyOnlineRoomState(data.roomState)
      }
    },

    applyOnlineRoomState(data) {
      if (!data || !data.room) return
      this.room = data.room
      this.mySeat = (data.you && typeof data.you.index === 'number') ? data.you.index : this.mySeat
      const me = data.room.players && data.room.players[this.mySeat]
      this.isRoomHost = !!(me && me.isHost)
      this.phase = data.room.phase || 'waiting'
      this.currentPlayer = typeof data.room.currentPlayer === 'number' ? data.room.currentPlayer : -1
      this.landlordIndex = typeof data.room.landlordIndex === 'number' ? data.room.landlordIndex : -1
      this.bottomCards = data.room.bottomCards || []
      this.lastPlay = data.room.lastPlay || null
      this.statusText = data.room.statusText || ''
      this.passCount = 0
      this.selectedIds = []
      if (data.room.bidding) {
        this.bidding = {
          current: data.room.bidding.current,
          hasBid: !!data.room.bidding.hasBid,
          lastBidder: data.room.bidding.lastBidder,
          acted: data.room.bidding.acted || [false, false, false]
        }
      }
      const myHand = (data.you && data.you.hand) || []
      this.players = (data.room.players || []).map((p, i) => {
        if (!p) {
          return { name: '等待中', hand: [], cardCount: 0, isLandlord: false }
        }
        return {
          name: p.name,
          hand: i === this.mySeat ? myHand.slice() : [],
          cardCount: p.cardCount,
          isLandlord: !!p.isLandlord
        }
      })
    },

    restartOnline() {
      if (!this.socket || !this.room || this.mode !== 'online') return
      if (!this.isRoomHost) {
        uni.showToast({ title: '等待房主重新开局', icon: 'none' })
        return
      }
      this.socket.emit('ddz-restart', { roomId: this.room.id })
    },

    restartOrLeave() {
      if (this.mode === 'online') {
        this.leaveOnlineRoom()
      } else {
        this.startGame()
      }
    },

    leaveOnlineRoom() {
      this.clearRoomTimer()
      if (this.socket && this.socket.connected && this.room) {
        this.socket.emit('ddz-leave', { roomId: this.room.id })
      }
      this.room = null
      this.mode = ''
      this.isRoomHost = false
      this.phase = 'lobby'
      this.resetPlayers()
      this.selectedIds = []
      this.lastPlay = null
      this.bottomCards = []
      this.statusText = ''
    },

    resetPlayers() {
      this.players = [
        { name: '你', hand: [], cardCount: 0, isLandlord: false },
        { name: '电脑 1', hand: [], cardCount: 0, isLandlord: false },
        { name: '电脑 2', hand: [], cardCount: 0, isLandlord: false }
      ]
    },

    startGame() {
      this.clearTimers()
      this.mode = 'local'
      this.mySeat = 0
      this.room = null
      this.resetPlayers()
      this.selectedIds = []
      this.hintIndex = 0
      this.lastPlay = null
      this.passCount = 0
      this.landlordIndex = -1
      this.statusText = ''
      this.bidding = {
        current: 0,
        hasBid: false,
        lastBidder: -1,
        acted: [false, false, false]
      }

      const deck = shuffle(createDeck())
      for (let i = 0; i < 51; i++) {
        this.players[i % 3].hand.push(deck[i])
      }
      this.bottomCards = deck.slice(51, 54)
      this.players.forEach(p => {
        p.cardCount = p.hand.length
        sortHand(p.hand)
      })

      this.bidding.current = Math.floor(Math.random() * 3)
      this.currentPlayer = this.bidding.current
      this.phase = 'bidding'
      this.statusText = `轮到 ${this.playerName(this.bidding.current)} 叫地主`
      this.scheduleBid()
    },

    onlineComingSoon() {
      uni.showToast({
        title: '在线斗地主开发中，敬请期待',
        icon: 'none',
        duration: 2000
      })
    },

    backToLobby() {
      this.clearTimers()
      if (this.mode === 'online') {
        this.leaveOnlineRoom()
      }
      this.unbindSocketEvents()
      this.phase = 'lobby'
      this.mode = ''
      this.resetPlayers()
      this.selectedIds = []
      this.lastPlay = null
      this.bottomCards = []
      this.statusText = ''
    },

    playerName(index) {
      return this.players[index] ? this.players[index].name : ''
    },

    nextPlayer(index) {
      return (index + 1) % 3
    },

    // ---------- 叫地主 / 抢地主 ----------
    scheduleBid() {
      if (this.mode !== 'local') return
      if (this.phase !== 'bidding') return
      if (this.bidding.current === this.mySeat) return
      const timer = setTimeout(() => this.aiBid(), 800)
      this.pushTimer(timer)
    },

    aiBid() {
      if (this.mode !== 'local') return
      if (this.phase !== 'bidding') return
      const idx = this.bidding.current
      const score = aiHandScore(this.players[idx].hand)
      const shouldGrab = this.bidding.hasBid ? score >= 6 : score >= 5
      const action = shouldGrab ? (this.bidding.hasBid ? 'grab' : 'call') : 'pass'
      this.applyBid(action)
    },

    handleBid(action) {
      if (this.phase !== 'bidding' || this.bidding.current !== this.mySeat) return
      if (this.mode === 'online') {
        this.socket.emit('ddz-bid', { roomId: this.room.id, action })
        return
      }
      this.applyBid(action)
    },

    applyBid(action) {
      const idx = this.bidding.current
      if (this.bidding.acted[idx]) return
      this.bidding.acted[idx] = true

      if (action === 'call' || action === 'grab') {
        this.bidding.hasBid = true
        this.bidding.lastBidder = idx
        this.statusText = `${this.playerName(idx)}${action === 'call' ? ' 叫地主！' : ' 抢地主！'}`
      } else {
        this.statusText = `${this.playerName(idx)}${this.bidding.hasBid ? ' 不抢' : ' 不叫'}`
      }

      if (this.bidding.acted.every(Boolean)) {
        if (this.bidding.lastBidder >= 0) {
          this.startPlaying(this.bidding.lastBidder)
        } else {
          this.statusText = '没人叫地主，重新发牌'
          const timer = setTimeout(() => this.startGame(), 1200)
          this.pushTimer(timer)
        }
        return
      }

      // 下一位未操作玩家
      let next = this.nextPlayer(idx)
      while (this.bidding.acted[next]) {
        next = this.nextPlayer(next)
      }
      this.bidding.current = next
      this.currentPlayer = next
      this.statusText = `轮到 ${this.playerName(next)}${this.bidding.hasBid ? ' 抢地主' : ' 叫地主'}`
      this.scheduleBid()
    },

    startPlaying(landlordIndex) {
      this.landlordIndex = landlordIndex
      this.players[landlordIndex].isLandlord = true
      this.players[landlordIndex].hand.push(...this.bottomCards)
      sortHand(this.players[landlordIndex].hand)
      this.players[landlordIndex].cardCount = this.players[landlordIndex].hand.length
      this.currentPlayer = landlordIndex
      this.lastPlay = null
      this.passCount = 0
      this.phase = 'playing'
      this.statusText = `${this.playerName(landlordIndex)} 成为地主，获得底牌，先出牌`
      this.scheduleAiTurn(1000)
    },

    // ---------- 出牌 ----------
    isSelected(id) {
      return this.selectedIds.includes(id)
    },

    toggleCard(card) {
      if (this.phase !== 'playing' || this.currentPlayer !== this.mySeat) return
      const index = this.selectedIds.indexOf(card.id)
      if (index >= 0) {
        this.selectedIds.splice(index, 1)
      } else {
        this.selectedIds.push(card.id)
      }
    },

    playCards() {
      if (this.phase !== 'playing' || this.currentPlayer !== this.mySeat) return
      const cards = this.selectedCards
      if (!cards.length) {
        uni.showToast({ title: '请先选择要出的牌', icon: 'none' })
        return
      }
      const play = parseCards(cards)
      if (!play) {
        uni.showToast({ title: '不是合法牌型', icon: 'none' })
        return
      }
      if (this.lastPlay && !canBeat(play, this.lastPlay)) {
        uni.showToast({ title: '管不上这手牌', icon: 'none' })
        return
      }
      this.hintIndex = 0
      if (this.mode === 'online') {
        this.socket.emit('ddz-play', {
          roomId: this.room.id,
          cards
        })
        return
      }
      this.applyPlay(this.mySeat, cards, play)
    },

    pass() {
      if (this.phase !== 'playing' || this.currentPlayer !== this.mySeat) return
      if (!this.lastPlay) {
        uni.showToast({ title: '新一轮必须出牌', icon: 'none' })
        return
      }
      if (this.mode === 'online') {
        this.socket.emit('ddz-pass', { roomId: this.room.id })
        return
      }
      this.applyPass(this.mySeat)
    },

    hint() {
      if (this.phase !== 'playing' || this.currentPlayer !== this.mySeat) return
      const legal = sortHintPlays(findLegalPlays(this.humanHand, this.lastPlay))
      if (!legal.length) {
        uni.showToast({ title: this.lastPlay ? '没有能管的牌，建议不出' : '没有可出的牌型', icon: 'none' })
        return
      }
      const play = legal[this.hintIndex % legal.length]
      this.hintIndex++
      this.selectedIds = play.map(card => card.id)
    },

    applyPlay(playerIndex, cards, play) {
      const hand = this.players[playerIndex].hand
      const removeIds = new Set(cards.map(c => c.id))
      this.players[playerIndex].hand = hand.filter(c => !removeIds.has(c.id))
      this.players[playerIndex].cardCount = this.players[playerIndex].hand.length
      this.lastPlay = {
        player: playerIndex,
        cards: cards.slice(),
        type: play.type,
        rank: play.rank,
        length: play.length
      }
      this.passCount = 0
      this.selectedIds = []
      this.statusText = `${this.playerName(playerIndex)} 出了 ${describePlay(play)}`

      if (this.players[playerIndex].hand.length === 0) {
        this.endGame(playerIndex)
        return
      }

      this.currentPlayer = this.nextPlayer(playerIndex)
      this.scheduleAiTurn(900)
    },

    applyPass(playerIndex) {
      this.passCount++
      this.statusText = `${this.playerName(playerIndex)} 不出`
      this.selectedIds = []

      if (this.passCount >= 2 && this.lastPlay) {
        const leader = this.lastPlay.player
        this.lastPlay = null
        this.passCount = 0
        this.currentPlayer = leader
        this.statusText = `${this.playerName(leader)} 获得出牌权`
      } else {
        this.currentPlayer = this.nextPlayer(playerIndex)
      }

      this.scheduleAiTurn(800)
    },

    scheduleAiTurn(delay) {
      if (this.mode !== 'local') return
      if (this.phase !== 'playing') return
      if (this.currentPlayer === this.mySeat) return
      const timer = setTimeout(() => this.aiTurn(), delay || 900)
      this.pushTimer(timer)
    },

    aiTurn() {
      if (this.phase !== 'playing') return
      const idx = this.currentPlayer
      const hand = this.players[idx].hand
      if (this.lastPlay) {
        const legal = findLegalPlays(hand, this.lastPlay)
        if (!legal.length) {
          this.applyPass(idx)
          return
        }
        const play = chooseAiPlay(hand, this.lastPlay)
        this.applyPlay(idx, play, parseCards(play))
      } else {
        const play = chooseAiPlay(hand, null)
        if (!play) {
          // 正常情况不会发生：首出一定有牌可出
          this.applyPass(idx)
          return
        }
        this.applyPlay(idx, play, parseCards(play))
      }
    },

    endGame(winnerIndex) {
      this.clearTimers()
      const landlordWon = winnerIndex === this.landlordIndex
      const humanIsLandlord = this.landlordIndex === 0
      if (landlordWon) {
        this.statusText = humanIsLandlord ? '🎉 你赢了！地主获胜' : '😢 地主获胜，农民输了'
      } else {
        this.statusText = humanIsLandlord ? '😢 你输了，农民获胜' : '🎉 你赢了！农民获胜'
      }
      this.phase = 'ended'
    }
  }
}
</script>

<style scoped>
.container {
  display: block;
  width: 100%;
  /* 100% 交给外层 page body：H5 顶部还有 44px 导航条，写 100vh 会整体多出一截 */
  min-height: 100%;
  box-sizing: border-box;
  background: transparent;
}

.lobby {
  display: block;
  width: 100%;
  box-sizing: border-box;
}

.hero {
  display: block;
  width: 100%;
  box-sizing: border-box;
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
  display: block;
  width: 100%;
  box-sizing: border-box;
  font-size: 16px;
  font-weight: 700;
  color: #14342a;
  margin-bottom: 12px;
}

.btn-primary {
  display: block;
  width: 100%;
  box-sizing: border-box;
  background: linear-gradient(135deg, #34d399 0%, #0f9d63 100%);
  color: #fff;
  border: none;
  border-radius: 12px;
  padding: 12px 24px;
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 10px;
  cursor: pointer;
  box-shadow: 0 10px 24px -14px rgba(15, 157, 99, 0.85);
}

.btn-secondary {
  display: block;
  width: 100%;
  box-sizing: border-box;
  background: #ffffff;
  color: #0b7a4c;
  border: 1px solid rgba(16, 157, 99, 0.28);
  border-radius: 12px;
  padding: 12px 24px;
  font-size: 16px;
  font-weight: 600;
  margin-top: 10px;
  cursor: pointer;
}

.divider {
  display: block;
  width: 100%;
  box-sizing: border-box;
  text-align: center;
  color: #8aa89b;
  font-size: 13px;
  margin: 6px 0 14px;
}

.tip {
  display: block;
  width: 100%;
  box-sizing: border-box;
  margin-top: 8px;
  font-size: 12px;
  color: #8aa89b;
  line-height: 1.7;
}

/* ================= 牌桌 ================= */
/* 牌桌要「顶到屏幕下沿」才好操作，但 H5 顶部还有一条导航栏，
   直接写 100vh 会多出一截把底部按钮顶出屏幕，所以按导航高度减掉。 */
.ddz-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - var(--window-top, 44px));
  min-height: 560px;
  box-sizing: border-box;
}

.game {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: transparent;
  color: #14342a;
  padding: 10px 12px 20px;
  box-sizing: border-box;
}

.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0 10px;
}

.waiting-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  border: 1px solid rgba(16, 122, 86, 0.1);
  border-radius: 20px;
  padding: 36px 24px;
  margin: 20px 0;
  box-shadow: 0 20px 44px -28px rgba(13, 84, 60, 0.55);
}

.waiting-title {
  font-size: 22px;
  font-weight: 800;
  color: #14342a;
}

.waiting-room {
  margin-top: 12px;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: 2px;
  color: #0f7a4f;
}

.waiting-status {
  margin-top: 8px;
  font-size: 13px;
  line-height: 1.6;
  text-align: center;
  color: #5c7c6d;
}

.seat-list {
  width: 100%;
  margin-top: 24px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.seat-item {
  background: #f7fcf9;
  border: 1px solid rgba(16, 122, 86, 0.1);
  border-radius: 12px;
  padding: 14px 16px;
  text-align: center;
  font-size: 15px;
  color: #37584a;
}

.seat-item.filled {
  background: #e8f7ef;
  border-color: rgba(16, 157, 99, 0.3);
  color: #0b7a4c;
  font-weight: 600;
}

.seat-role {
  margin-left: 8px;
  color: #0f9d63;
  font-size: 12px;
}

.btn-back {
  width: 56px;
  background: #ffffff;
  color: #0b7a4c;
  border: 1px solid rgba(16, 157, 99, 0.24);
  border-radius: 10px;
  padding: 6px 0;
  font-size: 14px;
  text-align: center;
  cursor: pointer;
  flex-shrink: 0;
}

.game-title {
  flex: 1;
  text-align: center;
  font-size: 18px;
  font-weight: 700;
  color: #14342a;
  white-space: nowrap;
}

.spacer {
  width: 56px;
  flex-shrink: 0;
}

.opponents {
  display: flex;
  justify-content: space-between;
  gap: 10px;
}

.opponent {
  flex: 1;
  background: #ffffff;
  border: 1px solid rgba(16, 122, 86, 0.1);
  border-radius: 12px;
  padding: 10px;
  text-align: center;
  box-shadow: 0 12px 26px -24px rgba(13, 84, 60, 0.6);
}

.opponent-head {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}

.opponent-name {
  font-size: 14px;
  font-weight: 600;
  color: #223f34;
}

.role-badge {
  font-size: 10px;
  background: #eef8f2;
  color: #4f7363;
  border-radius: 8px;
  padding: 2px 6px;
}

.role-badge.landlord {
  background: #d98324;
  color: #fff;
}

.opponent-info {
  margin-top: 6px;
  font-size: 12px;
  color: #6b8a7c;
}

.card-count {
  display: block;
}

.thinking {
  display: block;
  color: #0f9d63;
  font-size: 11px;
}

/* 牌桌中央：深绿绒布，和白卡形成对比，也最像一张真的牌桌 */
.table {
  background:
    radial-gradient(120% 130% at 50% 0%, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0) 60%),
    linear-gradient(160deg, #12805a 0%, #0d6a4a 52%, #0a5640 100%);
  border: 1px solid rgba(9, 74, 53, 0.4);
  border-radius: 16px;
  margin: 12px 0;
  padding: 12px;
  min-height: 110px;
  /* 绒布吃掉中间多余的高度：牌桌铺满，手牌与按钮自然落在屏幕下沿 */
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 6px;
  color: #eafaf2;
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    0 18px 40px -26px rgba(9, 74, 53, 0.9);
}

.bottom-row,
.last-play-area {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
}

.bottom-label,
.last-label {
  font-size: 12px;
  opacity: 0.8;
}

.mini-cards,
.played-cards {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  justify-content: center;
}

.mini-card,
.played-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 38px;
  background: #fff;
  color: #333;
  border-radius: 5px;
  font-size: 14px;
  font-weight: 700;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
  box-sizing: border-box;
  overflow: hidden;
  line-height: 1;
}

.mini-rank {
  font-size: 14px;
  line-height: 1;
}

.mini-suit {
  font-size: 12px;
  line-height: 1;
  margin-top: 2px;
}

.mini-joker {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.mini-joker-letter {
  font-size: 7px;
  font-weight: 900;
  line-height: 1.05;
}

.mini-card.red,
.played-card.red {
  color: #e53935;
}

.last-play-area {
  margin-top: 12px;
}

.muted {
  font-size: 13px;
  opacity: 0.75;
}

.status {
  margin-top: 14px;
  text-align: center;
  font-size: 15px;
  font-weight: 600;
  /* 状态文字压在深绿绒布上，用近白色 */
  color: #eafaf2;
  min-height: 22px;
}

.hand-wrap {
  /* 不用 flex:1 撑高：撑出来的空白会把底部的叫地主按钮顶出屏幕，
     改成「把多余空间留在上方」，内容多时整页自然变高、不裁切 */
  flex: 0 1 auto;
  margin-top: auto;
  display: flex;
  align-items: flex-end;
  justify-content: flex-start;
  padding: 10px 0 12px;
  overflow-x: auto;
}

.hand {
  display: flex;
  flex-wrap: nowrap;
  align-items: flex-end;
  justify-content: center;
  margin: 0 auto;
  padding: 22px 8px 6px;
  min-height: 100px;
}

.hand-card {
  position: relative;
  width: 46px;
  height: 66px;
  background: #fff;
  color: #333;
  border-radius: 8px;
  margin-left: -22px;
  box-shadow: 0 3px 10px rgba(13, 84, 60, 0.22);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: transform 0.15s ease;
  flex-shrink: 0;
  overflow: hidden;
}

.hand-card:first-child {
  margin-left: 0;
}

.hand-card.selected {
  transform: translateY(-18px);
  box-shadow: 0 10px 20px rgba(16, 157, 99, 0.45);
}

.hand-card.red {
  color: #e53935;
}

.card-corner {
  position: absolute;
  top: 4px;
  left: 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1;
}

.card-rank {
  font-size: 20px;
  font-weight: 800;
  line-height: 1;
}

.card-suit {
  font-size: 14px;
  line-height: 1.1;
  margin-top: 1px;
}

.card-suit-big {
  font-size: 38px;
  opacity: 0.9;
  line-height: 1;
}

.joker-vertical {
  position: absolute;
  left: 5px;
  top: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  font-size: 13px;
  font-weight: 900;
  line-height: 1.15;
  color: inherit;
}

.joker-letter {
  font-size: 10px;
  font-weight: 900;
  line-height: 1.1;
}

.joker-sub {
  position: absolute;
  bottom: 5px;
  right: 5px;
  font-size: 11px;
  background: rgba(16, 122, 86, 0.1);
  color: #333;
  border-radius: 6px;
  padding: 2px 5px;
}

.actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  padding: 10px 12px 14px;
}

.btn-action {
  flex: 1;
  min-width: 0;
  background: #ffffff;
  color: #0b7a4c;
  border: 1px solid rgba(16, 157, 99, 0.26);
  border-radius: 12px;
  padding: 12px 0;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 0 10px 22px -18px rgba(13, 84, 60, 0.7);
}

.btn-action.primary {
  background: linear-gradient(135deg, #34d399 0%, #0f9d63 100%);
  border-color: transparent;
  color: #fff;
  box-shadow: 0 12px 24px -16px rgba(15, 157, 99, 0.95);
}

.btn-action[disabled] {
  opacity: 0.4;
}

.bid-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
  padding: 10px 12px 20px;
}

.overlay {
  position: fixed;
  left: 0;
  top: 0;
  right: 0;
  bottom: 0;
  background: rgba(9, 60, 42, 0.45);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 99;
}

.result-card {
  width: 280px;
  background: #ffffff;
  border: 1px solid rgba(16, 122, 86, 0.12);
  border-radius: 18px;
  padding: 24px;
  text-align: center;
  color: #14342a;
  box-shadow: 0 30px 60px -30px rgba(9, 60, 42, 0.6);
}

.result-title {
  display: block;
  font-size: 20px;
  font-weight: 800;
  color: #0f7a4f;
  margin-bottom: 10px;
}

.result-text {
  display: block;
  font-size: 16px;
  color: #37584a;
  margin-bottom: 20px;
}

/* 横屏适配 */
@media (orientation: landscape) {
  .game {
    padding: 6px 12px 10px;
  }

  .top-bar {
    padding: 2px 0 6px;
  }

  .table {
    min-height: 80px;
    margin: 8px 0;
  }

  .hand-card {
    width: 40px;
    height: 58px;
    margin-left: -20px;
  }

  .card-rank {
    font-size: 19px;
  }

  .card-suit {
    font-size: 15px;
  }

  .actions {
    padding: 6px 12px 10px;
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
.btn-primary {
  background: linear-gradient(135deg, #6d8bff 0%, #4d6bfe 100%);
  color: #ffffff;
  box-shadow: 0 14px 28px -18px rgba(77, 107, 254, 0.85);
}
.btn-secondary {
  background: rgba(184, 198, 255, 0.08);
  color: var(--c-text);
  border-color: rgba(184, 198, 255, 0.2);
}

/* ===== 深海覆盖：对局界面 ===== */
.waiting-panel,
.opponent,
.result-card {
  background: rgba(11, 23, 48, 0.78);
  border-color: var(--c-line);
  color: var(--c-text);
  box-shadow: 0 24px 50px -36px rgba(0, 0, 0, 0.9);
}
.waiting-title { color: var(--c-text); }
.waiting-room { color: var(--c-primary-soft); }
.waiting-status { color: var(--c-text-2); }
.seat-item {
  background: #0a1428;
  border-color: var(--c-line);
  color: var(--c-text-2);
}
.seat-item.filled {
  background: rgba(77, 107, 254, 0.16);
  border-color: rgba(110, 231, 255, 0.32);
  color: var(--c-text);
}
.seat-role { color: var(--c-primary-soft); }

.btn-back {
  background: rgba(11, 23, 48, 0.72);
  color: var(--c-text);
  border-color: var(--c-line);
}
.game-title { color: var(--c-text); }
.opponent-name { color: var(--c-text); }
.role-badge {
  background: rgba(184, 198, 255, 0.08);
  color: var(--c-text-2);
}
.role-badge.landlord { background: #d98324; color: #fff; }
.opponent-info { color: var(--c-text-3); }
.thinking { color: var(--c-primary-soft); }

/* 牌桌：深蓝绒布，替换原来的绿色 */
.table {
  background:
    radial-gradient(120% 130% at 50% 0%, rgba(110, 231, 255, 0.08) 0%, rgba(110, 231, 255, 0) 60%),
    linear-gradient(160deg, #1b3366 0%, #12234a 52%, #0b1730 100%);
  border-color: rgba(110, 231, 255, 0.2);
  color: var(--c-text);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.08),
    0 24px 50px -30px rgba(0, 0, 0, 0.9);
}
.status { color: var(--c-text); }
.bottom-label,
.last-label { color: var(--c-text-2); }

.hand-card { background: #ffffff; color: #333333; }
.hand-card.selected { box-shadow: 0 10px 20px rgba(110, 231, 255, 0.4); }
.joker-sub { color: #333333; }

.btn-action {
  background: rgba(11, 23, 48, 0.8);
  color: var(--c-text);
  border-color: rgba(184, 198, 255, 0.2);
  box-shadow: 0 12px 24px -20px rgba(0, 0, 0, 0.9);
}
.btn-action.primary {
  background: linear-gradient(135deg, #6d8bff 0%, #4d6bfe 100%);
  color: #ffffff;
  border-color: transparent;
  box-shadow: 0 12px 24px -16px rgba(77, 107, 254, 0.9);
}

.overlay { background: rgba(2, 4, 10, 0.68); }
.result-title { color: var(--c-primary-soft); }
.result-text { color: var(--c-text-2); }

.hand-wrap::-webkit-scrollbar { height: 6px; }
.hand-wrap::-webkit-scrollbar-thumb { background: rgba(110, 231, 255, 0.25); border-radius: 999px; }
</style>
