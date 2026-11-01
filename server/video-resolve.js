const axios = require('axios');
const { resolveBilibili, extractBvid, UA } = require('./bilibili');

/**
 * 通用视频地址解析
 *
 * 目标：用户粘贴什么都能看，不再局限于 B 站。
 *   1) 直链（.mp4 / .m3u8 / .webm / .flv …）→ 直接播
 *   2) B 站 → 走原有解析（含 b23.tv 短链）
 *   3) 任意网页 → 抓 HTML，从 og:video / <video> / <source> / JSON-LD / 裸链接里找媒体地址
 *   4) 实在取不到流、但站点本身允许嵌入 → 返回 embed 地址，前端用 iframe 兜底（不同步进度）
 */

const BROWSER_UA = UA;
const DIRECT_EXT_RE = /\.(mp4|m4v|m3u8|webm|ogv|ogg|mov|flv|f4v|mpd|mkv|ts|3gp)(?:[?#]|$)/i;
const HLS_EXT_RE = /\.m3u8(?:[?#]|$)/i;
const IMAGE_EXT_RE = /\.(gif|jpe?g|png|webp|svg|bmp|ico)(?:[?#]|$)/i;
const PAGE_MAX_BYTES = 3 * 1024 * 1024;
const PROBE_TIMEOUT = 7000;

function decodeEntities(input) {
  return String(input || '')
    .replace(/\\u002F/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&#38;/g, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function absolutize(url, base) {
  const raw = decodeEntities(url).trim();
  if (!raw) return '';
  try {
    if (raw.startsWith('//')) return new URL('https:' + raw).toString();
    return new URL(raw, base || undefined).toString();
  } catch (err) {
    return '';
  }
}

/**
 * 从一段文本里抠出链接：用户常常连着「【标题】https://… 分享自…」一起复制过来
 */
function normalizeInput(raw) {
  let text = String(raw || '').trim();
  if (!text) throw new Error('请先粘贴视频链接');
  const m = text.match(/https?:\/\/[^\s<>"'）)】]+/i);
  if (m) {
    text = m[0];
  } else if (/^[\w.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(text)) {
    text = 'https://' + text;
  } else if (/^\/\//.test(text)) {
    text = 'https:' + text;
  } else {
    throw new Error('没认出链接，请粘贴以 http:// 或 https:// 开头的地址');
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch (err) {
    throw new Error('链接格式不正确，请检查后重试');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http/https 链接');
  }
  return parsed.toString();
}

function isBilibiliHost(url) {
  return /(^|\.)(bilibili\.com|b23\.tv|acgvideo\.com)$/i.test(new URL(url).hostname);
}

/** b23.tv 这类短链要先跟一次跳转才能拿到 BV 号 */
async function expandShortLink(url) {
  if (!/b23\.tv/i.test(url)) return url;
  try {
    const resp = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
      timeout: 8000,
      headers: { 'User-Agent': BROWSER_UA }
    });
    const loc = resp.headers && resp.headers.location;
    if (loc) return new URL(loc, url).toString();
  } catch (err) {
    // 短链展开失败就原样返回，交给后面的报错信息解释
  }
  return url;
}

/**
 * 只发 Range: bytes=0-1 的请求探一下这是不是媒体流。
 * 很多站点拒绝 HEAD，所以用 GET + 立刻断流。
 */
function probeMedia(url, referer) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return resolve(null);
    }
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const headers = {
      'User-Agent': BROWSER_UA,
      'Accept': '*/*',
      'Range': 'bytes=0-1'
    };
    if (referer) headers.Referer = referer;

    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };

    const req = lib.request(parsed, { method: 'GET', headers }, (res) => {
      const status = res.statusCode || 0;
      const type = String(res.headers['content-type'] || '').toLowerCase();
      res.destroy();
      if (status >= 400) return done({ ok: false, status, type });
      const isMedia = /^(video|audio)\//.test(type)
        || /mpegurl|dash\+xml|octet-stream/.test(type)
        || status === 206;
      done({ ok: isMedia, status, type });
    });

    req.setTimeout(PROBE_TIMEOUT, () => {
      req.destroy();
      done(null);
    });
    req.on('error', () => done(null));
    req.end();
  });
}

function safeDecodeURIComponent(input) {
  try {
    return decodeURIComponent(String(input || ''));
  } catch (err) {
    return String(input || '');
  }
}

/** 从某个 { 开始做括号配对，取出完整的 JS/JSON 对象字面量 */
function readJsObject(html, startIdx) {
  let depth = 0;
  let inStr = null;
  let escaped = false;
  for (let i = startIdx; i < html.length; i += 1) {
    const ch = html[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(startIdx, i + 1);
    }
  }
  return '';
}

/**
 * 苹果 CMS（MacCMS）系影视站的播放地址解密
 *   encrypt=0 明文 / encrypt=1 unescape / encrypt=2 base64(+unescape) / encrypt=3 自定义
 * 解不出来就返回空串，让后面的通用流程继续试。
 */
function decodeMacUrl(raw, encrypt) {
  const src = String(raw || '').trim();
  if (!src) return '';

  const candidates = [];
  candidates.push(safeDecodeURIComponent(src));
  if (Number(encrypt) === 2 || Number(encrypt) === 3 || !/^https?:/i.test(src)) {
    try {
      const b64 = Buffer.from(src, 'base64').toString('utf8');
      candidates.push(b64);
      candidates.push(safeDecodeURIComponent(b64));
    } catch (err) {
      // base64 失败就算了
    }
  }
  candidates.push(src);

  for (const item of candidates) {
    const text = String(item || '').trim();
    if (/^https?:\/\//i.test(text)) return text;
    if (/^\/\//.test(text)) return 'https:' + text;
  }
  return '';
}

/**
 * 从页面里抠出 player_xxxx 配置（苹果 CMS 的播放器把地址直接写在 JSON 里）
 * 返回 { url, title, cover, from, encrypt } 或 null
 */
function extractMacPlayer(html, base) {
  const re = /(?:var\s+|window\.)?player_[A-Za-z0-9_]*\s*=\s*\{/g;
  let m;
  while ((m = re.exec(html))) {
    const start = m.index + m[0].length - 1;
    const body = readJsObject(html, start);
    if (!body) continue;

    let config = null;
    try {
      config = JSON.parse(body);
    } catch (err) {
      // 有些站沿用旧写法（单引号、裸 key），用正则兜底取 url
      const looseUrl = (body.match(/["']url["']\s*:\s*["']([^"']+)["']/i) || [])[1];
      const looseEnc = (body.match(/["']encrypt["']\s*:\s*(\d+)/i) || [])[1];
      if (looseUrl) config = { url: looseUrl, encrypt: looseEnc };
    }
    if (!config || !config.url) continue;

    const decoded = decodeMacUrl(config.url, config.encrypt);
    if (!decoded) continue;

    const vod = config.vod_data || {};
    return {
      url: absolutize(decoded, base),
      encrypt: Number(config.encrypt || 0),
      from: config.from || '',
      title: vod.vod_name ? String(vod.vod_name).slice(0, 120) : '',
      cover: vod.vod_pic ? absolutize(String(vod.vod_pic).replace(/^mac:\/\//, 'https://'), base) : ''
    };
  }
  return null;
}

/**
 * 影视站的剧集详情页本身没有视频，只有一个播放列表。
 * 这里抓第一个播放页（/play/1/1.html 这类），让用户粘详情页也能直接看第一集。
 */
function findPlayPageUrl(html, pageUrl) {
  let base;
  try {
    base = new URL(pageUrl);
  } catch (err) {
    return '';
  }
  const res = [
    /href\s*=\s*["']([^"']*\/play\/\d+\/\d+\.html[^"']*)["']/gi,
    /href\s*=\s*["']([^"']*\/play\/[^"']*\d+\.html[^"']*)["']/gi
  ];
  for (const re of res) {
    let m;
    while ((m = re.exec(html))) {
      const abs = absolutize(m[1], pageUrl);
      if (!abs) continue;
      let parsed;
      try {
        parsed = new URL(abs);
      } catch (err) {
        continue;
      }
      // 只认同站，避免跳到广告或外链
      if (parsed.hostname !== base.hostname) continue;
      if (parsed.pathname === base.pathname) continue;
      return abs;
    }
  }
  return '';
}

function buildMetaMap(html) {
  const map = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const key = (tag.match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const content = (tag.match(/content\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (key && content) map[key.toLowerCase()] = content;
  }
  return map;
}

function extractTitle(html, metaMap) {
  const fromMeta = metaMap['og:title'] || metaMap['twitter:title'] || '';
  if (fromMeta) return decodeEntities(fromMeta).slice(0, 120);
  const m = html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  if (m) return decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 120);
  return '';
}

function extractCover(metaMap, base) {
  const raw = metaMap['og:image'] || metaMap['twitter:image'] || '';
  return raw ? absolutize(raw, base) : '';
}

/** 从网页里按可靠度从高到低收集候选媒体地址 */
function extractCandidates(html, base) {
  const seen = new Set();
  const list = [];
  const push = (raw, hint) => {
    if (!raw) return;
    const abs = absolutize(raw, base);
    if (!abs || !/^https?:/i.test(abs)) return;
    if (IMAGE_EXT_RE.test(abs)) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    list.push({ url: abs, hint });
  };

  const metaMap = buildMetaMap(html);

  // 1. og:video / twitter:player:stream —— 站点自己声明的播放地址，最准
  push(metaMap['og:video:secure_url'], 'og:video');
  push(metaMap['og:video:url'], 'og:video');
  push(metaMap['og:video'], 'og:video');
  push(metaMap['twitter:player:stream'], 'twitter');

  // 2. <video src> / <source src>
  const tagRe = /<(?:video|source)\b[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(html))) {
    const src = m[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (src && src[1]) push(src[1], 'video-tag');
  }

  // 2.5 <embed src> / <object data>：老式播放器
  const embedRe = /<(?:embed|object)\b[^>]*>/gi;
  while ((m = embedRe.exec(html))) {
    const src = m[0].match(/\b(?:src|data)\s*=\s*["']([^"']+)["']/i);
    if (src && src[1]) push(src[1], 'embed-tag');
  }

  // 3. JSON-LD 里的 contentUrl
  const jsonRe = /"contentUrl"\s*:\s*"([^"]+)"/gi;
  while ((m = jsonRe.exec(html))) push(m[1], 'jsonld');

  // 4. 兜底：正文里裸露的 m3u8 / mp4 地址
  const rawRe = /((?:https?:)?\/\/[^\s"'<>\\)]+?\.(?:m3u8|mp4)(?:\?[^\s"'<>\\)]*)?)/gi;
  while ((m = rawRe.exec(html))) push(m[1], 'raw');

  // 5. 内嵌播放器 iframe：很多站的 <video> 在第 2 层页面里
  const iframes = [];
  const frameRe = /<iframe\b[^>]*>/gi;
  while ((m = frameRe.exec(html))) {
    const src = m[0].match(/\bsrc\s*=\s*["']([^"']+)["']/i);
    if (!src || !src[1]) continue;
    const abs = absolutize(src[1], base);
    if (!abs || !/^https?:/i.test(abs)) continue;
    if (/\.(?:css|js|png|jpe?g|gif|svg)(?:[?#]|$)/i.test(abs)) continue;
    if (!/player|video|play|embed|iframe|media|vod|live|stream|m3u8/i.test(abs)) continue;
    if (iframes.includes(abs)) continue;
    iframes.push(abs);
  }

  return { list, metaMap, iframes };
}

/** 已知平台的官方嵌入地址，取不到流时用 iframe 兜底 */
function matchEmbed(url) {
  const rules = [
    {
      name: 'YouTube',
      re: /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{6,})/i,
      build: (m) => `https://www.youtube.com/embed/${m[1]}?rel=0`
    },
    {
      name: 'Vimeo',
      re: /vimeo\.com\/(?:video\/)?(\d{6,})/i,
      build: (m) => `https://player.vimeo.com/video/${m[1]}`
    },
    {
      name: '腾讯视频',
      re: /v\.qq\.com\/x\/(?:cover\/[^/]+\/|page\/|m\/)?([A-Za-z0-9]{8,})\.html/i,
      build: (m) => `https://v.qq.com/txp/iframe/player.html?vid=${m[1]}`
    },
    {
      name: '优酷',
      re: /v\.youku\.com\/v_show\/id_([A-Za-z0-9=]+)\.html/i,
      build: (m) => `https://player.youku.com/embed/${m[1]}`
    },
    {
      name: 'AcFun',
      re: /acfun\.cn\/v\/(?:ac|aa)(\d+)/i,
      build: (m) => `https://www.acfun.cn/player/ac${m[1]}`
    }
  ];
  for (const rule of rules) {
    const m = url.match(rule.re);
    if (m) return { name: rule.name, embedUrl: rule.build(m) };
  }
  return null;
}

async function fetchPage(url) {
  const resp = await axios.get(url, {
    timeout: 12000,
    maxContentLength: PAGE_MAX_BYTES,
    maxRedirects: 5,
    responseType: 'text',
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6'
    },
    // 非 2xx 也把页面拿回来看看，有些站对爬虫返回 4xx 但内容还在
    validateStatus: (s) => s > 0 && s < 500
  });
  const html = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
  const finalUrl = (resp.request && resp.request.res && resp.request.res.responseUrl) || url;
  return { html, finalUrl };
}

function pickPlayable(candidates, referer) {
  // 直链扩展名的排前面（能直接播），其余保持原顺序
  const priority = (item) => {
    if (HLS_EXT_RE.test(item.url)) return 0;
    if (/\.(mp4|m4v|webm|ogv|mov)(?:[?#]|$)/i.test(item.url)) return 1;
    return 2;
  };
  return candidates
    .map((c, i) => ({ ...c, i, p: priority(c) }))
    .sort((a, b) => (a.p - b.p) || (a.i - b.i))
    .map((c) => c.url);
}

/**
 * 从候选里挑一个真能播的：先按扩展名排优先级，再逐个发 Range 请求确认
 */
async function findPlayable(list, referer) {
  const ordered = pickPlayable(list).slice(0, 6);
  for (const candidate of ordered) {
    // eslint-disable-next-line no-await-in-loop
    const probe = await probeMedia(candidate, referer);
    if (probe && probe.ok) return { url: candidate, referer, guess: false };
  }
  // 都探不通也把第一条给出去，让播放器自己再试（有些站只对浏览器侧放宽）
  if (ordered.length) return { url: ordered[0], referer, guess: true };
  return null;
}

/**
 * 主入口：输入任意链接，返回房间可直接使用的 video 对象
 */
/**
 * 这几个站在国内基本抓不到页面（或必走 DRM），直接给嵌入播放器，
 * 省掉 10 秒的抓取等待。
 */
function instantEmbed(url) {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch (err) {
    return null;
  }
  if (!/(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/i.test(host)) return null;
  const embed = matchEmbed(url);
  return embed ? buildEmbedResult(url, embed, '') : null;
}

async function resolveAny(rawInput, depth = 0) {
  let url = normalizeInput(rawInput);

  const fast = instantEmbed(url);
  if (fast) return fast;

  // ---------- B 站 ----------
  if (isBilibiliHost(url)) {
    url = await expandShortLink(url);
    const data = await resolveBilibili(url);
    return {
      ...data,
      kind: 'direct',
      isHls: false,
      referer: 'https://www.bilibili.com/',
      needProxy: true,
      source: 'bilibili',
      sourceHost: 'bilibili.com'
    };
  }

  // ---------- 直链 ----------
  if (DIRECT_EXT_RE.test(url)) {
    const isHls = HLS_EXT_RE.test(url);
    const parsed = new URL(url);
    const referer = `${parsed.protocol}//${parsed.host}/`;
    return {
      title: decodeURIComponent(parsed.pathname.split('/').pop() || '') || parsed.hostname,
      videoUrl: url,
      kind: 'direct',
      isHls,
      referer,
      needProxy: true,
      source: 'direct',
      sourceHost: parsed.hostname
    };
  }

  // ---------- 任意网页 ----------
  let page = null;
  try {
    page = await fetchPage(url);
  } catch (err) {
    // 页面拿不到，若是已知平台还能用嵌入兜底
    const embed = matchEmbed(url);
    if (embed) return buildEmbedResult(url, embed, '');
    throw new Error('打不开这个网页（' + (err.message || '网络错误') + '），请检查链接或稍后重试');
  }

  const first = extractCandidates(page.html, page.finalUrl);
  const metaMap = first.metaMap;
  const title = extractTitle(page.html, metaMap) || new URL(url).hostname;
  const cover = extractCover(metaMap, page.finalUrl);

  // ---------- 苹果 CMS 播放页（影视站最常见的一种） ----------
  // 地址被塞在 player_xxxx 里，解出来通常就是真·m3u8，比满页面翻 <video> 准得多
  const mac = depth < 2 ? extractMacPlayer(page.html, page.finalUrl) : null;
  if (mac && mac.url && mac.url !== page.finalUrl) {
    if (DIRECT_EXT_RE.test(mac.url)) {
      const isHls = HLS_EXT_RE.test(mac.url);
      return {
        title: mac.title || title,
        cover: cover || mac.cover,
        videoUrl: mac.url,
        kind: 'direct',
        isHls,
        referer: page.finalUrl,
        needProxy: true,
        source: 'macplayer',
        sourceHost: new URL(page.finalUrl).hostname
      };
    }
    // 解出来的是另一个播放页（第三方解析接口 / 外站播放器）→ 再走一轮
    try {
      const sub = await resolveAny(mac.url, depth + 1);
      if (sub && sub.videoUrl) {
        return {
          ...sub,
          title: mac.title || sub.title || title,
          cover: sub.cover || cover || mac.cover,
          source: sub.source === 'direct' ? 'macplayer' : sub.source
        };
      }
    } catch (err) {
      // 解出来的地址打不开，落到下面的通用流程继续找
    }
  }

  let found = await findPlayable(first.list, page.finalUrl);

  // 本页没找到，就翻一层内嵌播放器（很多站的 <video> 在海一层 iframe 里）
  if ((!found || found.guess) && first.iframes.length) {
    for (const frameUrl of first.iframes.slice(0, 3)) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const sub = await fetchPage(frameUrl);
        // eslint-disable-next-line no-await-in-loop
        const subFound = await findPlayable(extractCandidates(sub.html, sub.finalUrl).list, sub.finalUrl);
        if (subFound && !subFound.guess) {
          found = subFound;
          break;
        }
        if (!found && subFound) found = subFound;
      } catch (err) {
        // 单个内嵌页打不开就算了，继续试下一个
      }
    }
  }

  if (found) {
    return {
      title,
      cover,
      videoUrl: found.url,
      kind: 'direct',
      isHls: HLS_EXT_RE.test(found.url),
      referer: found.referer,
      needProxy: true,
      source: found.guess ? 'page-guess' : 'page',
      sourceHost: new URL(page.finalUrl).hostname
    };
  }

  // ---------- 剧集详情页 → 自动进第一集 ----------
  if (depth < 2) {
    const playPage = findPlayPageUrl(page.html, page.finalUrl);
    if (playPage && playPage !== page.finalUrl) {
      try {
        const sub = await resolveAny(playPage, depth + 1);
        if (sub && sub.videoUrl) {
          return {
            ...sub,
            title: sub.title || title,
            cover: sub.cover || cover
          };
        }
      } catch (err) {
        // 第一集打不开就走后面的兜底
      }
    }
  }

  // ---------- 嵌入兜底 ----------
  const embed = matchEmbed(url);
  if (embed) return buildEmbedResult(url, embed, title);

  // og:video 声明成 text/html 的，其实就是个播放器页面
  const ogVideo = metaMap['og:video:url'] || metaMap['og:video'] || '';
  if (ogVideo && /text\/html/i.test(metaMap['og:video:type'] || '')) {
    const embedUrl = absolutize(ogVideo, page.finalUrl);
    if (embedUrl) return buildEmbedResult(url, { name: new URL(url).hostname, embedUrl }, title);
  }

  throw new Error('这个页面里没找到能直接播放的视频地址（可能加了防盗链、需要登录或用了 DRM 加密）。可以试试直接粘贴视频文件的 .mp4 / .m3u8 链接');
}

function buildEmbedResult(url, embed, title) {
  return {
    title: title || embed.name || '网页视频',
    videoUrl: embed.embedUrl,
    embedUrl: embed.embedUrl,
    kind: 'embed',
    isHls: false,
    referer: url,
    // 嵌入地址本身就是要浏览器直接加载的页面，不能再套一层代理
    needProxy: false,
    source: 'embed',
    sourceHost: new URL(url).hostname
  };
}

module.exports = {
  resolveAny,
  normalizeInput,
  extractCandidates,
  matchEmbed,
  DIRECT_EXT_RE,
  HLS_EXT_RE
};
