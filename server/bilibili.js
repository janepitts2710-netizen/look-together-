const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';

function extractBvid(url) {
  const match = String(url || '').match(/BV[0-9A-Za-z]+/);
  if (!match) {
    throw new Error('链接中没有找到 BV 号，请检查链接格式');
  }
  return match[0];
}

/**
 * 解析 B 站免费视频
 * 返回: { bvid, cid, title, cover, videoUrl, isBili }
 */
async function resolveBilibili(url) {
  const bvid = extractBvid(url);

  // 1. 获取视频信息和 cid
  let infoResp;
  try {
    infoResp = await axios.get('https://api.bilibili.com/x/web-interface/view', {
      params: { bvid },
      headers: {
        'User-Agent': UA,
        'Referer': REFERER
      },
      timeout: 10000
    });
  } catch (err) {
    throw new Error('无法访问 B 站接口，请检查网络或稍后重试');
  }

  if (!infoResp.data || infoResp.data.code !== 0) {
    const msg = infoResp.data && infoResp.data.message ? infoResp.data.message : '获取视频信息失败';
    throw new Error(`B 站返回错误：${msg}`);
  }

  const info = infoResp.data.data;
  const cid = info.cid;
  if (!cid) {
    throw new Error('该视频没有 cid，可能已被删除或仅限登录观看');
  }

  // 2. 获取第一 P 播放地址（qn=64 为 720P，不解析大会员/付费清晰度）
  const videoUrl = await resolveBiliPlayUrl(bvid, cid, 64);
  // 观众端再取一个 480P 地址：B 站防盗链浏览器不能直连，只能走代理；
  // 观众用低码率能显著降低隧道带宽，房主仍用 720P。
  let videoUrlLow = '';
  try {
    const low = await resolveBiliPlayUrl(bvid, cid, 32);
    if (low && low !== videoUrl) videoUrlLow = low;
  } catch (e) { /* 没有 480P 就沿用 720P */ }

  const pages = (info.pages || []).map((p) => ({
    page: p.page || 1,
    cid: p.cid,
    part: p.part || `P${p.page || 1}`,
    duration: p.duration || 0
  }));

  return {
    bvid,
    cid,
    title: info.title || 'B站视频',
    cover: info.pic || '',
    videoUrl,
    videoUrlLow,
    isBili: true,
    pages
  };
}

/**
 * 获取 B 站某个分 P 的播放地址
 * 返回: { videoUrl }
 */
async function resolveBiliPlayUrl(bvid, cid, qn) {
  let playResp;
  try {
    playResp = await axios.get('https://api.bilibili.com/x/player/playurl', {
      params: {
        bvid,
        cid,
        fnval: 0,
        qn: qn || 64
      },
      headers: {
        'User-Agent': UA,
        'Referer': REFERER
      },
      timeout: 10000
    });
  } catch (err) {
    throw new Error('无法获取播放地址，请检查网络或稍后重试');
  }

  if (!playResp.data || playResp.data.code !== 0) {
    const msg = playResp.data && playResp.data.message ? playResp.data.message : '获取播放地址失败';
    throw new Error(`B 站返回错误：${msg}`);
  }

  const playData = playResp.data.data || {};
  const durl = playData.durl || [];
  if (!durl.length) {
    throw new Error('该视频可能包含大会员/付费/登录限定内容，暂不支持解析');
  }

  return durl[0].url;
}

module.exports = {
  resolveBilibili,
  resolveBiliPlayUrl,
  extractBvid,
  UA,
  REFERER
};
