'use strict';
/**
 * 零依赖的静态文件服务（给 H5 构建产物用）
 *
 * 解决两个「本机快、手机慢」的核心问题：
 *  1. 没有压缩：main.js 原始 291KB，每次进站手机都要完整下一遍。
 *     这里按 Accept-Encoding 协商 brotli / gzip，体积压到 1/4 左右，压缩结果按文件缓存，不重复算。
 *  2. 没有缓存头：express.static 默认 max-age=0，每次刷新所有资源都要回源验证。
 *     这里给带 hash 的 /assets/ 加一年 immutable 强缓存，手机第二次进站几乎不下载东西。
 *
 * 另外顺手补齐 ETag / Last-Modified / Vary / nosniff，并支持 HEAD 与 304。
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const zlib = require('zlib');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'text/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8'
};

// 只压缩文本类资源；图片/字体/视频本身已是压缩格式，再压会变大
const COMPRESSIBLE = new Set([
  '.html', '.htm', '.js', '.mjs', '.css', '.json', '.svg',
  '.txt', '.map', '.webmanifest', '.xml', '.wasm'
]);

const MIN_COMPRESS = 1024;            // 小于 1KB 压缩收益太低
const MAX_COMPRESS = 8 * 1024 * 1024; // 大文件不占内存

// filePath -> { mtimeMs, size, gzip, br }
// 压缩结果常驻内存，第二次请求直接发，不再跑 zlib
const encodedCache = new Map();
let cachedBytes = 0;

function runCompress(buf, enc) {
  if (enc === 'br') {
    return zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length
      }
    });
  }
  return zlib.gzipSync(buf, { level: 6 });
}

function getEncoded(filePath, stat, enc) {
  let entry = encodedCache.get(filePath);
  if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
    entry = { mtimeMs: stat.mtimeMs, size: stat.size, gzip: null, br: null };
    encodedCache.set(filePath, entry);
  }
  if (entry[enc]) return entry[enc];

  let out;
  try {
    out = runCompress(fs.readFileSync(filePath), enc);
  } catch (e) {
    return null;
  }
  entry[enc] = out;
  cachedBytes += out.length;

  // 粗略上限，避免长期跑下来吃太多内存（构建产物总共也就几 MB）
  if (cachedBytes > 48 * 1024 * 1024) {
    encodedCache.clear();
    cachedBytes = 0;
  }
  return out;
}

function makeEtag(stat) {
  return '"' + stat.size.toString(36) + '-' + Math.floor(stat.mtimeMs).toString(36) + '"';
}

function etagMatches(header, etag) {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((v) => v.trim().replace(/^W\//, '') === etag);
}

/**
 * @param {string} root 静态目录
 * @param {{ immutableDir?: string, immutableMaxAge?: number, assetMaxAge?: number }} [options]
 *   immutableDir 带内容 hash 的子目录（默认 /assets/），可长期强缓存
 */
function serveStaticH5(root, options) {
  const opts = options || {};
  const rootDir = path.resolve(root);
  const indexFile = opts.index || 'index.html';
  // 构建产物里 /assets/ 下的文件名都带 hash，内容一变文件名就变，可以放心缓存一年
  const immutablePrefix = opts.immutablePrefix || path.join(rootDir, 'assets') + path.sep;
  const immutableMaxAge = opts.immutableMaxAge || 31536000; // 1 年
  const assetMaxAge = opts.assetMaxAge || 86400;           // 其余静态资源 1 天

  return async function serveH5(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    // 带 Range 的请求（视频拖动）不在这个目录里，直接放过
    if (req.headers.range) return next();

    let urlPath;
    try {
      urlPath = decodeURIComponent(req.url.split('?')[0] || '/');
    } catch (e) {
      return next();
    }
    if (urlPath.indexOf('\0') >= 0) return next();

    let relPath = urlPath;
    const hadSlash = relPath.endsWith('/');
    if (hadSlash) relPath += indexFile;

    let filePath = path.join(rootDir, path.normalize(relPath));
    // 防目录穿越
    if (filePath !== rootDir && !filePath.startsWith(rootDir + path.sep)) return next();

    let stat;
    try {
      stat = await fsp.stat(filePath);
      if (stat.isDirectory()) {
        // /foo -> /foo/index.html（顺便让相对路径资源仍然可用）
        filePath = path.join(filePath, indexFile);
        stat = await fsp.stat(filePath);
      }
    } catch (e) {
      return next();
    }
    if (!stat.isFile()) return next();

    try {
      await respond(req, res, filePath, stat);
    } catch (e) {
      // 已经发了一半就只能断开，未发则交给后面的兜底
      if (res.headersSent) {
        try { res.destroy(); } catch (_) { /* ignore */ }
      } else {
        next();
      }
    }
  };

  async function respond(req, res, filePath, stat) {
    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === '.html' || ext === '.htm';
    const etag = makeEtag(stat);

    // 缓存策略：HTML 每次校验（内容变了立刻生效），带 hash 的资源一年不动
    let cacheControl;
    if (isHtml) {
      // 手机浏览器（尤其 QQ / 微信内置）对 no-cache 也可能整页缓存起来不重载，
      // 导致改了前端用户还跑旧代码。首页很小，直接 no-store 最省心。
      cacheControl = 'no-store, no-cache, must-revalidate';
    } else if (filePath.startsWith(immutablePrefix)) {
      cacheControl = 'public, max-age=' + immutableMaxAge + ', immutable';
    } else {
      cacheControl = 'public, max-age=' + assetMaxAge;
    }

    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    res.setHeader('Cache-Control', cacheControl);
    res.setHeader('Vary', 'Accept-Encoding');

    // 条件请求命中：只回 304，手机上第二次进站几乎不传数据
    const ims = req.headers['if-none-match'];
    if (ims && etagMatches(ims, etag)) {
      res.statusCode = 304;
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Length');
      return res.end();
    }

    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    const accept = String(req.headers['accept-encoding'] || '');
    const canCompress =
      COMPRESSIBLE.has(ext) && stat.size >= MIN_COMPRESS && stat.size <= MAX_COMPRESS;

    let enc = null;
    if (canCompress) {
      // brotli 比 gzip 再小 15% 左右，现代手机浏览器都支持
      if (typeof zlib.brotliCompressSync === 'function' && /\bbr\b/.test(accept)) enc = 'br';
      else if (/\bgzip\b/.test(accept)) enc = 'gzip';
    }

    if (enc) {
      const body = getEncoded(filePath, stat, enc);
      if (body) {
        res.setHeader('Content-Encoding', enc === 'br' ? 'br' : 'gzip');
        res.setHeader('Content-Length', String(body.length));
        if (req.method === 'HEAD') return res.end();
        return res.end(body);
      }
    }

    // 不可压缩或压缩失败：直接流式发原文件
    res.setHeader('Content-Length', String(stat.size));
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      try { res.destroy(); } catch (_) { /* ignore */ }
    });
    stream.pipe(res);
  }
}

module.exports = serveStaticH5;
