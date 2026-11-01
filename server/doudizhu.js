// 斗地主服务端纯逻辑：发牌、牌型判断、比牌
// 前端本地 AI 版也使用同一套牌型规则（页面内另有实现，这里给联机房间用）

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

module.exports = {
  createDeck,
  shuffle,
  sortHand,
  rankText,
  parseCards,
  canBeat,
  describePlay
}
