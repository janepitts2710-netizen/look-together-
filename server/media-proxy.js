const http = require('http');
const https = require('https');
const { UA } = require('./bilibili');

/**
 * 通用媒体代理
 *
 * 用途：把任意站点的视频流经由本站转发，解决两类问题
 *   1) Referer 防盗链：浏览器直接从别的站加载视频会被 403
 *   2) m3u8 相对路径：分片地址直接给浏览器，相对路径会解析到本站而 404
 *
 * 安全边界：
 *   - 只允许 http/https 公网地址，拒绝内网/回环（防 SSRF）
 *   - 每一次重定向都重新校验目标
 *   - 拒绝 text/html，避免被当成「任意网页代理」拿去转发钓鱼页面
 */

const MAX_REDIRECTS = 5;
const PLAYLIST_MAX_BYTES = 4 * 1024 * 1024;

const SAFE_UPSTREAM_HEADERS = [
  'content-type', 'content-length', 'content-range', 'accept-ranges',
  'last-modified', 'etag', 'cache-control', 'expires'
];

function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.local')) return true;
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 0 || a === 10 || a === 127
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254)
    || (a === 100 && b >= 64 && b <= 127);
}

function isPublicHttpUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (err) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return !isPrivateHost(parsed.hostname);
}

function sendUpstream(res, upstreamRes) {
  for (const key of SAFE_UPSTREAM_HEADERS) {
    const value = upstreamRes.headers[key];
    if (value !== undefined) res.setHeader(key, value);
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.writeHead(upstreamRes.statusCode || 200);
}

function requestStream(targetUrl, headers, redirectCount, callback) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (err) {
    return callback(new Error('无效的播放地址'));
  }
  if (!isPublicHttpUrl(targetUrl)) {
    return callback(new Error('只允许代理公网地址'));
  }

  const lib = parsed.protocol === 'https:' ? https : http;
  const req = lib.request(parsed, { method: 'GET', headers }, (upstreamRes) => {
    const status = upstreamRes.statusCode || 0;
    const location = upstreamRes.headers.location;

    if ([301, 302, 303, 307, 308].includes(status) && location) {
      upstreamRes.resume();
      if (redirectCount >= MAX_REDIRECTS) return callback(new Error('代理重定向次数过多'));
      let nextUrl;
      try {
        nextUrl = new URL(location, targetUrl).toString();
      } catch (err) {
        return callback(new Error('代理跳转地址无效'));
      }
      // 每一跳都校验，避免先跳到公网再跳回内网
      if (!isPublicHttpUrl(nextUrl)) return callback(new Error('代理跳转到了不允许的地址'));
      return requestStream(nextUrl, headers, redirectCount + 1, callback);
    }

    callback(null, upstreamRes, targetUrl);
  });

  req.on('error', (err) => callback(err));
  req.end();
}

function proxyUrlFor(absoluteUrl, referer) {
  const ref = referer ? `&ref=${encodeURIComponent(referer)}` : '';
  return `/api/vproxy?url=${encodeURIComponent(absoluteUrl)}${ref}`;
}

/** 把 m3u8 里的分片/密钥/子列表地址换成走代理的地址 */
function rewritePlaylist(text, baseUrl, referer) {
  const abs = (raw) => {
    try {
      return new URL(raw, baseUrl).toString();
    } catch (err) {
      return '';
    }
  };

  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith('#')) {
      // #EXT-X-KEY / #EXT-X-MAP / #EXT-X-MEDIA 里的 URI="..."
      out.push(trimmed.replace(/URI="([^"]+)"/g, (whole, uri) => {
        const absolute = abs(uri);
        return absolute ? `URI="${proxyUrlFor(absolute, referer)}"` : whole;
      }));
      continue;
    }
    const absolute = abs(trimmed);
    out.push(absolute ? proxyUrlFor(absolute, referer) : trimmed);
  }
  return out.join('\n');
}

function isPlaylist(targetUrl, upstreamRes) {
  const type = String(upstreamRes.headers['content-type'] || '').toLowerCase();
  if (/mpegurl/.test(type)) return true;
  return /\.m3u8(?:[?#]|$)/i.test(targetUrl);
}

function collectBody(upstreamRes, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    upstreamRes.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        upstreamRes.destroy();
        return reject(new Error('播放列表过大'));
      }
      chunks.push(chunk);
    });
    upstreamRes.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    upstreamRes.on('error', reject);
  });
}

/**
 * 挂到 express 上：app.get('/api/vproxy', handler)
 */
function createHandler({ rateLimit }) {
  return [
    rateLimit ? rateLimit(600) : (req, res, next) => next(),
    async (req, res) => {
      const targetUrl = String(req.query.url || '');
      if (!targetUrl) return res.status(400).json({ error: '缺少 url 参数' });
      if (!isPublicHttpUrl(targetUrl)) return res.status(403).json({ error: '只允许代理公网视频地址' });

      // 请求时带哪个 Referer：用解析时记录的源页面，解决绝大多数防盗链
      let referer = String(req.query.ref || '');
      if (referer && !isPublicHttpUrl(referer)) referer = '';

      const headers = {
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      };
      if (referer) {
        headers.Referer = referer;
        try {
          headers.Origin = new URL(referer).origin;
        } catch (err) {
          // 忽略
        }
      }
      if (req.headers.range) headers.Range = req.headers.range;

      requestStream(targetUrl, headers, 0, async (err, upstreamRes, finalUrl) => {
        if (err) {
          if (!res.headersSent) res.status(502).json({ error: '代理播放失败：' + err.message });
          else res.end();
          return;
        }

        // 少数站看到外来的 Referer/Origin 反而会拒（403），去掉这两个头再来一次
        const denied = upstreamRes.statusCode === 401 || upstreamRes.statusCode === 403;
        if (denied && (headers.Referer || headers.Origin)) {
          upstreamRes.resume();
          const cleanHeaders = { ...headers };
          delete cleanHeaders.Referer;
          delete cleanHeaders.Origin;
          requestStream(targetUrl, cleanHeaders, 0, async (err2, retryRes, retryUrl) => {
            if (err2 || !retryRes) {
              if (!res.headersSent) res.status(502).json({ error: '代理播放失败：' + (err2 ? err2.message : '无响应') });
              return;
            }
            await pipeUpstream(res, retryRes, retryUrl, referer);
          });
          return;
        }

        await pipeUpstream(res, upstreamRes, finalUrl, referer);
      });
    }
  ];
}

/** 把上游响应转发给浏览器；m3u8 要先把里面的地址改写成走代理的地址 */
async function pipeUpstream(res, upstreamRes, finalUrl, referer) {
  const type = String(upstreamRes.headers['content-type'] || '').toLowerCase();
  if (/^text\/html/.test(type)) {
    upstreamRes.destroy();
    if (!res.headersSent) res.status(415).json({ error: '这个地址是个网页，不是视频流' });
    return;
  }

  if (isPlaylist(finalUrl, upstreamRes)) {
    try {
      const body = await collectBody(upstreamRes, PLAYLIST_MAX_BYTES);
      const rewritten = rewritePlaylist(body, finalUrl, referer);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.status(200).send(rewritten);
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: '播放列表读取失败：' + e.message });
    }
    return;
  }

  sendUpstream(res, upstreamRes);
  upstreamRes.pipe(res);
  upstreamRes.on('error', () => res.end());
}

module.exports = {
  createHandler,
  rewritePlaylist,
  isPublicHttpUrl,
  isPrivateHost
};
