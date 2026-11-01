const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');
const { resolveBilibili, resolveBiliPlayUrl, UA, REFERER } = require('./bilibili');
const { resolveAny } = require('./video-resolve');
const mediaProxy = require('./media-proxy');
const ddz = require('./doudizhu');
const serveStaticH5 = require('./static-h5');
const axios = require('axios');

// ---------- 极简 .env 加载器 ----------
// 不额外引入 dotenv：只在 server/.env 存在时读取，已存在的真实环境变量优先。
// 必须放在 require('./db') 之前，因为数据目录 / 数据库路径要在建库前就确定。
(function loadEnvFile() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const text = line.trim();
      if (!text || text.startsWith('#')) continue;
      const eq = text.indexOf('=');
      if (eq < 1) continue;
      const key = text.slice(0, eq).trim();
      let value = text.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    console.warn('[env] 读取 server/.env 失败，已忽略：' + err.message);
  }
})();

const db = require('./db');
const { createAuth, ensureInitialAdmin } = require('./auth');
const pkg = require('./package.json');

// 后台管理（/admin 页面 + /api/admin 接口）开关。
// 发行「不含后台」的包时用 ENABLE_ADMIN=0 启动，此时连模块都不加载、目录也不必打包。
const ADMIN_ENABLED = process.env.ENABLE_ADMIN !== '0';
let createAdminRouter = null;
if (ADMIN_ENABLED) {
  ({ createAdminRouter } = require('./admin/router'));
}

const STARTED_AT = Date.now();
const auth = createAuth({ db });

const app = express();
const server = http.createServer(app);

// 反向代理（Nginx/Caddy/云托管）后还原真实协议，
// 否则 HTTPS 页面会拿到 http:// 的上传/音乐地址被判为混合内容
app.set('trust proxy', 1);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// 系统配置统一从这里读（带缓存，后台改完立即失效）
const S = () => db.getSettings();

const PORT = process.env.PORT || 3000;
const QUIET_START = process.env.QUIET_START === '1';
// 上传上限改成后台可配置，这里只保留一个兜底默认值（读取时以配置为准）
const maxUploadBytes = () => Math.max(1, S().maxUploadMB) * 1024 * 1024;
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
const H5_DIST_CANDIDATES = [
  process.env.H5_DIST_DIR,
  path.join(__dirname, '..', 'unpackage', 'dist', 'build', 'h5'),
  path.join(__dirname, '..', 'unpackage', 'dist', 'build', 'web')
].filter(Boolean);
// 必须真的存在 index.html 才算“前端产物”，否则空目录会让所有页面返回 500
const H5_DIST = H5_DIST_CANDIDATES.find((p) => fs.existsSync(path.join(p, 'index.html'))) || null;
const NETEASE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const NETEASE_REFERER = 'https://music.163.com/';
const NETEASE_SEARCH_API = 'https://music.163.com/api/search/get/web';
const NETEASE_PLAYLISTS = [
  { id: '3778678', name: '热歌榜' },
  { id: '3779629', name: '新歌榜' },
  { id: '19723756', name: '飙升榜' }
];
const NETEASE_PLAYLIST_API = 'https://music.163.com/api/v6/playlist/detail';
const NETEASE_LYRIC_API = 'https://music.163.com/api/song/lyric';
const neteasePlayUrl = (id) => `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`;

// 确保 uploads 目录存在
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- 中间件 ----------
app.use(cors({ origin: process.env.CORS_ORIGIN || '*' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// 基础安全响应头（不设 CSP，避免误伤 CDN 与内联脚本）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// 极简内存限流：防止公网上的解析/上传/代理被刷
const rateBuckets = new Map();
function rateLimit(maxPerMinute) {
  return (req, res, next) => {
    const key = req.ip + ':' + req.path;
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || now - bucket.start > 60000) {
      rateBuckets.set(key, { start: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > maxPerMinute) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.start > 600000) rateBuckets.delete(key);
  }
}, 600000).unref();

// uploads 静态访问
app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '1d',
  setHeaders(res) {
    // 只允许当媒体文件用，禁止浏览器把它当 HTML/SVG 执行
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
  }
}));

// ---------- 健康检查 ----------
// ---------- 局域网地址（分享链接 / 二维码要用真实 IP，不能是 localhost）----------
// 手机扫码连不上，绝大多数是选错了网卡：Windows 上装了 VMware / WSL / Docker / 各种代理
// 或 VPN 软件（Clash、WireGuard、WARP、Tailscale…）都会多出一个「看起来像局域网」的网卡，
// 但它只有本机连得通，手机扫了必然超时。这里把这类网卡识别出来排到最后，
// 优先返回真正能上网的那块网卡。
const VIRTUAL_IF = new RegExp([
  'vethernet', 'vmware', 'vmnet', 'virtualbox', 'vbox', 'hyper-?v',
  'loopback', 'docker', 'br-', 'tun\\d', 'tap\\d', 'utun',
  'tailscale', 'zerotier', 'hamachi', 'npcap', 'bluetooth',
  'wireguard', 'wintun', 'openvpn', 'clash', 'mihomo', 'sing-?box',
  'v2ray', 'xray', 'shadowsocks', 'ss-?tun', 'proxifier', 'sstap',
  'warp', 'yomi', 'nekoray', 'quantumult', 'surge', 'radmin', 'nordlynx'
].join('|'), 'i');

// 有线/无线网卡的名字特征：用来在界面上告诉用户「这块是 Wi-Fi」
const WIFI_IF = /(wlan|wi-?fi|无线|wireless|airport)/i;
const ETH_IF = /(ethernet|以太网|本地连接|lan\b)/i;

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  Object.keys(ifaces).forEach((name) => {
    (ifaces[name] || []).forEach((info) => {
      const family = typeof info.family === 'string' ? info.family : info.family === 4 ? 'IPv4' : '';
      if (family !== 'IPv4' || info.internal) return;
      const ip = info.address;
      // 169.254.x.x 是没拿到 DHCP 时的自动地址，手机绝对连不上
      if (!ip || ip.startsWith('169.254.')) return;
      // 100.64~127.x 是运营商级 NAT 段（Tailscale / ZeroTier 也爱用），手机连不通
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return;
      out.push({ name, ip, virtual: VIRTUAL_IF.test(name) });
    });
  });

  // 打分：分数越小越优先。真实网卡 → 常见家用网段 → 其它私有段 → 公网段 → 虚拟网卡
  const scoreOf = (item) => {
    if (item.virtual) return 90;
    let score = 0;
    if (/^192\.168\./.test(item.ip)) score += 0;        // 家用路由器最常见
    else if (/^10\./.test(item.ip)) score += 10;        // 公司/校园网常见
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(item.ip)) score += 20;
    else score += 40;                                    // 公网 IP 说明直接暴露，反而不一定可达
    if (WIFI_IF.test(item.name)) score -= 2;             // 手机通常连的就是同一个 Wi-Fi
    return score;
  };

  out.sort((a, b) => scoreOf(a) - scoreOf(b) || a.name.localeCompare(b.name));

  const kindOf = (item) => {
    if (item.virtual) return 'virtual';
    if (WIFI_IF.test(item.name)) return 'wifi';
    if (ETH_IF.test(item.name)) return 'ethernet';
    return 'other';
  };

  const decorated = out.map((i) => ({
    ip: i.ip,
    name: i.name,
    kind: kindOf(i),
    virtual: i.virtual
  }));

  // 有真实网卡时就别把虚拟网卡给用户了，扫了也是连不通
  const real = decorated.filter((i) => !i.virtual);
  return real.length ? real : decorated;
}

// ---------- 公网地址（内网穿透）----------
// server/tunnel.js 起 cloudflared 后会把地址写进 data/tunnel.json；
// 也可以直接在 .env 里写 PUBLIC_URL=https://your-domain 固定下来。
const TUNNEL_FILE = path.join(__dirname, 'data', 'tunnel.json');
const TUNNEL_TTL = 12 * 3600 * 1000; // 快速隧道地址重启即失效，超过 12 小时不再采信

function publicUrl() {
  const fromEnv = String(process.env.PUBLIC_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  try {
    if (!fs.existsSync(TUNNEL_FILE)) return '';
    const data = JSON.parse(fs.readFileSync(TUNNEL_FILE, 'utf8'));
    if (!data || !data.url) return '';
    if (!/^https?:\/\//i.test(String(data.url))) return '';
    if (data.at && Date.now() - data.at > TUNNEL_TTL) return '';
    return String(data.url).replace(/\/+$/, '');
  } catch (e) {
    return '';
  }
}

// 隧道进程还在不在：tunnel.json 是 cloudflared 启动时写的，进程被杀掉后文件会残留。
// 前端据此跳过「探测公网地址」的等待（原来隧道关了以后，进房间要白等 4 秒才出二维码）。
// 返回 true / false / null（null = 没法判断，交给前端自己去探测）
function tunnelAlive() {
  const fromEnv = String(process.env.PUBLIC_URL || '').trim();
  if (fromEnv) return true; // 手填的固定域名，由前端探测去确认
  try {
    if (!fs.existsSync(TUNNEL_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(TUNNEL_FILE, 'utf8'));
    if (!data || !data.url) return null;
    if (data.at && Date.now() - data.at > TUNNEL_TTL) return false;
    const pid = Number(data.pid);
    if (!pid || pid <= 0) return null;
    if (pid === process.pid) return null;
    try {
      process.kill(pid, 0); // 只探活，不真发信号
      return true;
    } catch (e) {
      // EPERM 说明进程存在但没有权限，仍算存活
      return e && e.code === 'EPERM' ? true : false;
    }
  } catch (e) {
    return null;
  }
}

app.get('/api/health', (req, res) => {
  // lan 按「最可能是手机能连通的」排序，前端取第一个做二维码，其余可切换
  const lan = lanAddresses();
  res.json({
    ok: true,
    time: Date.now(),
    port: PORT,
    // 有穿透地址时前端优先用它：同一个链接在家、在 4G 流量下都能打开
    publicUrl: publicUrl(),
    // 隧道进程是否还在：false 时前端直接跳过公网探测，二维码立刻出来
    publicUrlAlive: tunnelAlive(),
    lanIps: lan.map((i) => i.ip),
    lan: lan.map((i) => ({ ip: i.ip, name: i.name, kind: i.kind }))
  });
});

// ---------- 音乐搜索与播放（网易云 / Meting 通用接口） ----------
function neteaseSongAuthor(item) {
  const sources = [item.artists, item.ar, item.album && item.album.artists];
  const artists = sources.find((arr) => Array.isArray(arr) && arr.length) || [];
  return artists.map((a) => a.name).filter(Boolean).join(' / ') || '未知歌手';
}

const httpsify = (url) => String(url || '').replace(/^http:\/\//, 'https://');

/**
 * 把上传文件的绝对地址压成相对路径（/uploads/xxx.mp3）。
 * 队列会广播给房间里所有人：房主若用 localhost 打开，绝对地址到别人那儿就是
 * 127.0.0.1，手机和异地的人一律播不出来；存相对路径则各端按自己的访问地址拼接。
 */
function toRelativeUploadUrl(raw) {
  const url = String(raw || '').trim();
  if (!url) return '';
  // 本服务自己的媒体/接口地址一律存成相对路径（本地上传的 /uploads/xxx、
  // 在线歌曲的 /api/music/stream?id=xxx）：
  // 房主常用 localhost 或某个局域网 IP 打开页面，绝对地址同步给别人后，
  // 手机上的 localhost 就是手机自己，音频直接播不出来。
  // 相对路径让每台设备按自己实际访问的地址去取，换 IP / 换公网隧道都不用管。
  const matched = url.match(/^(?:https?:)?\/\/[^/?#]+(\/(?:uploads|api)\/[^]*)$/i);
  if (matched) return matched[1];
  return url;
}

/** 后台「禁播歌曲」匹配：既支持歌曲 ID，也支持歌名/歌手关键词 */
function isSongBanned(song) {
  const list = S().bannedSongs || [];
  if (!list.length) return false;
  const id = String((song && song.id) || '').trim();
  const text = `${(song && (song.title || song.name)) || ''} ${(song && (song.author || song.artist)) || ''}`.toLowerCase();
  return list.some((raw) => {
    const kw = String(raw || '').trim().toLowerCase();
    if (!kw) return false;
    if (id && kw === id.toLowerCase()) return true;
    return kw.length >= 2 && text.includes(kw);
  });
}

async function searchNetease(keyword) {
  const { data } = await axios.get(NETEASE_SEARCH_API, {
    params: { s: keyword, type: 1, limit: 20 },
    headers: { 'User-Agent': NETEASE_UA, 'Referer': NETEASE_REFERER },
    timeout: 12000
  });
  if (!data || data.code !== 200 || !data.result || !Array.isArray(data.result.songs)) {
    throw new Error('搜索服务返回异常，请稍后再试');
  }
  const songs = data.result.songs;
  const picMap = {};
  const songIds = songs.map((item) => item.id).filter(Boolean).slice(0, 20);
  if (songIds.length) {
    try {
      const detailRes = await axios.get('https://music.163.com/api/song/detail', {
        params: { ids: `[${songIds.join(',')}]` },
        headers: { 'User-Agent': NETEASE_UA, 'Referer': NETEASE_REFERER },
        timeout: 12000
      });
      const details = (detailRes.data && detailRes.data.songs) || [];
      details.forEach((song) => {
        if (!song || song.id == null) return;
        const pic = httpsify((song.album && song.album.picUrl) || (song.al && song.al.picUrl));
        if (pic) picMap[String(song.id)] = pic;
      });
    } catch (err) {
      console.error('获取歌曲封面失败', err && err.message);
    }
  }
  return songs.map((item) => ({
    id: String(item.id || ''),
    title: item.name || '未知歌曲',
    author: neteaseSongAuthor(item),
    url: '',
    pic: picMap[String(item.id)] || httpsify((item.album && item.album.picUrl) || (item.al && item.al.picUrl)),
    duration: Math.round((item.duration || item.dt || 0) / 1000),
    lrc: ''
  }));
}

/** Meting 兼容接口：GET {endpoint}?server=netease&type=search&id=关键词 */
async function searchMeting(keyword, endpoint) {
  const url = endpoint + (endpoint.includes('?') ? '&' : '?')
    + 'server=netease&type=search&id=' + encodeURIComponent(keyword);
  const { data } = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': NETEASE_UA } });
  const list = Array.isArray(data) ? data : (data && (data.data || data.result || data.songs)) || [];
  if (!Array.isArray(list)) throw new Error('音乐接口返回格式不正确，应返回歌曲数组');
  return list.map((item, index) => ({
    id: String(item.id || item.songid || item.url || index),
    title: item.name || item.title || '未知歌曲',
    author: item.artist || item.author || item.singer || '未知歌手',
    url: item.url || '',
    pic: httpsify(item.pic || item.cover || ''),
    duration: Math.round(Number(item.duration || item.time || 0) > 10000
      ? Number(item.duration || item.time) / 1000
      : Number(item.duration || item.time || 0)),
    lrc: item.lrc || ''
  }));
}

/**
 * 统一搜索入口：按后台配置选择网易云公开接口或自建 Meting 接口
 * 返回 { items, source, endpoint }
 */
async function searchMusic(keyword) {
  const settings = S();
  const useMeting = settings.musicSource === 'meting' && settings.metingApiUrl;
  const items = useMeting
    ? await searchMeting(keyword, settings.metingApiUrl)
    : await searchNetease(keyword);
  const visible = items.filter((song) => !isSongBanned(song));
  return {
    items: visible,
    blocked: items.length - visible.length,
    source: useMeting ? 'meting' : 'netease',
    endpoint: useMeting ? settings.metingApiUrl : NETEASE_SEARCH_API
  };
}

app.get('/api/music/search', async (req, res) => {
  const keyword = String(req.query.keyword || '').trim();
  const server = String(req.query.server || 'netease').trim();
  if (!keyword) {
    return res.status(400).json({ error: '请输入搜索关键词' });
  }
  if (server !== 'netease') {
    return res.status(400).json({ error: '暂只支持网易云音乐搜索' });
  }
  try {
    const result = await searchMusic(keyword);
    res.json(result.items);
  } catch (err) {
    console.error('音乐搜索失败', err && err.message);
    res.status(502).json({ error: err.message || '音乐搜索服务不可用' });
  }
});

app.get('/api/music/recommend', async (req, res) => {
  const day = Math.floor((Date.now() + 8 * 3600 * 1000) / 86400000);
  // 后台配置了「每日推荐歌单」就按天轮换配置的列表，否则回落到内置榜单
  const configured = String(S().dailyRecommendPlaylist || '').split(/[\s,，]+/).filter(Boolean);
  const playlistId = configured.length
    ? configured[day % configured.length]
    : (process.env.MUSIC_RECOMMEND_PLAYLIST || NETEASE_PLAYLISTS[day % NETEASE_PLAYLISTS.length].id);
  try {
    const { data } = await axios.get(NETEASE_PLAYLIST_API, {
      params: { id: playlistId },
      headers: { 'User-Agent': NETEASE_UA, 'Referer': NETEASE_REFERER },
      timeout: 12000
    });
    const playlist = data && (data.playlist || (data.result && data.result.playlist));
    const tracks = (playlist && playlist.tracks) || [];
    res.json(tracks.slice(0, 20).map((item) => ({
      id: String(item.id || ''),
      title: item.name || '未知歌曲',
      author: neteaseSongAuthor(item),
      url: '',
      pic: httpsify((item.album && item.album.picUrl) || (item.al && item.al.picUrl)),
      duration: Math.round((item.duration || item.dt || 0) / 1000),
      lrc: ''
    })).filter((song) => !isSongBanned(song)));
  } catch (err) {
    console.error('获取今日推荐失败', err && err.message);
    res.status(502).json({ error: '获取今日推荐失败' });
  }
});

// 已验证可播放的歌曲缓存：同一个人反复点同一首歌、或房间里几个人同时点同一首，
// 就不用每次都去探一次网易云，点歌也会快很多。
const AUDIO_OK_TTL = 5 * 60 * 1000;
const AUDIO_OK_MAX = 500;
const audioOkCache = new Map();

function markAudioOk(id) {
  const now = Date.now();
  if (audioOkCache.size >= AUDIO_OK_MAX) {
    for (const [key, exp] of audioOkCache) {
      if (exp <= now) audioOkCache.delete(key);
    }
    if (audioOkCache.size >= AUDIO_OK_MAX) {
      const first = audioOkCache.keys().next();
      if (!first.done) audioOkCache.delete(first.value);
    }
  }
  audioOkCache.set(id, now + AUDIO_OK_TTL);
}

/**
 * 判断一首歌能不能播。
 *
 * 一定要用「和真正播放完全一致」的链路（proxyRequest → /api/music/stream）来探，
 * 不要另起一套 axios 请求：之前就是拿 axios 单独去试 CDN，结果那个请求会莫名
 * 被 CDN 回 403（进程跑久了尤其容易踩），而播放链路本身是通的，
 * 于是明明能播的歌也报「获取音乐地址失败」。
 * 现在两边同一条链路，验证通过就等于一定能播。
 */
function probeAudio(id) {
  return new Promise((resolve) => {
    const headers = {
      'User-Agent': NETEASE_UA,
      'Referer': NETEASE_REFERER,
      'Accept': '*/*',
      'Range': 'bytes=0-1'
    };
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => finish({ ok: false, status: 502, error: '音乐服务响应超时，请稍后重试' }), 12000);

    proxyRequest(neteasePlayUrl(id), headers, 0, (err, upstreamRes) => {
      if (err) {
        clearTimeout(timer);
        return finish({ ok: false, status: 502, error: '音乐服务连接失败，请稍后重试' });
      }
      const status = upstreamRes.statusCode || 0;
      const type = String(upstreamRes.headers['content-type'] || '');
      // 只要响应头就够了，正文直接丢掉，别真把整首歌下载下来
      upstreamRes.resume();
      clearTimeout(timer);
      if (status >= 400 || !/audio|octet-stream/i.test(type)) {
        return finish({ ok: false, status: 404, error: '这首歌暂时无法播放（可能是 VIP / 版权限制），换一首试试' });
      }
      finish({ ok: true });
    });
  });
}

app.get('/api/music/url', async (req, res) => {
  const id = String(req.query.id || '').trim();
  const server = String(req.query.server || 'netease').trim();
  if (!id) {
    return res.status(400).json({ error: '缺少歌曲 ID' });
  }
  if (isSongBanned({ id })) {
    return res.status(403).json({ error: '这首歌已被管理员禁播' });
  }
  if (server !== 'netease') {
    return res.status(400).json({ error: '暂只支持网易云音乐' });
  }

  // 返回相对地址：房主可能是用 localhost / 局域网 IP / 公网域名打开页面的，
  // 一旦把「带域名的绝对地址」存进队列，别人（尤其手机）拿到的就是房主那台机器的地址，
  // 手机里的 localhost 指的就是手机自己，必然播不出来。相对地址由各端按自己的访问地址补全。
  const streamUrl = `/api/music/stream?id=${encodeURIComponent(id)}`;
  const cachedUntil = audioOkCache.get(id);
  if (cachedUntil && cachedUntil > Date.now()) {
    return res.json({ url: streamUrl, id, cached: true });
  }

  const probe = await probeAudio(id);
  if (!probe.ok) {
    console.warn(`点歌失败 id=${id} → ${probe.error}`);
    return res.status(probe.status || 404).json({ error: probe.error });
  }
  markAudioOk(id);
  res.json({ url: streamUrl, id });
});

// ---------- 歌词 ----------
// 网易云歌词接口 / Meting(type=lrc) 二选一，带 6 小时内存缓存，避免同房间反复拉取
const LYRIC_TTL = 6 * 3600 * 1000;
const lyricCache = new Map();

async function fetchNeteaseLyric(id) {
  const { data } = await axios.get(NETEASE_LYRIC_API, {
    params: { id, lv: -1, kv: -1, tv: -1 },
    headers: { 'User-Agent': NETEASE_UA, 'Referer': NETEASE_REFERER },
    timeout: 12000
  });
  return (data && data.lrc && data.lrc.lyric) || '';
}

async function fetchMetingLyric(id, endpoint) {
  const url = endpoint + (endpoint.includes('?') ? '&' : '?')
    + 'server=netease&type=lrc&id=' + encodeURIComponent(id);
  const { data } = await axios.get(url, { timeout: 12000, headers: { 'User-Agent': NETEASE_UA } });
  if (typeof data === 'string') return data;
  if (data && typeof data.lyric === 'string') return data.lyric;
  if (data && data.lrc && typeof data.lrc.lyric === 'string') return data.lrc.lyric;
  return '';
}

app.get('/api/music/lyric', async (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) {
    return res.status(400).json({ error: '缺少歌曲 ID' });
  }
  if (isSongBanned({ id })) {
    return res.status(403).json({ error: '这首歌已被管理员禁播' });
  }
  const hit = lyricCache.get(id);
  if (hit && Date.now() - hit.at < LYRIC_TTL) {
    return res.json({ id, lyric: hit.lyric, cached: true });
  }
  try {
    const settings = S();
    const useMeting = settings.musicSource === 'meting' && settings.metingApiUrl;
    const lyric = useMeting
      ? await fetchMetingLyric(id, settings.metingApiUrl)
      : await fetchNeteaseLyric(id);
    if (lyricCache.size > 500) lyricCache.clear();
    lyricCache.set(id, { at: Date.now(), lyric });
    res.json({ id, lyric });
  } catch (err) {
    console.error('获取歌词失败', err && err.message);
    res.status(502).json({ error: '歌词获取失败，请稍后重试' });
  }
});

app.get('/api/music/pic', (req, res) => {
  const url = String(req.query.url || '').trim();
  if (!url) {
    return res.status(400).json({ error: '缺少图片地址' });
  }
  if (!isAllowedMusicImage(url)) {
    return res.status(400).json({ error: '不支持的图片地址' });
  }
  const headers = {
    'User-Agent': NETEASE_UA,
    'Referer': NETEASE_REFERER,
    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8'
  };
  proxyRequest(url, headers, 0, (err, upstreamRes) => {
    if (err) {
      return res.status(502).json({ error: '封面加载失败' });
    }
    sendUpstream(res, upstreamRes);
    upstreamRes.pipe(res);
  });
});

app.get('/api/music/stream', (req, res) => {
  const id = String(req.query.id || '').trim();
  if (!id) {
    return res.status(400).json({ error: '缺少歌曲 ID' });
  }
  if (isSongBanned({ id })) {
    return res.status(403).json({ error: '这首歌已被管理员禁播' });
  }
  const headers = {
    'User-Agent': NETEASE_UA,
    'Referer': NETEASE_REFERER,
    'Accept': '*/*'
  };
  if (req.headers.range) headers['Range'] = req.headers.range;

  proxyRequest(neteasePlayUrl(id), headers, 0, (err, upstreamRes) => {
    if (err) {
      return res.status(502).json({ error: '获取播放流失败' });
    }
    const status = upstreamRes.statusCode || 0;
    const type = String(upstreamRes.headers['content-type'] || '');
    // 上游 4xx/5xx 或者根本不是音频（网易云对 VIP 歌会跳到 /404 的 HTML 页面），
    // 一律回 JSON 错误，别把一段 HTML 当成音频喂给 <audio>
    if (status >= 400 || !/audio|octet-stream/i.test(type)) {
      upstreamRes.resume();
      return res.status(404).json({ error: '这首歌暂时无法播放（可能受版权限制）' });
    }
    // iOS Safari / 微信内置浏览器要看到 Accept-Ranges: bytes 才肯播放音频，
    // 否则会一直卡在加载中（电脑端的 Chrome 不挑，所以以前只有手机出问题）
    if (!res.getHeader('accept-ranges')) res.setHeader('Accept-Ranges', 'bytes');
    sendUpstream(res, upstreamRes);
    upstreamRes.pipe(res);
  });
});

// ---------- 文件上传 ----------
// 只允许媒体扩展名：避免上传 .html/.svg 后在 /uploads 下被当页面执行（存储型 XSS）
const ALLOWED_UPLOAD_EXT = new Set(['.mp4', '.webm', '.m4v', '.mov', '.ogg', '.mp3', '.m4a', '.wav', '.aac', '.flac']);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const originalExt = path.extname(file.originalname || '').toLowerCase();
    const ext = ALLOWED_UPLOAD_EXT.has(originalExt) ? originalExt : '.mp4';
    const unique = Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext;
    cb(null, unique);
  }
});

// 上传大小由后台配置决定，所以按当前配置懒创建 multer 实例（配置改了自动重建）
let uploaderCache = { limit: 0, instance: null };
function getUploader() {
  const limit = maxUploadBytes();
  if (uploaderCache.instance && uploaderCache.limit === limit) return uploaderCache.instance;
  const instance = multer({
    storage,
    limits: { fileSize: limit, files: 1 },
    fileFilter: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      if (!ALLOWED_UPLOAD_EXT.has(ext)) {
        return cb(new Error('不支持的文件类型，仅允许：' + [...ALLOWED_UPLOAD_EXT].join(' ')));
      }
      cb(null, true);
    }
  });
  uploaderCache = { limit, instance };
  return instance;
}

// 限流放宽到 40/分钟：音乐厅「导入本地音频」经常要连着传好几首，10 次太容易撞上
app.post('/api/upload', rateLimit(40), (req, res, next) => getUploader().single('file')(req, res, next), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '未收到文件' });
  }
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({
    url,
    // 相对路径：换局域网 IP / 换公网隧道后，原来的绝对地址就失效了，
    // 前端存这个，用的时候再按当前访问地址补全（音乐厅「导入本地音频」走这条路）
    path: `/uploads/${req.file.filename}`,
    name: req.file.originalname,
    filename: req.file.filename,
    size: req.file.size,
    mimetype: req.file.mimetype
  });
});

// ---------- B站解析 ----------
app.post('/api/bilibili/resolve', rateLimit(30), async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: '请传入 B 站视频链接' });
    }
    if (!S().bilibiliResolveEnabled) {
      return res.status(403).json({ error: 'B 站解析功能已被管理员关闭' });
    }
    const data = await resolveBilibili(url);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || '解析失败' });
  }
});

// ---------- 通用视频解析（任意网址：直链 / 网页 / 平台嵌入） ----------
app.post('/api/video/resolve', rateLimit(40), async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) {
      return res.status(400).json({ error: '请粘贴视频链接' });
    }
    if (!S().bilibiliResolveEnabled) {
      return res.status(403).json({ error: '视频解析功能已被管理员关闭' });
    }
    const data = await resolveAny(url);
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message || '解析失败' });
  }
});

// ---------- 通用媒体代理（任意站点的视频 / m3u8 分片） ----------
app.get('/api/vproxy', ...mediaProxy.createHandler({ rateLimit }));

// ---------- 后端代理播放（解决 B 站防盗链 403） ----------
const MAX_REDIRECTS = 5;

// 只允许代理 B 站媒体域名，避免变成“任意 URL 代理”（SSRF / 内网探测 / 流量盗用）
const BILI_MEDIA_HOST_RE = /(^|\.)(bilivideo\.(com|cn)|bilibili\.com|hdslb\.com|biliapi\.net|akamaized\.net|szbdyd\.com)$/i;
const NETEASE_IMAGE_HOST_RE = /(^|\.)(126\.net|127\.net|music\.163\.com)$/i;

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 0 || a === 10 || a === 127
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254);
}

function isAllowedProxyTarget(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (isPrivateHost(parsed.hostname)) return false;
  return BILI_MEDIA_HOST_RE.test(parsed.hostname);
}

function isAllowedMusicImage(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (isPrivateHost(parsed.hostname)) return false;
  return NETEASE_IMAGE_HOST_RE.test(parsed.hostname);
}

// 只回传媒体相关的响应头，避免把上游 set-cookie 等原样透传
const SAFE_UPSTREAM_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges',
  'last-modified', 'etag', 'cache-control', 'expires'
];
function sendUpstream(res, upstreamRes) {
  for (const key of SAFE_UPSTREAM_HEADERS) {
    const value = upstreamRes.headers[key];
    if (value !== undefined) res.setHeader(key, value);
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.writeHead(upstreamRes.statusCode || 200);
}

function proxyRequest(targetUrl, headers, redirectCount, callback) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (err) {
    return callback(new Error('无效的播放地址'));
  }

  const lib = parsed.protocol === 'https:' ? https : http;
  const req = lib.request(
    parsed,
    {
      method: 'GET',
      headers
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode || 0;
      const location = upstreamRes.headers.location;

      if ([301, 302, 303, 307, 308].includes(status) && location) {
        upstreamRes.resume();
        if (redirectCount >= MAX_REDIRECTS) {
          return callback(new Error('代理重定向次数过多'));
        }
        const nextUrl = new URL(location, targetUrl).toString();
        return proxyRequest(nextUrl, headers, redirectCount + 1, callback);
      }

      callback(null, upstreamRes);
    }
  );

  req.on('error', (err) => callback(err));
  req.end();
}

app.get('/api/proxy', rateLimit(120), (req, res) => {
  const targetUrl = String(req.query.url || '');
  if (!targetUrl) {
    return res.status(400).json({ error: '缺少 url 参数' });
  }
  if (!isAllowedProxyTarget(targetUrl)) {
    return res.status(403).json({ error: '只允许代理 B 站视频地址' });
  }

  const headers = {
    'User-Agent': UA,
    'Referer': REFERER,
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  };
  if (req.headers.range) {
    headers['Range'] = req.headers.range;
  }

  proxyRequest(targetUrl, headers, 0, (err, upstreamRes) => {
    if (err) {
      return res.status(502).json({ error: '代理播放失败：' + err.message });
    }

    sendUpstream(res, upstreamRes);
    upstreamRes.pipe(res);
  });
});

// ---------- 站点公开信息（公告 / 维护状态 / 限额，前端可选接入） ----------
app.get('/api/site-info', (req, res) => {
  const settings = S();
  res.json({
    siteName: settings.siteName,
    announcement: db.activeAnnouncement(),
    banner: settings.announcementBanner,
    maintenance: { enabled: settings.maintenanceMode, message: settings.maintenanceMessage },
    limits: {
      maxUploadMB: settings.maxUploadMB,
      roomMaxMembers: settings.roomMaxMembers,
      bilibiliResolveEnabled: settings.bilibiliResolveEnabled,
      allowMemberControlPlayback: settings.allowMemberControlPlayback
    }
  });
});

// ---------- Socket.IO 房间 ----------
const rooms = new Map();

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function createRoom(video, socketId) {
  let roomId;
  do {
    roomId = generateRoomCode();
  } while (rooms.has(roomId));

  const room = {
    id: roomId,
    video: video || null,
    host: socketId,
    // 当前掌管播放的人：默认房主，任何人换片后就接管（房主身份不变）
    controller: socketId,
    members: new Set([socketId]),
    // 已经 canplay 的成员；房主点播放时等这些人加载好再统一起播
    videoReady: new Set(),
    videoWait: null,
    videoWaitTimer: null,
    state: {
      playing: false,
      time: 0,
      rate: 1,
      // 这份状态是什么时候定下的（服务器毫秒），客户端据此推算实时进度
      at: Date.now()
    },
    createdAt: Date.now(),
    lastActiveAt: Date.now()
  };
  rooms.set(roomId, room);
  return room;
}

function serializeRoom(room) {
  return {
    id: room.id,
    video: room.video,
    hostId: room.host,
    controllerId: room.controller || room.host,
    state: room.state,
    memberCount: room.members.size
  };
}

// 房主点播放后等观众 canplay，最多等 8 秒；等不到就按时开播，避免永远卡住
const VIDEO_WAIT_MS = 8000;

function clearVideoWait(room) {
  if (room.videoWaitTimer) {
    clearTimeout(room.videoWaitTimer);
    room.videoWaitTimer = null;
  }
  room.videoWait = null;
}

function videoWaitCounts(room) {
  const by = room.videoWait ? room.videoWait.by : '';
  let total = 0;
  let ready = 0;
  for (const id of room.members) {
    if (id === by) continue;
    total += 1;
    if (room.videoReady.has(id)) ready += 1;
  }
  return { total, ready };
}

function videoWaitSatisfied(room) {
  const { total, ready } = videoWaitCounts(room);
  return total === 0 || ready >= total;
}

function startVideoPlay(room, time) {
  clearVideoWait(room);
  const t = Math.max(0, Number(time) || 0);
  const at = Date.now() + 700;
  room.state = {
    playing: true,
    time: t,
    rate: Number(room.state && room.state.rate) || 1,
    at
  };
  io.to(room.id).emit('video-start', { time: t, rate: room.state.rate, at });
}

function beginVideoWait(room, by, time) {
  clearVideoWait(room);
  room.videoWait = { by, time: Math.max(0, Number(time) || 0) };
  const counts = videoWaitCounts(room);
  io.to(room.id).emit('video-waiting', { ...counts, by });
  room.videoWaitTimer = setTimeout(() => {
    if (!room.videoWait) return;
    const t = room.videoWait.time;
    startVideoPlay(room, t);
  }, VIDEO_WAIT_MS);
}

function maybeStartWaitedVideo(room) {
  if (!room.videoWait || !videoWaitSatisfied(room)) return false;
  startVideoPlay(room, room.videoWait.time);
  return true;
}

/** 谁在掌控播放（换片的人，默认房主） */
function isRoomController(room, socketId) {
  return (room.controller || room.host) === socketId;
}

/** 把播放控制权交给某人，并通知全房 */
function setRoomController(room, socketId) {
  if (!socketId || !room.members.has(socketId)) return;
  if ((room.controller || room.host) === socketId) return;
  room.controller = socketId;
  io.to(room.id).emit('controller-changed', { controllerId: socketId });
}

/** 记录房间活跃时间（供「空闲自动销毁」判断） */
function touchRoom(room) {
  if (room) room.lastActiveAt = Date.now();
}

/** 把某个 socket 移出视频房间；房间空了自动删除。返回房间是否已被关闭 */
function removeVideoMember(room, socketId) {
  if (!room.members.has(socketId)) return room.members.size === 0;
  room.members.delete(socketId);
  room.videoReady.delete(socketId);
  if (room.members.size === 0) {
    rooms.delete(room.id);
    return true;
  }
  if (room.videoWait) maybeStartWaitedVideo(room);
  if (room.host === socketId) {
    const nextHost = [...room.members][0];
    room.host = nextHost;
    io.to(room.id).emit('host-changed', { hostId: nextHost });
  }
  // 掌控播放的人走了，控制权回到房主，免的全房停在那不动
  if ((room.controller || room.host) === socketId) {
    room.controller = room.host;
    io.to(room.id).emit('controller-changed', { controllerId: room.host });
  }
  io.to(room.id).emit('member-updated', { count: room.members.size });
  return false;
}

// ---------- 五子棋房间 ----------
const gomokuRooms = new Map();

const BOARD_SIZE = 15;

function createEmptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null));
}

const GOMOKU_TURN_SECONDS = 30;

function otherGomokuColor(color) {
  return color === 'black' ? 'white' : 'black';
}

function generateGomokuRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (gomokuRooms.has(code));
  return code;
}

function createGomokuRoom(socketId) {
  const room = {
    id: generateGomokuRoomCode(),
    host: socketId,
    players: new Map(), // color -> socketId
    members: new Set([socketId]),
    board: createEmptyBoard(),
    currentTurn: 'black',
    winner: null,
    winLine: [],
    lastMove: null,
    history: [],
    turnSeconds: GOMOKU_TURN_SECONDS,
    turnStartedAt: Date.now(),
    turnTimer: null,
    createdAt: Date.now(),
    lastActiveAt: Date.now()
  };
  room.players.set('black', socketId);
  gomokuRooms.set(room.id, room);
  return room;
}

function serializeGomokuRoom(room) {
  return {
    id: room.id,
    hostId: room.host,
    memberCount: room.members.size,
    board: room.board,
    currentTurn: room.currentTurn,
    winner: room.winner,
    winLine: room.winLine,
    lastMove: room.lastMove,
    turnSeconds: room.turnSeconds,
    turnStartedAt: room.turnStartedAt
  };
}

function getGomokuColor(room, socketId) {
  for (const [color, id] of room.players.entries()) {
    if (id === socketId) return color;
  }
  return '';
}

function checkGomokuWin(board, row, col, color) {
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dr, dc] of directions) {
    const line = [[row, col]];
    for (let step = 1; step < 5; step++) {
      const r = row + dr * step;
      const c = col + dc * step;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE || board[r][c] !== color) break;
      line.push([r, c]);
    }
    for (let step = 1; step < 5; step++) {
      const r = row - dr * step;
      const c = col - dc * step;
      if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE || board[r][c] !== color) break;
      line.unshift([r, c]);
    }
    if (line.length >= 5) {
      return line;
    }
  }
  return null;
}


function clearGomokuTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
}

function startGomokuTurnTimer(room) {
  clearGomokuTimer(room);
  if (room.winner || room.players.size < 2) return;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.winner || room.players.size < 2) return;
    room.winner = otherGomokuColor(room.currentTurn);
    room.winLine = [];
    broadcastGomokuRoom(room);
  }, GOMOKU_TURN_SECONDS * 1000);
}

function resetGomokuGame(room, swapColors) {
  clearGomokuTimer(room);
  if (swapColors && room.players.size === 2) {
    const blackId = room.players.get('black');
    const whiteId = room.players.get('white');
    room.players.set('black', whiteId);
    room.players.set('white', blackId);
  }
  room.board = createEmptyBoard();
  room.currentTurn = 'black';
  room.winner = null;
  room.winLine = [];
  room.lastMove = null;
  room.history = [];
  room.turnStartedAt = Date.now();
  startGomokuTurnTimer(room);
}

function broadcastGomokuRoom(room) {
  const payload = { room: serializeGomokuRoom(room) };
  for (const socketId of room.members) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit('gomoku-room-state', {
      ...payload,
      isHost: room.host === socketId,
      color: getGomokuColor(room, socketId)
    });
  }
}

function gomokuPlayerLeft(room, socketId) {
  room.members.delete(socketId);
  if (room.players.get('black') === socketId) room.players.delete('black');
  if (room.players.get('white') === socketId) room.players.delete('white');

  if (room.members.size === 0) {
    clearGomokuTimer(room);
    gomokuRooms.delete(room.id);
    return;
  }

  // 房主离开时转让房主
  if (room.host === socketId) {
    room.host = [...room.members][0];
  }

  if (room.players.size < 2) clearGomokuTimer(room);

  const leftColor = getGomokuColor(room, socketId); // after deletion likely ''
  io.to(room.id).emit('gomoku-player-left', { message: '对方已离开，等待重新加入或重新开局' });
  broadcastGomokuRoom(room);
}

// ---------- 斗地主房间 ----------
const ddzRooms = new Map();

function generateDdzRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (ddzRooms.has(code));
  return code;
}

function createDdzRoom(socketId) {
  const room = {
    id: generateDdzRoomCode(),
    host: socketId,
    seats: [null, null, null],
    members: new Set([socketId]),
    phase: 'waiting',
    currentPlayer: -1,
    landlordIndex: -1,
    winnerSeat: -1,
    lastPlay: null,
    passCount: 0,
    bottomCards: [],
    statusText: '',
    bidding: {
      current: 0,
      hasBid: false,
      lastBidder: -1,
      acted: [false, false, false]
    },
    createdAt: Date.now(),
    lastActiveAt: Date.now()
  };
  room.seats[0] = {
    socketId,
    name: '玩家1',
    hand: [],
    isLandlord: false
  };
  ddzRooms.set(room.id, room);
  return room;
}

function getDdzSeat(room, socketId) {
  for (let i = 0; i < room.seats.length; i++) {
    if (room.seats[i] && room.seats[i].socketId === socketId) return i;
  }
  return -1;
}

function ddzSeatName(room, seat) {
  if (seat >= 0 && seat < room.seats.length && room.seats[seat]) {
    return room.seats[seat].name;
  }
  return '玩家';
}

function serializeDdzRoom(room) {
  return {
    id: room.id,
    phase: room.phase,
    statusText: room.statusText || '',
    currentPlayer: room.currentPlayer,
    landlordIndex: room.landlordIndex,
    winnerSeat: room.winnerSeat,
    bottomCards: (room.phase === 'bidding' || room.phase === 'waiting') ? [] : room.bottomCards,
    lastPlay: room.lastPlay ? {
      player: room.lastPlay.seat,
      cards: room.lastPlay.cards,
      type: room.lastPlay.type,
      rank: room.lastPlay.rank,
      length: room.lastPlay.length
    } : null,
    bidding: room.bidding,
    players: room.seats.map((p) => {
      if (!p) return null;
      return {
        name: p.name,
        cardCount: p.hand.length,
        isLandlord: p.isLandlord,
        isHost: p.socketId === room.host
      };
    })
  };
}

function emitDdzRoomState(room, socketId) {
  const sock = io.sockets.sockets.get(socketId);
  if (!sock) return;
  const seat = getDdzSeat(room, socketId);
  sock.emit('ddz-room-state', {
    room: serializeDdzRoom(room),
    you: seat >= 0 ? { index: seat, hand: room.seats[seat].hand.slice() } : null,
    isHost: room.host === socketId
  });
}

function broadcastDdzRoom(room) {
  for (const socketId of room.members) {
    emitDdzRoomState(room, socketId);
  }
}

function startDdzBidding(room, message) {
  room.seats.forEach((p) => {
    if (p) {
      p.hand = [];
      p.isLandlord = false;
    }
  });
  const deck = ddz.shuffle(ddz.createDeck());
  for (let i = 0; i < 51; i++) {
    const seat = i % 3;
    if (room.seats[seat]) room.seats[seat].hand.push(deck[i]);
  }
  room.bottomCards = deck.slice(51, 54);
  room.seats.forEach((p) => {
    if (p) ddz.sortHand(p.hand);
  });

  room.phase = 'bidding';
  room.landlordIndex = -1;
  room.winnerSeat = -1;
  room.lastPlay = null;
  room.passCount = 0;
  room.bidding = {
    current: Math.floor(Math.random() * 3),
    hasBid: false,
    lastBidder: -1,
    acted: [false, false, false]
  };
  room.currentPlayer = room.bidding.current;
  room.statusText = message || `轮到 ${ddzSeatName(room, room.bidding.current)} 叫地主`;
}

function startDdzPlaying(room, landlordIndex) {
  room.landlordIndex = landlordIndex;
  if (room.seats[landlordIndex]) {
    room.seats[landlordIndex].isLandlord = true;
    room.seats[landlordIndex].hand.push(...room.bottomCards);
    ddz.sortHand(room.seats[landlordIndex].hand);
  }
  room.phase = 'playing';
  room.currentPlayer = landlordIndex;
  room.lastPlay = null;
  room.passCount = 0;
  room.winnerSeat = -1;
  room.statusText = `${ddzSeatName(room, landlordIndex)} 成为地主，获得底牌，先出牌`;
}

function resetDdzRoomToWaiting(room, message) {
  room.phase = 'waiting';
  room.currentPlayer = -1;
  room.landlordIndex = -1;
  room.winnerSeat = -1;
  room.lastPlay = null;
  room.passCount = 0;
  room.bottomCards = [];
  room.bidding = {
    current: 0,
    hasBid: false,
    lastBidder: -1,
    acted: [false, false, false]
  };
  room.seats.forEach((p) => {
    if (p) {
      p.hand = [];
      p.isLandlord = false;
    }
  });
  room.statusText = message || '等待玩家加入...';
}

function ddzPlayerLeft(room, socketId) {
  const seat = getDdzSeat(room, socketId);
  room.members.delete(socketId);
  if (seat >= 0) room.seats[seat] = null;

  if (room.members.size === 0) {
    ddzRooms.delete(room.id);
    return;
  }

  if (room.host === socketId) {
    room.host = [...room.members][0];
  }

  const message = '有玩家离开，房间已重置，等待重新加入';
  if (room.phase !== 'waiting') {
    resetDdzRoomToWaiting(room, message);
  }
  io.to(room.id).emit('ddz-player-left', { message });
  broadcastDdzRoom(room);
}


// ---------- 音乐房间 ----------
const musicRooms = new Map();

function generateMusicRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
  } while (musicRooms.has(code));
  return code;
}

// 预约开播的提前量：给客户端留出「定位 + 缓冲 + 静音起跑」的时间。
// 太短会来不及准备，太长会让人觉得按了播放没反应。
// 开播提前量：给慢设备留出「静音起跑来预热缓冲」的时间。
// 太短（0.9s）时手机往往还没缓冲到位置就到点了，只能硬跳，出声反而晚。
const MUSIC_START_LEAD_MS = 1800;
// 等别人准备好最多等多久：朋友一直不点，也不能把房主卡死在「等待中」
const MUSIC_READY_TIMEOUT_MS = 15000;

function createMusicRoom(socketId) {
  const room = {
    id: generateMusicRoomCode(),
    host: socketId,
    members: new Set([socketId]),
    // 已经点过「准备一起听」的成员。手机浏览器不给声音，必须先有这一次点击
    ready: new Set(),
    // 成员真正可以播放（canplay）的集合，用于「等手机缓冲好再一起开播」
    buffered: new Set(),
    // 房主已按播放、正在等其他人加载好
    waiting: false,
    waitTimer: null,
    // 预约开播时刻（服务器毫秒）。到这一刻两边一起响
    startAt: 0,
    // 每次重新预约自增，客户端据此判断「这是一个新的开播点」
    startSeq: 0,
    pendingTime: 0,
    queue: [],
    currentIndex: -1,
    playing: false,
    time: 0,
    seekSeq: 0,
    // time 是在这一刻定下的（服务器毫秒），客户端据此推算实时进度
    syncedAt: Date.now(),
    createdAt: Date.now(),
    lastActiveAt: Date.now()
  };
  musicRooms.set(room.id, room);
  return room;
}

/** 房主天然算「已准备好」，其余每个成员都要单独点一次 */
function musicAllReady(room) {
  for (const id of room.members) {
    if (id === room.host) continue;
    if (!room.ready.has(id)) return false;
  }
  return true;
}

/** 此刻应该播到第几秒（time + 从 syncedAt 起流逝的时间） */
function musicCurrentPos(room) {
  const base = Number(room.time) || 0;
  if (!room.playing) return base;
  const at = Number(room.syncedAt) || 0;
  const elapsed = Math.max(0, (Date.now() - at) / 1000);
  return base + elapsed;
}

/** 已点准备的人里，是否都已经真正 canplay（房主天然算） */
function musicAllReadyBuffered(room) {
  for (const id of room.members) {
    if (id === room.host) continue;
    if (!room.ready.has(id)) continue;
    if (!room.buffered.has(id)) return false;
  }
  return true;
}
function clearMusicWait(room) {
  if (room.waitTimer) {
    clearTimeout(room.waitTimer);
    room.waitTimer = null;
  }
}

/**
 * 定一个统一的开播时刻：所有人在同一毫秒开始，而不是各自去追。
 * positionAtStart = 到达 startAt 那一刻应该播到的位置。
 */
function musicScheduleStart(room, positionAtStart) {
  clearMusicWait(room);
  const now = Date.now();
  room.waiting = false;
  room.startAt = now + MUSIC_START_LEAD_MS;
  room.time = Math.max(0, Number(positionAtStart) || 0);
  room.syncedAt = room.startAt;
  room.playing = true;
  room.startSeq = (room.startSeq || 0) + 1;
  room.lastActiveAt = now;
  return room.startAt;
}

/**
 * 房主按播放：先不发车，等房间里每个人都说「我加载好了」。
 * 都好了就定一个统一的开播时刻；有人没好就挂着等（超时兜底）。
 */
function musicRequestStart(room, time) {
  clearMusicWait(room);
  room.pendingTime = Math.max(0, Number(time) || 0);
  room.playing = false;
  room.time = room.pendingTime;
  room.syncedAt = Date.now();
  room.startAt = 0;

  // 已点「准备」的人如果还没 canplay，最多等 4 秒再开播。
  // 只等真正点了准备的人，不会回到以前「没人点就干等 15 秒」。
  if (musicAllReadyBuffered(room)) {
    room.waiting = false;
    return musicScheduleStart(room, room.pendingTime);
  }

  room.waiting = true;
  room.waitTimer = setTimeout(() => {
    room.waitTimer = null;
    if (!musicRooms.has(room.id) || !room.waiting) return;
    room.waiting = false;
    musicScheduleStart(room, room.pendingTime);
    broadcastMusicRoom(room);
  }, 5000);
  return 0;
}
function serializeMusicRoom(room, socketId) {
  return {
    id: room.id,
    hostId: room.host,
    memberCount: room.members.size,
    queue: room.queue,
    currentIndex: room.currentIndex,
    playing: room.playing,
    time: room.time,
    syncedAt: room.syncedAt || 0,
    seekSeq: room.seekSeq || 0,
    // 预约开播：客户端看到 startAt 在未来，就掐着点一起响
    startAt: room.waiting ? 0 : (room.startAt || 0),
    startSeq: room.startSeq || 0,
    // 房主已按播放，正在等别人准备好
    waiting: !!room.waiting,
    readyCount: room.ready.size + 1,
    guestCount: Math.max(0, room.members.size - 1),
    iAmReady: !!(socketId && (socketId === room.host || room.ready.has(socketId))),
    mySongCount: socketId ? room.queue.filter((s) => s.addedBy === socketId).length : 0
  };
}

/** 状态变更时刻：优先用客户端采样时的服务器时间，避免网络延迟把起点往后推 */
function musicSyncAt(payload) {
  const atClient = Number(payload && payload.atServer) || 0;
  if (atClient && Math.abs(Date.now() - atClient) < 5000) return atClient;
  return Date.now();
}

function broadcastMusicRoom(room) {
  for (const socketId of room.members) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    sock.emit('music-room-state', {
      room: serializeMusicRoom(room, socketId),
      isHost: room.host === socketId
    });
  }
}

function musicPlayerLeft(room, socketId) {
  room.members.delete(socketId);
  room.ready.delete(socketId);
  room.buffered.delete(socketId);
  if (room.members.size === 0) {
    clearMusicWait(room);
    musicRooms.delete(room.id);
    return;
  }
  if (room.host === socketId) {
    room.host = [...room.members][0];
  }
  // 走了一个人，剩下的人可能刚好都齐了 —— 别让房主一直挂在「等待中」
  if (room.waiting && musicAllReady(room)) {
    musicScheduleStart(room, room.pendingTime);
  }
  io.to(room.id).emit('music-member-updated', { count: room.members.size });
  broadcastMusicRoom(room);
}

// =====================================================================
// 后台管理：运行时状态 + 房间操作
// 实时房间仍在内存里，但每次对账都会把结果落库（见 db.syncRooms）
// =====================================================================

/** socketId -> { ip, ua, device, connectedAt, referer, lastActiveAt, rooms:Set } */
const socketMeta = new Map();

function deviceLabel(ua) {
  const s = String(ua || '');
  const os = /Windows NT 10/i.test(s) ? 'Windows'
    : /Windows/i.test(s) ? 'Windows'
    : /iPhone|iPad|iPod/i.test(s) ? 'iOS'
    : /Android/i.test(s) ? 'Android'
    : /Mac OS X/i.test(s) ? 'macOS'
    : /Linux/i.test(s) ? 'Linux'
    : '未知系统';
  const browser = /MicroMessenger/i.test(s) ? '微信'
    : /Edg\//i.test(s) ? 'Edge'
    : /Chrome\//i.test(s) ? 'Chrome'
    : /Firefox\//i.test(s) ? 'Firefox'
    : /Safari\//i.test(s) ? 'Safari'
    : /okhttp|uni-app/i.test(s) ? 'App'
    : '未知浏览器';
  return `${os} · ${browser}`;
}

function clientIp(socket) {
  const forwarded = String((socket.handshake.headers && socket.handshake.headers['x-forwarded-for']) || '').split(',')[0].trim();
  return auth.normalizeIp(forwarded || socket.handshake.address || (socket.conn && socket.conn.remoteAddress) || '');
}

function metaOf(socketId) {
  return socketMeta.get(socketId) || null;
}

function memberRow(socketId, hostSocket) {
  const meta = metaOf(socketId) || {};
  return {
    socketId,
    ip: meta.ip || '',
    device: meta.device || '',
    ua: meta.ua || '',
    connectedAt: meta.connectedAt || 0,
    isHost: socketId === hostSocket,
    online: io.sockets.sockets.has(socketId)
  };
}

function listVideoRooms() {
  return [...rooms.values()].map((room) => {
    const hostMeta = metaOf(room.host) || {};
    return {
      id: room.id,
      hostSocket: room.host,
      hostIp: hostMeta.ip || '',
      hostDevice: hostMeta.device || '',
      memberCount: room.members.size,
      createdAt: room.createdAt,
      lastActiveAt: room.lastActiveAt || room.createdAt,
      playing: !!room.state.playing,
      time: Number(room.state.time) || 0,
      rate: Number(room.state.rate) || 1,
      statusText: room.state.playing ? '播放中' : '已暂停',
      video: room.video ? {
        title: room.video.title || '',
        bvid: room.video.bvid || '',
        part: room.video.part || '',
        cover: room.video.cover || '',
        videoUrl: room.video.videoUrl || ''
      } : null,
      members: [...room.members].map((id) => memberRow(id, room.host))
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

function listGomokuRooms() {
  return [...gomokuRooms.values()].map((room) => {
    const hostMeta = metaOf(room.host) || {};
    const players = [];
    for (const [color, socketId] of room.players.entries()) {
      const meta = metaOf(socketId) || {};
      players.push({ color, socketId, ip: meta.ip || '', device: meta.device || '' });
    }
    return {
      id: room.id,
      hostSocket: room.host,
      hostIp: hostMeta.ip || '',
      hostDevice: hostMeta.device || '',
      memberCount: room.members.size,
      createdAt: room.createdAt,
      lastActiveAt: room.lastActiveAt || room.createdAt,
      players,
      currentTurn: room.currentTurn,
      winner: room.winner,
      moves: room.history.length,
      statusText: room.winner
        ? `已结束（${room.winner === 'black' ? '黑棋' : '白棋'}胜）`
        : (room.players.size < 2 ? '等待对手加入' : `对局中 · 轮到${room.currentTurn === 'black' ? '黑棋' : '白棋'}`),
      members: [...room.members].map((id) => memberRow(id, room.host))
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

function listDdzRooms() {
  return [...ddzRooms.values()].map((room) => {
    const hostMeta = metaOf(room.host) || {};
    return {
      id: room.id,
      hostSocket: room.host,
      hostIp: hostMeta.ip || '',
      hostDevice: hostMeta.device || '',
      memberCount: room.members.size,
      createdAt: room.createdAt,
      lastActiveAt: room.lastActiveAt || room.createdAt,
      phase: room.phase,
      statusText: room.statusText || '',
      currentPlayer: room.currentPlayer,
      landlordIndex: room.landlordIndex,
      seats: room.seats.map((p, index) => {
        if (!p) return { seat: index, empty: true };
        const meta = metaOf(p.socketId) || {};
        return {
          seat: index,
          empty: false,
          name: p.name,
          socketId: p.socketId,
          ip: meta.ip || '',
          cardCount: p.hand.length,
          isLandlord: !!p.isLandlord,
          isHost: p.socketId === room.host
        };
      }),
      members: [...room.members].map((id) => memberRow(id, room.host))
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

function listMusicRooms() {
  return [...musicRooms.values()].map((room) => {
    const hostMeta = metaOf(room.host) || {};
    const current = room.currentIndex >= 0 ? room.queue[room.currentIndex] : null;
    return {
      id: room.id,
      hostSocket: room.host,
      hostIp: hostMeta.ip || '',
      hostDevice: hostMeta.device || '',
      memberCount: room.members.size,
      createdAt: room.createdAt,
      lastActiveAt: room.lastActiveAt || room.createdAt,
      playing: !!room.playing,
      time: Number(room.time) || 0,
      currentIndex: room.currentIndex,
      currentSong: current ? { title: current.title, author: current.author, id: current.id } : null,
      queue: room.queue.map((song, index) => ({
        index,
        id: song.id,
        title: song.title,
        author: song.author || '',
        duration: song.duration || 0,
        pic: song.pic || '',
        addedBy: song.addedBy || '',
        addedByIp: (metaOf(song.addedBy) || {}).ip || ''
      })),
      statusText: current
        ? `${room.playing ? '播放中' : '已暂停'} · ${current.title}`
        : (room.queue.length ? '等待播放' : '队列为空'),
      members: [...room.members].map((id) => memberRow(id, room.host))
    };
  }).sort((a, b) => b.createdAt - a.createdAt);
}

const ROOM_LISTS = {
  video: listVideoRooms,
  gomoku: listGomokuRooms,
  doudizhu: listDdzRooms,
  music: listMusicRooms
};

const ROOM_MAPS = {
  video: () => rooms,
  gomoku: () => gomokuRooms,
  doudizhu: () => ddzRooms,
  music: () => musicRooms
};

const CLOSED_EVENT = {
  video: 'room-closed',
  gomoku: 'gomoku-room-closed',
  doudizhu: 'ddz-room-closed',
  music: 'music-room-closed'
};

/** 给房间里所有还活着的 socket 发个事件并让他们离开 socket.io room */
function detachRoomSockets(roomId, members, eventName, payload) {
  for (const socketId of members) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) continue;
    if (eventName) sock.emit(eventName, payload);
    sock.leave(roomId);
  }
}

const adminOps = {
  close(kind, room, reason) {
    const event = CLOSED_EVENT[kind];
    const payload = { message: reason || '房间已被管理员关闭', roomId: room.id };
    detachRoomSockets(room.id, [...room.members], event, payload);
    if (kind === 'gomoku') clearGomokuTimer(room);
    ROOM_MAPS[kind]().delete(room.id);
    db.markRoomClosed(kind, room.id, 'admin');
    db.roomEvent({ kind, roomCode: room.id, event: 'close', detail: { reason } });
  },

  kick(kind, room, socketId, opts = {}) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) throw new Error('该成员已离线，刷新列表后重试');
    if (kind === 'video' || kind === 'music') {
      if (room.host === socketId) throw new Error('房主不能直接踢出，请先转让房主或解散房间');
    }
    sock.emit('admin-kicked', { message: opts.reason || '你已被管理员移出房间', roomId: room.id });
    sock.leave(room.id);
    if (kind === 'video') {
      const closed = removeVideoMember(room, socketId);
      if (closed) db.markRoomClosed(kind, room.id, 'empty');
    } else if (kind === 'gomoku') {
      gomokuPlayerLeft(room, socketId);
    } else if (kind === 'doudizhu') {
      ddzPlayerLeft(room, socketId);
    } else if (kind === 'music') {
      musicPlayerLeft(room, socketId);
    }
  },

  transfer(kind, room, socketId, opts = {}) {
    if (!room.members.has(socketId)) throw new Error('该成员不在房间内');
    if (room.host === socketId) throw new Error('该成员已经是房主');
    room.host = socketId;
    touchRoom(room);
    if (kind === 'video') {
      io.to(room.id).emit('host-changed', { hostId: socketId });
      io.to(room.id).emit('member-updated', { count: room.members.size });
    } else if (kind === 'gomoku') {
      broadcastGomokuRoom(room);
    } else if (kind === 'doudizhu') {
      broadcastDdzRoom(room);
    } else if (kind === 'music') {
      broadcastMusicRoom(room);
    }
    db.roomEvent({ kind, roomCode: room.id, event: 'transfer', socketId, detail: { by: opts.by } });
  },

  reset(kind, room, opts = {}) {
    touchRoom(room);
    if (kind === 'video') {
      room.state = { playing: false, time: 0, rate: 1, at: Date.now() };
      io.to(room.id).emit('video-updated', { video: room.video, state: room.state });
      io.to(room.id).emit('host-control', { action: 'pause', time: 0, rate: 1, from: 'admin' });
    } else if (kind === 'gomoku') {
      resetGomokuGame(room, false);
      io.to(room.id).emit('gomoku-restart', {
        roomId: room.id,
        board: room.board,
        currentTurn: room.currentTurn,
        winner: null,
        winLine: [],
        lastMove: null,
        turnSeconds: room.turnSeconds,
        turnStartedAt: room.turnStartedAt,
        playersSwapped: false,
        byAdmin: true
      });
      broadcastGomokuRoom(room);
    } else if (kind === 'doudizhu') {
      resetDdzRoomToWaiting(room, '管理员重置了对局，等待重新开局');
      broadcastDdzRoom(room);
    } else if (kind === 'music') {
      room.playing = false;
      room.time = 0;
      room.currentIndex = room.queue.length ? 0 : -1;
      broadcastMusicRoom(room);
    }
    db.roomEvent({ kind, roomCode: room.id, event: 'reset', detail: { by: opts.by } });
  },

  clearQueue(kind, room, opts = {}) {
    if (kind !== 'music') throw new Error('只有音乐房间有播放队列');
    room.queue = [];
    room.currentIndex = -1;
    room.playing = false;
    room.time = 0;
    touchRoom(room);
    broadcastMusicRoom(room);
    db.roomEvent({ kind, roomCode: room.id, event: 'clear_queue', detail: { by: opts.by } });
  },

  removeSong(kind, room, index, opts = {}) {
    if (kind !== 'music') throw new Error('只有音乐房间有播放队列');
    if (!Number.isInteger(index) || index < 0 || index >= room.queue.length) throw new Error('队列索引无效');
    const [removed] = room.queue.splice(index, 1);
    if (room.currentIndex >= room.queue.length) room.currentIndex = room.queue.length - 1;
    if (!room.queue.length) {
      room.currentIndex = -1;
      room.playing = false;
      room.time = 0;
    }
    touchRoom(room);
    broadcastMusicRoom(room);
    db.roomEvent({ kind, roomCode: room.id, event: 'remove_song', detail: { title: removed && removed.title, by: opts.by } });
  },

  playIndex(kind, room, index, opts = {}) {
    if (kind !== 'music') throw new Error('只有音乐房间可以切歌');
    if (!Number.isInteger(index) || index < 0 || index >= room.queue.length) throw new Error('队列索引无效');
    room.currentIndex = index;
    room.playing = true;
    room.time = 0;
    touchRoom(room);
    broadcastMusicRoom(room);
    db.roomEvent({
      kind,
      roomCode: room.id,
      event: 'force_play',
      detail: { title: room.queue[index] && room.queue[index].title, by: opts.by }
    });
  },

  nextSong(kind, room, opts = {}) {
    if (kind !== 'music') throw new Error('只有音乐房间可以切歌');
    if (!room.queue.length) throw new Error('播放队列是空的');
    room.currentIndex = (room.currentIndex + 1) % room.queue.length;
    room.playing = true;
    room.time = 0;
    touchRoom(room);
    broadcastMusicRoom(room);
    db.roomEvent({ kind, roomCode: room.id, event: 'force_next', detail: { by: opts.by } });
  },

  kickConnection(socketId, reason) {
    const sock = io.sockets.sockets.get(socketId);
    if (!sock) return false;
    sock.emit('admin-kicked', { message: reason || '你已被管理员强制下线' });
    setTimeout(() => sock.disconnect(true), 50);
    return true;
  },

  testMusicSearch: (keyword) => searchMusic(keyword)
};

/** 内存房间 -> 落库用的精简快照 */
function liveRoomSnapshots() {
  const rows = [];
  for (const room of rooms.values()) {
    const meta = metaOf(room.host) || {};
    rows.push({
      kind: 'video',
      code: room.id,
      hostSocket: room.host,
      hostIp: meta.ip,
      hostUa: meta.ua,
      memberCount: room.members.size,
      createdAt: room.createdAt,
      meta: {
        video: room.video ? { title: room.video.title || '', bvid: room.video.bvid || '' } : null,
        playing: !!room.state.playing
      }
    });
  }
  for (const room of gomokuRooms.values()) {
    const meta = metaOf(room.host) || {};
    rows.push({
      kind: 'gomoku',
      code: room.id,
      hostSocket: room.host,
      hostIp: meta.ip,
      hostUa: meta.ua,
      memberCount: room.members.size,
      createdAt: room.createdAt,
      meta: { players: room.players.size, moves: room.history.length, winner: room.winner }
    });
  }
  for (const room of ddzRooms.values()) {
    const meta = metaOf(room.host) || {};
    rows.push({
      kind: 'doudizhu',
      code: room.id,
      hostSocket: room.host,
      hostIp: meta.ip,
      hostUa: meta.ua,
      memberCount: room.members.size,
      createdAt: room.createdAt,
      meta: { phase: room.phase, status: room.statusText }
    });
  }
  for (const room of musicRooms.values()) {
    const meta = metaOf(room.host) || {};
    const current = room.currentIndex >= 0 ? room.queue[room.currentIndex] : null;
    rows.push({
      kind: 'music',
      code: room.id,
      hostSocket: room.host,
      hostIp: meta.ip,
      hostUa: meta.ua,
      memberCount: room.members.size,
      createdAt: room.createdAt,
      meta: {
        queue: room.queue.length,
        current: current ? current.title : '',
        playing: !!room.playing
      }
    });
  }
  return rows;
}

/** 清掉已经不存在的 socket 成员（异常断开时 Socket.IO 偶尔会漏） */
function pruneGhostMembers() {
  const alive = (id) => io.sockets.sockets.has(id);
  for (const room of [...rooms.values()]) {
    for (const id of [...room.members]) {
      if (!alive(id)) {
        rooms.get(room.id) && removeVideoMember(room, id);
      }
    }
  }
  for (const room of [...gomokuRooms.values()]) {
    for (const id of [...room.members]) {
      if (!alive(id)) gomokuPlayerLeft(room, id);
    }
  }
  for (const room of [...ddzRooms.values()]) {
    for (const id of [...room.members]) {
      if (!alive(id)) ddzPlayerLeft(room, id);
    }
  }
  for (const room of [...musicRooms.values()]) {
    for (const id of [...room.members]) {
      if (!alive(id)) musicPlayerLeft(room, id);
    }
  }
}

/** 空闲超过配置时长的房间自动销毁 */
function idleDestroySweep() {
  const minutes = S().roomIdleDestroyMinutes;
  if (!minutes) return 0;
  const deadline = Date.now() - minutes * 60000;
  const idleRooms = [];
  for (const kind of Object.keys(ROOM_MAPS)) {
    for (const room of [...ROOM_MAPS[kind]().values()]) {
      const last = room.lastActiveAt || room.createdAt;
      if (last < deadline) idleRooms.push({ kind, room });
    }
  }
  for (const { kind, room } of idleRooms) {
    adminOps.close(kind, room, `房间空闲超过 ${minutes} 分钟，已自动销毁`);
    db.roomEvent({ kind, roomCode: room.id, event: 'idle_destroy', detail: { minutes } });
  }
  return idleRooms.length;
}

// 每 10 秒对账一次：房间记录落库 + 清理幽灵成员 + 空闲销毁
setInterval(() => {
  try {
    db.syncRooms(liveRoomSnapshots());
  } catch (err) {
    console.error('[rooms] 落库失败', err.message);
  }
}, 10000).unref();

setInterval(() => {
  try {
    pruneGhostMembers();
  } catch (err) {
    console.error('[rooms] 清理幽灵成员失败', err.message);
  }
}, 60000).unref();

setInterval(() => {
  try {
    idleDestroySweep();
  } catch (err) {
    console.error('[rooms] 空闲销毁失败', err.message);
  }
}, 60000).unref();

// ---------- 挂载后台管理接口 ----------
if (ADMIN_ENABLED) {
  app.use('/api/admin', createAdminRouter({
    db,
    auth,
    io,
    ops: adminOps,
    startedAt: STARTED_AT,
    version: pkg.version,
    listRooms: (kind) => (ROOM_LISTS[kind] ? ROOM_LISTS[kind]() : []),
    findRoom: (kind, id) => {
      const map = ROOM_MAPS[kind] ? ROOM_MAPS[kind]() : null;
      return map ? map.get(String(id).toUpperCase()) || null : null;
    },
    getSocketMeta: metaOf,
    onlineSocketIds: () => [...io.sockets.sockets.keys()],
    stats: () => ({
      onlineConnections: socketMeta.size,
      socketClients: io.engine ? io.engine.clientsCount : io.sockets.sockets.size
    })
  }));
}

// 未匹配到的 /api 统一返回 JSON，避免掉进 SPA 兜底
app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

/** 维护模式下只拦「新建 / 加入房间」，已经在房间里的用户可以继续用 */
function maintenanceBlocked(socket, action) {
  const settings = S();
  if (!settings.maintenanceMode) return false;
  socket.emit('maintenance', {
    action,
    message: settings.maintenanceMessage || '服务器正在维护中，请稍后再试'
  });
  return true;
}

/** 关闭「所有人可控制播放」后，只有房主能播放/暂停/切歌 */
function musicControlBlocked(socket, room) {
  if (S().allowMemberControlPlayback) return false;
  if (room.host === socket.id) return false;
  socket.emit('music-error', { message: '本房间只允许房主控制播放' });
  return true;
}

io.on('connection', (socket) => {
  // ---------- 连接登记 + 封禁校验 ----------
  const ip = clientIp(socket);
  const ua = String((socket.handshake.headers && socket.handshake.headers['user-agent']) || '');
  const ban = db.isBanned(ip);
  if (ban) {
    socket.emit('banned', { message: `你的 IP 已被限制访问${ban.reason ? '：' + ban.reason : ''}` });
    setTimeout(() => socket.disconnect(true), 100);
    return;
  }

  const meta = {
    ip,
    ua,
    device: deviceLabel(ua),
    connectedAt: Date.now(),
    referer: String((socket.handshake.headers && socket.handshake.headers.referer) || ''),
    lastActiveAt: Date.now(),
    rooms: new Set()
  };
  socketMeta.set(socket.id, meta);
  db.connectionOpened({ socketId: socket.id, ip, ua, device: meta.device, referer: meta.referer });

  // 任意事件都算活跃，供「空闲自动销毁」使用
  socket.use((packet, next) => {
    meta.lastActiveAt = Date.now();
    for (const roomId of socket.rooms) {
      if (roomId === socket.id) continue;
      for (const kind of Object.keys(ROOM_MAPS)) {
        const room = ROOM_MAPS[kind]().get(roomId);
        if (room) touchRoom(room);
      }
    }
    next();
  });

  // 连接即下发站点配置 / 公告，前端可选接入
  {
    const settings = S();
    const active = db.activeAnnouncement();
    socket.emit('server-info', {
      siteName: settings.siteName,
      maintenance: { enabled: settings.maintenanceMode, message: settings.maintenanceMessage },
      banner: settings.announcementBanner,
      announcement: active ? {
        id: active.id,
        title: active.title,
        content: active.content,
        level: active.level,
        popup: !!active.popup
      } : null
    });
  }

  // 创建房间（允许先创建空房间，房主稍后添加视频）
  // 对时：客户端拿这个估自己和服务器的时钟偏差，同步进度时才能算准「此刻该播到哪」
  socket.on('time-ping', (payload = {}, ack) => {
    const t0 = payload && typeof payload.t0 === 'number' ? payload.t0 : null;
    if (typeof ack === 'function') ack({ t: t0, s: Date.now() });
  });

  socket.on('create-room', (payload = {}) => {
    if (maintenanceBlocked(socket, 'create-room')) return;
    let video = payload.video || payload;
    if (!video || typeof video !== 'object' || !video.videoUrl) {
      video = null;
    }

    const room = createRoom(video, socket.id);
    socket.join(room.id);
    db.openRoom({
      kind: 'video',
      code: room.id,
      hostSocket: socket.id,
      hostIp: meta.ip,
      hostUa: meta.ua,
      memberCount: 1,
      createdAt: room.createdAt,
      meta: { video: video ? { title: video.title || '', bvid: video.bvid || '' } : null, playing: false }
    });
    socket.emit('room-created', { room: serializeRoom(room), isHost: true });
  });

  // 任何人（房主或成员）都可以给房间设置/更换视频
  socket.on('update-video', (payload = {}) => {
    const roomId = String(payload.roomId || '').toUpperCase().trim();
    const room = rooms.get(roomId);
    if (!room || !room.members.has(socket.id)) return;

    const video = payload.video || null;
    if (!video || !video.videoUrl) {
      return socket.emit('room-error', { message: '视频地址无效，请重新选择' });
    }

    clearVideoWait(room);
    room.videoReady = new Set();
    room.video = video;
    room.state = {
      playing: false,
      time: 0,
      rate: 1,
      at: Date.now()
    };
    // 谁点的片谁掌控播放，其他人跟着他走
    setRoomController(room, socket.id);

    io.to(room.id).emit('video-updated', {
      video: room.video,
      state: room.state,
      by: socket.id
    });
  });

  // 选择 B 站分 P
  socket.on('video-select-part', async (payload = {}) => {
    const roomId = String(payload.roomId || '').toUpperCase().trim();
    const room = rooms.get(roomId);
    if (!room || !room.members.has(socket.id)) return;

    const bvid = String(payload.bvid || '').trim();
    const cid = String(payload.cid || '').trim();
    if (!bvid || !cid) {
      return socket.emit('room-error', { message: '缺少视频分P信息' });
    }

    try {
      const videoUrl = await resolveBiliPlayUrl(bvid, cid, 64);
      let videoUrlLow = '';
      try {
        const low = await resolveBiliPlayUrl(bvid, cid, 32);
        if (low && low !== videoUrl) videoUrlLow = low;
      } catch (e) { /* 没有低清就用高清 */ }
      clearVideoWait(room);
      room.videoReady = new Set();
      room.video = {
        ...(room.video || {}),
        bvid,
        cid,
        videoUrl,
        videoUrlLow,
        part: payload.part || '',
        pages: room.video && room.video.pages ? room.video.pages : []
      };
      room.state = {
        playing: false,
        time: 0,
        rate: 1,
        at: Date.now()
      };
      setRoomController(room, socket.id);
      io.to(room.id).emit('video-updated', {
        video: room.video,
        state: room.state,
        by: socket.id
      });
    } catch (err) {
      socket.emit('room-error', { message: err.message || '切换分P失败' });
    }
  });

  // 加入房间
  socket.on('join-room', (payload = {}) => {
    if (maintenanceBlocked(socket, 'join-room')) return;
    const roomId = String(payload.roomId || '').toUpperCase().trim();
    const room = rooms.get(roomId);
    if (!room) {
      return socket.emit('room-error', { message: '房间不存在或已结束' });
    }

    const maxMembers = Math.max(2, S().roomMaxMembers);
    if (!room.members.has(socket.id) && room.members.size >= maxMembers) {
      return socket.emit('room-error', { message: `房间人数已满（最多 ${maxMembers} 人）` });
    }
    socket.join(room.id);
    const firstJoin = !room.members.has(socket.id);
    room.members.add(socket.id);
    touchRoom(room);
    if (firstJoin) {
      io.to(room.id).emit('member-updated', { count: room.members.size });
      db.roomEvent({ kind: 'video', roomCode: room.id, event: 'join', socketId: socket.id, ip: meta.ip });
    }
    db.touchRoomMembers('video', room.id, room.members.size);

    socket.emit('room-state', {
      room: serializeRoom(room),
      isHost: room.host === socket.id
    });
  });

  // 播放控制：房主和观众都能发——暂停 / 继续 / 拖进度 / 变速对全房生效。
  // 以前这里要求 isRoomController，只有「掌控者」能动，观众只能被动跟随；
  // 现在放开给所有成员，room.controller 只用来决定谁来跑周期 sync 心跳。
  socket.on('host-control', (payload = {}) => {
    const roomId = String(payload.roomId || '').toUpperCase().trim();
    const room = rooms.get(roomId);
    if (!room || !room.members.has(socket.id)) return;

    const { action, time, rate } = payload;
    // 房主点播放时先等观众 canplay；所有人就绪后再统一倒计时起播。
    // wait=false 或非 play 动作仍走原来的立即逻辑。
    if (action === 'play' && payload.wait !== false) {
      const others = [...room.members].filter((id) => id !== socket.id);
      if (others.some((id) => !room.videoReady.has(id))) {
        beginVideoWait(room, socket.id, typeof time === 'number' ? time : room.state.time);
        return;
      }
      startVideoPlay(room, typeof time === 'number' ? time : room.state.time);
      return;
    }
    if (action !== 'play') clearVideoWait(room);

    // 和昨天能用的版本一致：立即生效，不做预约起播。
    // 手机来得晚就按当前进度定位一次，之后靠 followTick 平滑追，不再反复重新加载。
    const atClient = Number(payload.atServer) || 0;
    const at = (atClient && Math.abs(Date.now() - atClient) < 5000) ? atClient : Date.now();

    if (action === 'play') {
      room.state.playing = true;
      if (typeof time === 'number') room.state.time = time;
    } else if (action === 'pause') {
      room.state.playing = false;
      if (typeof time === 'number') room.state.time = time;
    } else if (action === 'seek') {
      if (typeof time === 'number') room.state.time = time;
    } else if (action === 'rate') {
      if (typeof rate === 'number') room.state.rate = rate;
    }
    room.state.at = at;

    socket.to(room.id).emit('host-control', {
      action,
      time: typeof time === 'number' ? time : room.state.time,
      rate: typeof rate === 'number' ? rate : room.state.rate,
      at,
      from: socket.id
    });
  });

  // 客户端视频 canplay 后上报；等待中的房主据此放行
  socket.on('video-ready', (payload = {}) => {
    const roomId = String(payload.roomId || '').toUpperCase().trim();
    const room = rooms.get(roomId);
    if (!room || !room.members.has(socket.id)) return;
    room.videoReady.add(socket.id);
    if (room.videoWait) {
      io.to(room.id).emit('video-waiting', { ...videoWaitCounts(room), by: room.videoWait.by });
    }
    maybeStartWaitedVideo(room);
  });

  // 周期同步（建议 5 秒一次，由当前掌控者触发）
  socket.on('sync', (payload = {}) => {
    const roomId = String(payload.roomId || '').toUpperCase().trim();
    const room = rooms.get(roomId);
    if (!room || !room.members.has(socket.id)) return;
    if (!isRoomController(room, socket.id)) return;

    const { time = 0, playing = false, rate = 1 } = payload;
    const atClient = Number(payload.atServer) || 0;
    room.state = {
      time: Number(time) || 0,
      playing: !!playing,
      rate: Number(rate) || 1,
      at: (atClient && Math.abs(Date.now() - atClient) < 5000) ? atClient : Date.now()
    };

    socket.to(room.id).emit('sync', {
      time: room.state.time,
      playing: room.state.playing,
      rate: room.state.rate,
      at: room.state.at
    });
  });

  // 主动离开房间
  socket.on('leave-room', (payload = {}) => {
    const roomId = String(payload.roomId || '').toUpperCase().trim();
    const room = rooms.get(roomId);
    if (!room || !room.members.has(socket.id)) return;

    socket.leave(room.id);
    const closed = removeVideoMember(room, socket.id);
    db.roomEvent({ kind: 'video', roomCode: roomId, event: 'leave', socketId: socket.id, ip: meta.ip });
    if (closed) db.markRoomClosed('video', roomId, 'empty');
  });

    // ---------- 五子棋 ----------
    socket.on('gomoku-create-room', () => {
      if (maintenanceBlocked(socket, 'gomoku-create-room')) return;
      const room = createGomokuRoom(socket.id);
      socket.join(room.id);
      db.openRoom({
        kind: 'gomoku',
        code: room.id,
        hostSocket: socket.id,
        hostIp: meta.ip,
        hostUa: meta.ua,
        memberCount: 1,
        createdAt: room.createdAt,
        meta: { players: 1, moves: 0 }
      });
      socket.emit('gomoku-room-created', {
        room: serializeGomokuRoom(room),
        isHost: true,
        color: 'black'
      });
    });

    socket.on('gomoku-join-room', (payload = {}) => {
      if (maintenanceBlocked(socket, 'gomoku-join-room')) return;
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = gomokuRooms.get(roomId);
      if (!room) {
        return socket.emit('gomoku-error', { message: '五子棋房间不存在或已结束' });
      }
      if (room.players.size >= 2) {
        return socket.emit('gomoku-error', { message: '五子棋房间已满，只能两个人对战' });
      }
      if (room.members.has(socket.id)) {
        return socket.emit('gomoku-error', { message: '你已经在房间里了' });
      }

      room.members.add(socket.id);
      const color = room.players.has('black') ? 'white' : 'black';
      room.players.set(color, socket.id);
      touchRoom(room);
      socket.join(room.id);
      db.roomEvent({ kind: 'gomoku', roomCode: room.id, event: 'join', socketId: socket.id, ip: meta.ip, detail: { color } });
      db.touchRoomMembers('gomoku', room.id, room.members.size);
      if (room.players.size === 2 && !room.winner) {
        room.turnStartedAt = Date.now();
        startGomokuTurnTimer(room);
      }

      socket.emit('gomoku-room-joined', {
        room: serializeGomokuRoom(room),
        isHost: room.host === socket.id,
        color
      });

      // 通知先创建房间的人，对手已加入
      broadcastGomokuRoom(room);
    });

    socket.on('gomoku-move', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = gomokuRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;

      const row = Number(payload.row);
      const col = Number(payload.col);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
        return socket.emit('gomoku-error', { message: '落子位置无效' });
      }
      if (room.winner) return;
      if (room.board[row][col]) {
        return socket.emit('gomoku-error', { message: '这里已经有棋子了' });
      }
      const color = getGomokuColor(room, socket.id);
      if (!color || color !== room.currentTurn) {
        return socket.emit('gomoku-error', { message: color ? '还没轮到你落子' : '你不是本局玩家' });
      }

      room.board[row][col] = color;
      room.lastMove = { row, col };
      const winLine = checkGomokuWin(room.board, row, col, color);
      if (winLine) {
        room.winner = color;
        room.winLine = winLine;
      } else {
        room.currentTurn = room.currentTurn === 'black' ? 'white' : 'black';
      }
      room.history.push({ row, col, color });
      if (room.winner) {
        clearGomokuTimer(room);
      } else {
        room.turnStartedAt = Date.now();
        startGomokuTurnTimer(room);
      }

      io.to(room.id).emit('gomoku-move', {
        roomId: room.id,
        row,
        col,
        color,
        board: room.board,
        currentTurn: room.currentTurn,
        winner: room.winner,
        winLine: room.winLine,
        lastMove: room.lastMove,
        turnSeconds: room.turnSeconds,
        turnStartedAt: room.turnStartedAt
      });
    });

    socket.on('gomoku-undo', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = gomokuRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;
      if (room.winner) {
        return socket.emit('gomoku-error', { message: '本局已结束，不能悔棋' });
      }
      if (!room.history.length) {
        return socket.emit('gomoku-error', { message: '还没有可悔棋的棋子' });
      }
      const myColor = getGomokuColor(room, socket.id);
      const lastMove = room.history[room.history.length - 1];
      if (!myColor || !lastMove || lastMove.color !== myColor) {
        return socket.emit('gomoku-error', { message: '只能悔自己刚下的一手' });
      }
      const last = room.history.pop();
      room.board[last.row][last.col] = null;
      room.lastMove = room.history.length ? room.history[room.history.length - 1] : null;
      room.currentTurn = last.color;
      room.winner = null;
      room.winLine = [];
      room.turnStartedAt = Date.now();
      startGomokuTurnTimer(room);
      broadcastGomokuRoom(room);
    });

    socket.on('gomoku-restart', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = gomokuRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;
      if (!room.winner) return; // 有胜负后才能重新开始，也可改为房主随时重置

      resetGomokuGame(room, true);
      io.to(room.id).emit('gomoku-restart', {
        roomId: room.id,
        board: room.board,
        currentTurn: room.currentTurn,
        winner: null,
        winLine: [],
        lastMove: null,
        turnSeconds: room.turnSeconds,
        turnStartedAt: room.turnStartedAt,
        playersSwapped: true
      });
      broadcastGomokuRoom(room);
    });

    socket.on('gomoku-timeout', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = gomokuRooms.get(roomId);
      if (!room || !room.members.has(socket.id) || room.winner) return;
      if (room.players.size < 2) return;
      const color = getGomokuColor(room, socket.id);
      if (!color || color !== room.currentTurn) return;
      if (Date.now() - room.turnStartedAt < GOMOKU_TURN_SECONDS * 1000 - 500) return;
      room.winner = otherGomokuColor(color);
      room.winLine = [];
      clearGomokuTimer(room);
      broadcastGomokuRoom(room);
    });

    socket.on('gomoku-leave', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = gomokuRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;

      socket.leave(room.id);
      gomokuPlayerLeft(room, socket.id);
    });

    // ---------- 斗地主 ----------
    socket.on('ddz-create-room', () => {
      if (maintenanceBlocked(socket, 'ddz-create-room')) return;
      const room = createDdzRoom(socket.id);
      socket.join(room.id);
      db.openRoom({
        kind: 'doudizhu',
        code: room.id,
        hostSocket: socket.id,
        hostIp: meta.ip,
        hostUa: meta.ua,
        memberCount: 1,
        createdAt: room.createdAt,
        meta: { phase: room.phase }
      });
      socket.emit('ddz-room-created', {
        room: serializeDdzRoom(room),
        you: { index: 0, hand: room.seats[0].hand },
        isHost: true
      });
    });

    socket.on('ddz-join-room', (payload = {}) => {
      if (maintenanceBlocked(socket, 'ddz-join-room')) return;
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = ddzRooms.get(roomId);
      if (!room) {
        return socket.emit('ddz-error', { message: '斗地主房间不存在或已结束' });
      }
      if (room.members.has(socket.id)) {
        return socket.emit('ddz-error', { message: '你已经在房间里了' });
      }
      const seatIndex = room.seats.findIndex((p) => !p);
      if (seatIndex < 0) {
        return socket.emit('ddz-error', { message: '斗地主房间已满，需要 3 位玩家' });
      }

      room.members.add(socket.id);
      room.seats[seatIndex] = {
        socketId: socket.id,
        name: '玩家' + (seatIndex + 1),
        hand: [],
        isLandlord: false
      };
      socket.join(room.id);
      touchRoom(room);
      db.roomEvent({ kind: 'doudizhu', roomCode: room.id, event: 'join', socketId: socket.id, ip: meta.ip, detail: { seat: seatIndex } });
      db.touchRoomMembers('doudizhu', room.id, room.members.size);

      if (room.members.size === 3 && room.phase === 'waiting') {
        startDdzBidding(room, '三人已满，开始叫地主');
      }

      socket.emit('ddz-room-joined', {
        room: serializeDdzRoom(room),
        you: { index: seatIndex, hand: room.seats[seatIndex].hand },
        isHost: room.host === socket.id
      });

      broadcastDdzRoom(room);
    });

    socket.on('ddz-bid', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = ddzRooms.get(roomId);
      const seat = room ? getDdzSeat(room, socket.id) : -1;
      if (!room || seat < 0) {
        return socket.emit('ddz-error', { message: '斗地主房间不存在或你不在房间中' });
      }
      if (room.phase !== 'bidding') {
        return socket.emit('ddz-error', { message: '当前不是叫地主阶段' });
      }
      if (seat !== room.bidding.current) {
        return socket.emit('ddz-error', { message: '还没轮到你叫地主' });
      }

      const action = String(payload.action || '');
      if (!['call', 'grab', 'pass'].includes(action)) {
        return socket.emit('ddz-error', { message: '无效的叫地主操作' });
      }
      if (!room.bidding.hasBid && action === 'grab') {
        return socket.emit('ddz-error', { message: '还没人叫地主，只能叫地主或不叫' });
      }
      if (room.bidding.hasBid && action === 'call') {
        return socket.emit('ddz-error', { message: '已经有人叫地主，只能抢地主或不抢' });
      }
      if (room.bidding.acted[seat]) {
        return socket.emit('ddz-error', { message: '你已经操作过了' });
      }

      room.bidding.acted[seat] = true;
      if (action === 'call' || action === 'grab') {
        room.bidding.hasBid = true;
        room.bidding.lastBidder = seat;
        room.statusText = `${ddzSeatName(room, seat)}${action === 'call' ? ' 叫地主！' : ' 抢地主！'}`;
      } else {
        room.statusText = `${ddzSeatName(room, seat)}${room.bidding.hasBid ? ' 不抢' : ' 不叫'}`;
      }

      if (room.bidding.acted.every(Boolean)) {
        if (room.bidding.lastBidder >= 0) {
          startDdzPlaying(room, room.bidding.lastBidder);
        } else {
          startDdzBidding(room, '没人叫地主，重新发牌');
        }
        broadcastDdzRoom(room);
        return;
      }

      let next = (seat + 1) % 3;
      while (room.bidding.acted[next]) {
        next = (next + 1) % 3;
      }
      room.bidding.current = next;
      room.currentPlayer = next;
      room.statusText = `轮到 ${ddzSeatName(room, next)}${room.bidding.hasBid ? ' 抢地主' : ' 叫地主'}`;
      broadcastDdzRoom(room);
    });

    socket.on('ddz-play', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = ddzRooms.get(roomId);
      const seat = room ? getDdzSeat(room, socket.id) : -1;
      if (!room || seat < 0) {
        return socket.emit('ddz-error', { message: '斗地主房间不存在或你不在房间中' });
      }
      if (room.phase !== 'playing') {
        return socket.emit('ddz-error', { message: '当前不是出牌阶段' });
      }
      if (seat !== room.currentPlayer) {
        return socket.emit('ddz-error', { message: '还没轮到你出牌' });
      }

      const hand = room.seats[seat].hand;
      const seen = new Set();
      const actualCards = [];
      for (const c of payload.cards || []) {
        const id = c && c.id;
        if (typeof id !== 'number' || seen.has(id)) {
          return socket.emit('ddz-error', { message: '出牌数据无效' });
        }
        seen.add(id);
        const found = hand.find((x) => x.id === id);
        if (!found) {
          return socket.emit('ddz-error', { message: '你选择了不存在的牌' });
        }
        actualCards.push(found);
      }
      if (!actualCards.length) {
        return socket.emit('ddz-error', { message: '请选择要出的牌' });
      }

      const play = ddz.parseCards(actualCards);
      if (!play) {
        return socket.emit('ddz-error', { message: '不是合法牌型' });
      }
      if (room.lastPlay && !ddz.canBeat(play, room.lastPlay)) {
        return socket.emit('ddz-error', { message: '管不上这手牌' });
      }

      const removeIds = new Set(actualCards.map((x) => x.id));
      room.seats[seat].hand = hand.filter((x) => !removeIds.has(x.id));
      room.lastPlay = {
        seat,
        cards: actualCards.slice(),
        type: play.type,
        rank: play.rank,
        length: play.length
      };
      room.passCount = 0;
      room.statusText = `${ddzSeatName(room, seat)} 出了 ${ddz.describePlay(play)}`;

      if (room.seats[seat].hand.length === 0) {
        room.phase = 'ended';
        room.winnerSeat = seat;
        const landlordWon = seat === room.landlordIndex;
        room.statusText = landlordWon
          ? `${ddzSeatName(room, seat)} 地主获胜`
          : `${ddzSeatName(room, seat)} 农民获胜`;
        broadcastDdzRoom(room);
        return;
      }

      room.currentPlayer = (seat + 1) % 3;
      broadcastDdzRoom(room);
    });

    socket.on('ddz-pass', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = ddzRooms.get(roomId);
      const seat = room ? getDdzSeat(room, socket.id) : -1;
      if (!room || seat < 0) {
        return socket.emit('ddz-error', { message: '斗地主房间不存在或你不在房间中' });
      }
      if (room.phase !== 'playing') {
        return socket.emit('ddz-error', { message: '当前不是出牌阶段' });
      }
      if (seat !== room.currentPlayer) {
        return socket.emit('ddz-error', { message: '还没轮到你出牌' });
      }
      if (!room.lastPlay) {
        return socket.emit('ddz-error', { message: '新一轮必须出牌' });
      }

      room.passCount++;
      room.statusText = `${ddzSeatName(room, seat)} 不出`;

      if (room.passCount >= 2 && room.lastPlay) {
        const leader = room.lastPlay.seat;
        room.lastPlay = null;
        room.passCount = 0;
        room.currentPlayer = leader;
        room.statusText = `${ddzSeatName(room, leader)} 获得出牌权`;
      } else {
        room.currentPlayer = (seat + 1) % 3;
      }

      broadcastDdzRoom(room);
    });

    socket.on('ddz-restart', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = ddzRooms.get(roomId);
      if (!room || room.host !== socket.id) {
        return socket.emit('ddz-error', { message: '只有房主可以重新开局' });
      }
      if (room.phase !== 'ended') {
        return socket.emit('ddz-error', { message: '本局还没有结束' });
      }
      if (room.seats.filter(Boolean).length < 3) {
        return socket.emit('ddz-error', { message: '需要 3 位玩家才能重新开局' });
      }
      startDdzBidding(room, '房主重新开局');
      broadcastDdzRoom(room);
    });

    socket.on('ddz-leave', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = ddzRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;

      socket.leave(room.id);
      ddzPlayerLeft(room, socket.id);
    });


    // ---------- 音乐房间 ----------
    socket.on('music-create-room', () => {
      if (maintenanceBlocked(socket, 'music-create-room')) return;
      const room = createMusicRoom(socket.id);
      socket.join(room.id);
      db.openRoom({
        kind: 'music',
        code: room.id,
        hostSocket: socket.id,
        hostIp: meta.ip,
        hostUa: meta.ua,
        memberCount: 1,
        createdAt: room.createdAt,
        meta: { queue: 0 }
      });
      socket.emit('music-room-created', {
        room: serializeMusicRoom(room, socket.id),
        isHost: true
      });
    });

    socket.on('music-join-room', (payload = {}) => {
      if (maintenanceBlocked(socket, 'music-join-room')) return;
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = musicRooms.get(roomId);
      if (!room) {
        return socket.emit('music-error', { message: '音乐房间不存在或已结束' });
      }
      if (room.members.has(socket.id)) {
        // 同一个 Socket 重复进入房间时不报错，直接返回当前状态
        socket.join(room.id);
        socket.emit('music-room-joined', {
          room: serializeMusicRoom(room, socket.id),
          isHost: room.host === socket.id
        });
        return;
      }

      const maxMembers = Math.max(2, S().roomMaxMembers);
      if (room.members.size >= maxMembers) {
        return socket.emit('music-error', { message: `房间人数已满（最多 ${maxMembers} 人）` });
      }

      socket.join(room.id);
      room.members.add(socket.id);
      touchRoom(room);
      db.roomEvent({ kind: 'music', roomCode: room.id, event: 'join', socketId: socket.id, ip: meta.ip });
      db.touchRoomMembers('music', room.id, room.members.size);
      io.to(room.id).emit('music-member-updated', { count: room.members.size });
      socket.emit('music-room-joined', {
        room: serializeMusicRoom(room, socket.id),
        isHost: room.host === socket.id
      });
      broadcastMusicRoom(room);
    });

    socket.on('music-add-song', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = musicRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;

      const song = payload.song || {};
      const songUrl = toRelativeUploadUrl(song.url);
      if (!songUrl) {
        return socket.emit('music-error', { message: '歌曲地址不能为空' });
      }
      if (isSongBanned(song)) {
        return socket.emit('music-error', { message: '这首歌已被管理员禁播，换一首吧' });
      }
      room.queue.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        sourceId: String(song.id || '').trim(),
        title: song.title || '在线歌曲',
        url: songUrl,
        duration: Number(song.duration) || 0,
        author: song.author || '',
        pic: song.pic || '',
        lrc: song.lrc || '',
        addedBy: socket.id
      });
      const syncTime = Number(payload.time);
      const startPending = room.waiting || (room.startAt && Date.now() < room.startAt);
      if (!startPending && !Number.isNaN(syncTime) && syncTime >= 0) {
        room.time = syncTime;
      }
      // 等待开播 / 已定好开播时刻时，加歌不能把播放状态改乱
      if (typeof payload.playing === 'boolean' && !startPending) {
        room.playing = payload.playing;
      }
      touchRoom(room);
      db.musicLog({
        roomCode: room.id,
        socketId: socket.id,
        ip: meta.ip,
        songId: song.id,
        title: song.title || '',
        author: song.author || '',
        action: 'add'
      });
      broadcastMusicRoom(room);
    });

    socket.on('music-remove-song', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = musicRooms.get(roomId);
      if (!room || room.host !== socket.id) return;

      const index = Number(payload.index);
      if (!Number.isInteger(index) || index < 0 || index >= room.queue.length) return;
      room.queue.splice(index, 1);
      // 删掉的是当前曲目之前的歌：正在播的这首歌整体前移一位，索引跟着减
      if (index < room.currentIndex) room.currentIndex -= 1;
      if (room.currentIndex >= room.queue.length) room.currentIndex = -1;
      broadcastMusicRoom(room);
    });

    /**
     * 成员点「准备一起听」。
     * 这一步既解锁了手机的声音权限，也让房主那边知道「可以开播了」。
     */
    socket.on('music-ready', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = musicRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;

      if (payload.ready === false) room.ready.delete(socket.id);
      else room.ready.add(socket.id);

      if (room.waiting) {
        // 房主在等：点准备 + 真正能播的人齐了，立刻定开播时刻
        if (musicAllReadyBuffered(room)) {
          room.waiting = false;
          clearMusicWait(room);
          musicScheduleStart(room, room.pendingTime);
        }
      } else if (room.playing && payload.ready !== false) {
        // 房间已经在放：新准备好的人从当前时间轴自己追上来，
        // 不再给全房重新预约一次起播（否则每次有人准备，所有人都要再等 1.8 秒）。
      }
      broadcastMusicRoom(room);
    });

    // 客户端真正 canplay 后上报；服务端据此把开播时刻放到手机缓冲好之后
    socket.on('music-buffered', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = musicRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;
      room.buffered.add(socket.id);
      if (room.waiting && musicAllReadyBuffered(room)) {
        room.waiting = false;
        clearMusicWait(room);
        musicScheduleStart(room, room.pendingTime);
        broadcastMusicRoom(room);
      }
    });

    socket.on('music-play', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = musicRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;
      if (musicControlBlocked(socket, room)) return;

      let index = Number(payload.index);
      if (!Number.isInteger(index) || index < 0 || index >= room.queue.length) {
        if (room.currentIndex < 0 && room.queue.length > 0) index = 0;
        else index = room.currentIndex;
      }
      const prevIndex = room.currentIndex;
      room.currentIndex = Math.max(0, index);
      // 换歌才清空缓冲集合；同一首歌暂停后再播，手机早已 canplay，不该再等 4 秒
      if (prevIndex !== room.currentIndex) room.buffered = new Set([room.host]);
      const t = typeof payload.time === 'number' ? payload.time : 0;
      // 关键改动：这里不再立刻播放，而是先确认大家都加载好了，
      // 再定一个统一的时刻一起响。以前是房主先响，手机再追，永远追不上。
      musicRequestStart(room, t);
      touchRoom(room);
      broadcastMusicRoom(room);
    });

    socket.on('music-pause', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = musicRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;
      if (musicControlBlocked(socket, room)) return;

      clearMusicWait(room);
      room.waiting = false;
      room.startAt = 0;
      // 暂停时锁住此刻的真实位置：预约时刻的 time 是「未来那一刻」的值，
      // 直接拿来当暂停位置会跳一下
      room.playing = false;
      room.time = typeof payload.time === 'number' ? payload.time : room.time;
      room.syncedAt = musicSyncAt(payload);
      touchRoom(room);
      broadcastMusicRoom(room);
    });

    socket.on('music-seek', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = musicRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;
      if (musicControlBlocked(socket, room)) return;

      if (room.waiting) {
        // 还在等别人准备好：只更新一下起点，别开播
        room.pendingTime = Number(payload.time) || 0;
        touchRoom(room);
        broadcastMusicRoom(room);
        return;
      }
      room.time = Number(payload.time) || 0;
      room.syncedAt = musicSyncAt(payload);
      room.startAt = 0;
      // 自增序号：让房主也能强制跟随别人的跳转（否则 5s 后 sync 会把进度拉回去）
      room.seekSeq = (room.seekSeq || 0) + 1;
      touchRoom(room);
      broadcastMusicRoom(room);
    });

    socket.on('music-next', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = musicRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;
      if (musicControlBlocked(socket, room)) return;

      if (room.queue.length === 0) return;
      room.currentIndex = (room.currentIndex + 1) % room.queue.length;
      room.buffered = new Set([room.host]);
      // 换歌也走统一的预约开播：两边同时从头开始，而不是各起各的
      musicRequestStart(room, 0);
      touchRoom(room);
      broadcastMusicRoom(room);
    });

    socket.on('music-prev', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = musicRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;
      if (musicControlBlocked(socket, room)) return;

      if (room.queue.length === 0) return;
      room.currentIndex = (room.currentIndex - 1 + room.queue.length) % room.queue.length;
      room.buffered = new Set([room.host]);
      musicRequestStart(room, 0);
      touchRoom(room);
      broadcastMusicRoom(room);
    });

    socket.on('music-sync', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = musicRooms.get(roomId);
      if (!room || room.host !== socket.id) return;
      // 等待中 / 还没到预约时刻：别让房主的心跳把刚刚定好的开播时刻冲掉
      if (room.waiting) return;
      if (room.startAt && Date.now() < room.startAt) return;

      room.time = Number(payload.time) || 0;
      room.playing = !!payload.playing;
      room.syncedAt = musicSyncAt(payload);
      broadcastMusicRoom(room);
    });

    socket.on('music-leave', (payload = {}) => {
      const roomId = String(payload.roomId || '').toUpperCase().trim();
      const room = musicRooms.get(roomId);
      if (!room || !room.members.has(socket.id)) return;

      socket.leave(room.id);
      musicPlayerLeft(room, socket.id);
    });



  // 断开连接
  socket.on('disconnect', (reason) => {
    const joined = [];
    for (const [roomId, room] of rooms) {
      if (!room.members.has(socket.id)) continue;
      joined.push('video:' + roomId);
      const closed = removeVideoMember(room, socket.id);
      db.roomEvent({ kind: 'video', roomCode: roomId, event: 'disconnect', socketId: socket.id, ip: meta.ip });
      if (closed) db.markRoomClosed('video', roomId, 'empty');
    }

    for (const [roomId, room] of gomokuRooms) {
      if (!room.members.has(socket.id)) continue;
      joined.push('gomoku:' + roomId);
      gomokuPlayerLeft(room, socket.id);
    }

    for (const [roomId, room] of ddzRooms) {
      if (!room.members.has(socket.id)) continue;
      joined.push('doudizhu:' + roomId);
      ddzPlayerLeft(room, socket.id);
    }

    for (const [roomId, room] of musicRooms) {
      if (!room.members.has(socket.id)) continue;
      joined.push('music:' + roomId);
      musicPlayerLeft(room, socket.id);
    }

    // 审计：在线时长 / 异常断开
    if (joined.length) db.connectionRooms(socket.id, joined);
    db.connectionClosed(socket.id, String(reason || ''));
    socketMeta.delete(socket.id);
  });
});

// ---------- 后台静态页面（独立单页，无构建依赖） ----------
const ADMIN_UI_DIR = path.join(__dirname, 'admin-ui');
if (ADMIN_ENABLED) {
  app.use('/admin', (req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; "
      + "script-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; "
      + "base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    next();
  }, express.static(ADMIN_UI_DIR, {
    index: 'index.html',
    etag: true,
    setHeaders(res, filePath) {
      // HTML 不缓存，避免更新后还看到旧页面
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    }
  }));
}

// ---------- 托管前端 H5 构建产物（可选） ----------
// 在 HBuilderX 中执行“发行 -> 网站-H5手机版”后，后端可直接托管前端，
// 别人访问 http://你的IP:3000 即可使用，无需再开 8080。
if (H5_DIST) {
  // 用自带的静态服务替换 express.static：
  //   · brotli / gzip 压缩（main.js 291KB → 约 80KB，手机端首屏明显变快）
  //   · /assets/ 下带 hash 的文件强缓存一年，第二次进站几乎不下载
  //   · index.html 走 no-cache + ETag，内容更新立刻生效
  const serveH5 = serveStaticH5(H5_DIST);
  app.use(serveH5);

  app.get('*', (req, res, next) => {
    if (
      req.path.startsWith('/api') ||
      req.path.startsWith('/uploads') ||
      req.path.startsWith('/socket.io') ||
      req.path.startsWith('/admin')
    ) {
      return next();
    }
    // 带扩展名的静态资源缺失时直接 404，不要回退成 index.html
    // （否则浏览器会把 HTML 当 JS/CSS 加载，报 MIME 错误，且掩盖构建缺文件）
    if (path.extname(req.path)) {
      return next();
    }
    // 前端 history 路由兜底：改写成根路径，复用上面的压缩 + 缓存逻辑
    req.url = '/';
    serveH5(req, res, next);
  });
} else {
  app.get('/', (req, res) => {
    res.status(200).type('html').send(
      '<meta charset="utf-8"><title>' + S().siteName + '</title>'
      + '<div style="font-family:system-ui;padding:40px;line-height:1.8">'
      + '<h1>前端还没有构建</h1>'
      + '<p>请在 HBuilderX 中执行：<b>发行 → 网站-H5手机版</b>，'
      + '确认产物在 <code>unpackage/dist/build/h5/index.html</code> 后重启后端。</p>'
      + (ADMIN_ENABLED ? '<p>后台管理入口：<a href="/admin">/admin</a></p>' : '')
      + '</div>'
    );
  });
}

// ---------- 错误处理 ----------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `文件大小超过 ${S().maxUploadMB}MB 限制` });
    }
    return res.status(400).json({ error: err.message });
  }
  // multer 的 fileFilter 抛的是普通 Error，也要按 4xx 返回
  if (err && typeof err.message === 'string' && err.message.indexOf('不支持的文件类型') === 0) {
    return res.status(400).json({ error: err.message });
  }
  console.error(err);
  db.errorLog({
    level: 'error',
    message: err && err.message,
    stack: err && err.stack,
    source: `${req.method} ${req.originalUrl}`
  });
  res.status(500).json({ error: '服务器内部错误' });
});

// 进程级异常也要留痕，避免后台「错误日志」永远是空的
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException', err);
  try {
    db.errorLog({ level: 'fatal', message: err && err.message, stack: err && err.stack, source: 'uncaughtException' });
  } catch (e) { /* 数据库不可用时忽略 */ }
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[fatal] unhandledRejection', err);
  try {
    db.errorLog({ level: 'fatal', message: err.message, stack: err.stack, source: 'unhandledRejection' });
  } catch (e) { /* 忽略 */ }
});

// ---------- 启动 ----------
/**
 * 启动完成后自动打开浏览器
 * 默认开启；想关掉（比如部署在服务器 / Docker 里）设置 AUTO_OPEN=0
 * 打不开也只是打印一行提示，不影响服务本身
 */
function openBrowser(url) {
  const flag = String(process.env.AUTO_OPEN || '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return;
  if (process.env.NO_OPEN === '1') return;

  let cmd;
  if (process.platform === 'win32') {
    cmd = `cmd /c start "" "${url}"`;
  } else if (process.platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      console.log(' （没有图形界面，跳过自动打开浏览器）');
      return;
    }
    cmd = `xdg-open "${url}"`;
  }

  try {
    require('child_process').exec(cmd, (err) => {
      if (err) console.log(' （自动打开浏览器失败，请手动访问上面的地址；设置 AUTO_OPEN=0 可关闭此行为）');
    });
    console.log(' 正在打开浏览器…（不想自动打开：设置环境变量 AUTO_OPEN=0）');
  } catch (e) {
    console.log(' （自动打开浏览器失败，请手动访问上面的地址）');
  }
}

// 上一次进程残留的「进行中」房间记录统一收尾（实时房间本就在内存里，重启即失效）
const staleRooms = db.closeOpenRooms('server_restart');
const initialAdmin = ADMIN_ENABLED ? ensureInitialAdmin({ db, auth }) : null;
const adminCount = db.countAdmins();

// 端口被占用时给个能看懂的提示，而不是甩一堆 uncaughtException 堆栈
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('');
    console.error(` [错误] 端口 ${PORT} 已经被占用，通常是之前启动的窗口还没关。`);
    console.error('        解决办法（任选一种）：');
    console.error('        1) 关掉之前那个启动窗口，再重新双击启动');
    console.error('        2) 换个端口启动：');
    console.error(`           Windows:     set PORT=3100 && node server\\index.js`);
    console.error(`           macOS/Linux: PORT=3100 node server/index.js`);
    console.error('');
    process.exit(1);
  }
  console.error('[错误] 服务启动失败：', err && err.message ? err.message : err);
  process.exit(1);
});

server.listen(PORT, () => {
  if (!QUIET_START) {
    console.log('==============================================');
    console.log(` ${S().siteName} 后端已启动：http://localhost:${PORT}`);
    if (ADMIN_ENABLED) console.log(` 后台管理：http://localhost:${PORT}/admin`);
    const lan = lanAddresses();
    const kindLabel = (k) => (k === 'wifi' ? 'Wi-Fi' : k === 'ethernet' ? '有线' : k === 'virtual' ? '虚拟网卡' : '');
    if (lan.length) {
      const first = lan[0];
      const tag = kindLabel(first.kind);
      console.log(` 局域网访问（手机/别的设备用这个）：http://${first.ip}:${PORT}${tag ? '  (' + tag + ')' : ''}`);
      if (lan.length > 1) {
        console.log(' 其它可用地址：' + lan.slice(1, 4)
          .map((i) => `http://${i.ip}:${PORT} (${i.name})`).join('，'));
      }
      console.log(' 手机扫码：二维码会自动优先用公网地址（异地也能扫），没有公网地址时用上面这个。');
    } else {
      console.log(' 本机/局域网访问：http://<你的IP>:' + PORT + '（未探测到局域网网卡）');
    }
    console.log(H5_DIST ? (' 已托管前端：' + H5_DIST) : ' 未找到 H5 产物（访问 / 会提示如何构建）');
    const pub = publicUrl();
    if (pub) {
      console.log(` 公网地址（异地也能访问）：${pub}`);
      console.log('   （来自内网穿透，观影厅二维码会自动使用它）');
    } else {
      console.log(' 异地扫码：由「一键启动」自动开启公网地址；源码运行可另开窗口执行 npm run tunnel');
    }
    console.log(` 数据文件：${db.DB_PATH}（${ADMIN_ENABLED ? '管理员 ' + adminCount + ' 个，' : ''}历史房间 ${db.statsSnapshot().historyTotal} 个）`);
    if (staleRooms) console.log(` 已归档上次运行残留的房间记录：${staleRooms} 条`);
    console.log('==============================================');
  }
  if (initialAdmin) {
    console.log('----------------------------------------------');
    console.log(' 已自动创建初始管理员（请立即登录并修改密码）：');
    console.log(`   账号：${initialAdmin.username}`);
    console.log(`   密码：${initialAdmin.password}`);
    console.log(' 该密码只在首次启动时打印一次，也可以设置环境变量');
    console.log(' ADMIN_INIT_USERNAME / ADMIN_INIT_PASSWORD 后重新初始化。');
    console.log('----------------------------------------------');
  }

  // 服务已就绪再开浏览器，避免打开一个空白页
  openBrowser(`http://localhost:${PORT}`);
});
