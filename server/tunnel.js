#!/usr/bin/env node
/**
 * 公网穿透（异地扫码）
 *
 * 作用：把本机 PORT 映射成一个公网地址，这样手机不连同一个 Wi-Fi、人在外地，
 * 用流量也一样能扫码进房。
 *
 * 两条通道，自动选择：
 *   1) ngrok —— 首选，历史记录里之前一直正常用的就是它，实测带宽比 Cloudflare 快
 *   2) Cloudflare 快速隧道（免注册）—— 备选，国内线路经常只有几十 KB/s
 *   3) cpolar（国内节点）—— 最后兜底，免费版带宽也小
 *
 * 为什么优先 ngrok：用户前几天的正常体验走的就是 ngrok；实测本机到隧道下载
 * DPlayer 304KB：ngrok 约 389KB/s，Cloudflare 约 82KB/s，差距接近 5 倍。
 * ngrok 免费版首次访问会有一个「Visit Site」提示页，点一次即可。
 *
 * 配置方式（三选一）：
 *   - server/data/cpolar-token.txt 里放一行 token（一键启动会自动引导写入）
 *   - 环境变量 CPOLAR_TOKEN
 *   - 本机已装 cpolar 并执行过 `cpolar authtoken xxx`（读 ~/.cpolar/cpolar.yml）
 *
 * 其它环境变量：
 *   TUNNEL_PROVIDER=auto|cpolar|cloudflare   强制指定通道（默认 auto）
 *   CPOLAR_PATH / CLOUDFLARED_PATH           自定义二进制路径
 *   TUNNEL_QUIET=1                           只输出关键信息
 *   PUBLIC_URL=https://xxx                   已有固定公网地址，直接跳过打隧道
 */
'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const OUT_FILE = path.join(DATA_DIR, 'tunnel.json');
const TOKEN_FILE = path.join(DATA_DIR, 'cpolar-token.txt');
const QUIET = process.env.TUNNEL_QUIET === '1';
const ADMIN_ON = process.env.ENABLE_ADMIN !== '0';
const FORCE = String(process.env.TUNNEL_PROVIDER || 'auto').toLowerCase();
const DISABLE_NGROK = process.env.DISABLE_NGROK === '1';

// 手填了固定域名就不用打隧道了
if (String(process.env.PUBLIC_URL || '').trim()) {
  log('[tunnel] 已配置 PUBLIC_URL，跳过内网穿透。');
  process.exit(0);
}

function log(msg) {
  if (QUIET) return;
  console.log(msg);
}

// ---------------------------------------------------------------- 二进制定位

function exeNames(base) {
  return process.platform === 'win32' ? [base + '.exe', base] : [base, base + '.exe'];
}

function firstExisting(list) {
  for (const p of list) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (e) {
      /* 权限问题，继续找 */
    }
  }
  return '';
}

function findCpolar() {
  const dirs = [
    process.env.CPOLAR_PATH,
    path.join(__dirname, '..', 'tunnel'),
    path.join(__dirname, 'bin'),
    'C:\\Program Files\\cpolar',
    'C:\\Program Files (x86)\\cpolar',
    path.join(process.env.LOCALAPPDATA || '', 'cpolar'),
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin'
  ].filter(Boolean);

  const direct = [];
  for (const d of dirs) {
    for (const n of exeNames('cpolar')) direct.push(path.join(d, n));
  }
  const found = firstExisting(direct);
  if (found) return found;
  // 装过一键包但装在自定义目录时，兜底交给 PATH
  return '';
}

function findCloudflared() {
  const dirs = [
    process.env.CLOUDFLARED_PATH,
    path.join(__dirname, '..', 'tunnel'),
    path.join(__dirname, 'bin'),
    'C:\\Program Files (x86)\\cloudflared',
    'C:\\Program Files\\cloudflared',
    path.join(process.env.LOCALAPPDATA || '', 'cloudflared'),
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin'
  ].filter(Boolean);

  const direct = [];
  for (const d of dirs) {
    for (const n of exeNames('cloudflared')) direct.push(path.join(d, n));
  }
  const found = firstExisting(direct);
  if (found) return found;
  return process.platform === 'win32' ? '' : '';
}

function findNgrok() {
  const dirs = [
    process.env.NGROK_PATH,
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps'),
    path.join(process.env.LOCALAPPDATA || '', 'ngrok'),
    'C:\\Program Files\\ngrok',
    '/usr/local/bin',
    '/usr/bin',
    '/opt/homebrew/bin'
  ].filter(Boolean);

  const direct = [];
  for (const d of dirs) {
    for (const n of exeNames('ngrok')) direct.push(path.join(d, n));
  }
  const found = firstExisting(direct);
  if (found) return found;

  // Windows 的 Microsoft Store 版 ngrok 是 WindowsApps 别名，
  // Node 的 fs.existsSync 看不到它，但 spawn 能执行；用 where 兜底。
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(cmd, ['ngrok'], { encoding: 'utf8' });
    const hit = String(out || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (hit) return hit;
  } catch (e) {
    /* 没装 */
  }
  return '';
}
// ---------------------------------------------------------------- token 读取

function readTokenFile() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return '';
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8');
    // 允许带注释、空行，也允许用户直接粘贴整段 yml
    const line = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith('#'));
    if (!line) return '';
    const m = line.match(/authtoken\s*[:=]\s*["']?([A-Za-z0-9_\-\.]+)/i);
    return (m ? m[1] : line).trim();
  } catch (e) {
    return '';
  }
}

function hasCpolarConfig() {
  try {
    const f = path.join(os.homedir(), '.cpolar', 'cpolar.yml');
    if (!fs.existsSync(f)) return false;
    return /authtoken\s*:\s*\S+/i.test(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    return false;
  }
}

function resolveCpolarToken() {
  return String(process.env.CPOLAR_TOKEN || '').trim() || readTokenFile();
}

// ---------------------------------------------------------------- 公共工具

function writeTunnelFile(url, pid, provider) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      OUT_FILE,
      JSON.stringify({ url, port: PORT, pid, provider, at: Date.now() }, null, 2),
      'utf8'
    );
  } catch (err) {
    console.warn('[tunnel] 写 tunnel.json 失败：' + err.message);
  }
}

function clearTunnelFile() {
  try {
    if (fs.existsSync(OUT_FILE)) fs.unlinkSync(OUT_FILE);
  } catch (e) {
    /* 文件被占用就算了，下次启动会覆盖 */
  }
}

const CF_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/gi;
// cpolar 免费域名国内是 .cpolar.cn，境外/备用是 .cpolar.top；都认
const CPOLAR_RE = /https:\/\/[a-z0-9][a-z0-9.-]*\.cpolar\.(?:cn|top|io|xyz)/gi;
const NGROK_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.ngrok(?:-free)?\.(?:app|dev|io)/gi;

function pickUrl(text, provider) {
  const re = provider === 'cpolar' ? CPOLAR_RE : provider === 'ngrok' ? NGROK_RE : CF_RE;
  re.lastIndex = 0;
  const m = text.match(re);
  if (!m || !m.length) return '';
  // cpolar 会同时打印 http 和 https 两条，只认 https（手机扫码要安全上下文）
  return m[0].replace(/\/+$/, '');
}

function banner(url, provider) {
  if (QUIET) return; // 由启动引导统一打印，避免重复
  const line = '='.repeat(58);
  console.log('');
  console.log(line);
  console.log(' 异地访问地址（手机不连 Wi-Fi、在外地也能扫）：');
  console.log('   ' + url);
  console.log('   通道：' + (provider === 'cpolar' ? 'cpolar 国内节点' : 'Cloudflare 隧道'));
  if (ADMIN_ON) console.log(' 后台管理：' + url + '/admin');
  console.log('');
  console.log(' 房间二维码会自动换成这个地址，直接扫即可。');
  console.log(' 地址每次重启都会变，关掉窗口即失效。');
  console.log(line);
  console.log('');
}

// ngrok 免费版是固定域名：上一次没退干净的 ngrok 会占着同一个 endpoint，
// 新进程会报 ERR_NGROK_334。启动前先清掉本机旧 ngrok（只清本机，不碰远端）。
let ngrokCleaned = false;
function cleanupStaleNgrok() {
  if (ngrokCleaned) return;
  ngrokCleaned = true;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/IM', 'ngrok.exe', '/F'], { stdio: 'ignore' });
    } else {
      execFileSync('pkill', ['-f', 'ngrok.*http'], { stdio: 'ignore' });
    }
    log('[tunnel] 已清理本机旧的 ngrok 进程。');
  } catch (e) {
    // 本来就没有旧进程，taskkill 返回非 0，忽略
  }
}
// ---------------------------------------------------------------- 运行状态

let current = null;   // 当前子进程
let currentProvider = '';
let gotUrl = false;
let connectTimer = null;
let stopping = false;
let retries = 0;
let cpolarFailedOnce = false;  // cpolar 失败过就别再反复试，直接降级
let cfFailedOnce = false;      // Cloudflare 失败过一次后，降到 cpolar 兜底
let ngrokFailedOnce = false;   // ngrok 失败过一次后，降到 Cloudflare
const MAX_RETRY = 6;

// ---------------------------------------------------------------- ngrok

function startNgrok() {
  const bin = findNgrok();
  if (!bin) {
    log('[tunnel] 没找到 ngrok，跳过旧通道。');
    return false;
  }

  log('[tunnel] 启动 ngrok 隧道 → http://127.0.0.1:' + PORT);
  let child;
  try {
    child = spawn(bin, ['http', String(PORT), '--log=stdout'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env }
    });
  } catch (e) {
    log('[tunnel] ngrok 启动失败：' + (e && e.message ? e.message : e));
    return false;
  }

  current = child;
  currentProvider = 'ngrok';
  gotUrl = false;

  const onChunk = (buf) => {
    const text = String(buf);
    if (!QUIET) {
      text
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => console.log('  [ngrok] ' + l));
    }
    if (gotUrl) return;
    const url = pickUrl(text, 'ngrok');
    if (!url) return;
    gotUrl = true;
    if (connectTimer) clearTimeout(connectTimer);
    writeTunnelFile(url, child.pid, 'ngrok');
    banner(url, 'ngrok');
  };

  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  child.on('error', (err) => {
    log('[tunnel] ngrok 启动失败：' + (err && err.message));
  });

  child.on('exit', (code) => {
    if (connectTimer) clearTimeout(connectTimer);
    if (stopping) return;
    const hadUrl = gotUrl;
    clearTunnelFile();
    current = null;
    gotUrl = false;
    if (!hadUrl) ngrokFailedOnce = true;
    scheduleNext(false);
  });

  connectTimer = setTimeout(() => {
    if (gotUrl || stopping) return;
    log('[tunnel] ngrok 20 秒未建立隧道，换 Cloudflare…');
    ngrokFailedOnce = true;
    try {
      child.kill();
    } catch (e) {
      /* 已退出 */
    }
  }, 20000);

  return true;
}
// ---------------------------------------------------------------- cpolar

function ensureCpolarToken(bin, token) {
  if (!token) return false;
  execFileSync(bin, ['authtoken', token], {
    stdio: 'ignore',
    timeout: 20000,
    windowsHide: true
  });
  return true;
}

function startCpolar() {
  const bin = findCpolar();
  if (!bin) return false;

  const token = resolveCpolarToken();
  if (!token && !hasCpolarConfig()) {
    log('[tunnel] 没找到 cpolar 的 authtoken，跳过国内通道。');
    return false;
  }

  if (token) {
    try {
      ensureCpolarToken(bin, token);
    } catch (e) {
      log('[tunnel] cpolar authtoken 写入失败：' + (e && e.message ? e.message : e));
      return false;
    }
  }

  log('[tunnel] 启动 cpolar（国内节点）→ http://127.0.0.1:' + PORT);

  // 关键：必须直连、不能走代理，且指定国内区域（默认会给 .top 域名，国内 DNS 解析不了）
  const cleanEnv = { ...process.env };
  delete cleanEnv.http_proxy;
  delete cleanEnv.https_proxy;
  delete cleanEnv.HTTP_PROXY;
  delete cleanEnv.HTTPS_PROXY;
  delete cleanEnv.ALL_PROXY;
  delete cleanEnv.all_proxy;

  let child;
  try {
    child = spawn(
      bin,
      ['http', String(PORT), '-log=stdout', '-log-level=info', '-region=cn'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: cleanEnv
      }
    );
  } catch (e) {
    log('[tunnel] cpolar 启动失败：' + (e && e.message ? e.message : e));
    return false;
  }

  current = child;
  currentProvider = 'cpolar';
  gotUrl = false;

  const onChunk = (buf) => {
    const text = String(buf);
    if (!QUIET) {
      text
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => console.log('  [cpolar] ' + l));
    } else {
      text
        .split(/\r?\n/)
        .filter((l) => /ERR|error|failed|invalid|auth/i.test(l))
        .forEach((l) => console.log('  [隧道] ' + l));
    }

    if (gotUrl) return;
    const url = pickUrl(text, 'cpolar');
    if (!url) return;
    gotUrl = true;
    if (connectTimer) clearTimeout(connectTimer);
    writeTunnelFile(url, child.pid, 'cpolar');
    banner(url, 'cpolar');
  };

  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  child.on('error', (err) => {
    log('[tunnel] cpolar 启动异常：' + (err && err.message));
  });

  child.on('exit', (code) => {
    if (connectTimer) clearTimeout(connectTimer);
    if (stopping) return;

    const wasRunning = gotUrl;
    clearTunnelFile();
    current = null;
    gotUrl = false;

    if (!wasRunning) {
      // 没拿到地址就退了 → 这条通道不通，立刻降级到 Cloudflare，不浪费用户时间
      cpolarFailedOnce = true;
      log('[tunnel] cpolar 没能建立隧道（code=' + code + '），改走 Cloudflare…');
      scheduleNext(true);
      return;
    }

    log('[tunnel] cpolar 连接断开（code=' + code + '），正在自动重连…');
    scheduleNext(false);
  });

  // 25 秒还没出地址就认为这条通道不通
  connectTimer = setTimeout(() => {
    if (gotUrl || stopping) return;
    log('[tunnel] cpolar 25 秒未建立隧道，改走 Cloudflare…');
    cpolarFailedOnce = true;
    try {
      child.kill();
    } catch (e) {
      /* 已退出 */
    }
  }, 25000);

  return true;
}

// ---------------------------------------------------------------- Cloudflare

function startCloudflare(protocol) {
  const bin = findCloudflared();
  if (!bin) {
    log('[tunnel] 找不到 cloudflared，异地访问不可用。');
    return false;
  }

  const proto = protocol || 'http2';
  log('[tunnel] 启动 Cloudflare 隧道（' + proto + '）→ http://127.0.0.1:' + PORT);

  const args = [
    'tunnel',
    '--url', 'http://127.0.0.1:' + PORT,
    '--no-autoupdate',
    '--protocol', proto,
    // 国内 IPv6 经常不可用，强制走 v4 避免卡在握手阶段
    '--edge-ip-version', '4'
  ];

  let child;
  try {
    child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    log('[tunnel] cloudflared 启动失败：' + (e && e.message ? e.message : e));
    return false;
  }

  current = child;
  currentProvider = 'cloudflare';
  gotUrl = false;

  const onChunk = (buf) => {
    const text = String(buf);
    if (!QUIET) {
      text
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((l) => console.log('  [cf] ' + l));
    } else {
      text
        .split(/\r?\n/)
        .filter((l) => /ERR|error|failed/i.test(l))
        .forEach((l) => console.log('  [隧道] ' + l));
    }

    if (gotUrl) return;
    const url = pickUrl(text, 'cloudflare');
    if (!url) return;
    gotUrl = true;
    if (connectTimer) clearTimeout(connectTimer);
    writeTunnelFile(url, child.pid, 'cloudflare');
    banner(url, 'cloudflare');
  };

  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);

  child.on('error', (err) => {
    if (err && err.code === 'ENOENT') {
      log('[tunnel] 找不到 cloudflared 可执行文件。');
      return;
    }
    log('[tunnel] cloudflared 启动失败：' + (err && err.message));
  });

  child.on('exit', (code) => {
    if (connectTimer) clearTimeout(connectTimer);
    if (stopping) return;
    const hadUrl = gotUrl;
    clearTunnelFile();
    current = null;
    gotUrl = false;
    if (hadUrl) {
      console.warn('[tunnel] 公网连接断开（code=' + code + '），正在自动重连…');
    } else {
      cfFailedOnce = true;
    }
    scheduleNext(false);
  });

  connectTimer = setTimeout(() => {
    if (gotUrl || stopping) return;
    log('[tunnel] Cloudflare ' + (proto === 'http2' ? 'HTTP/2' : 'QUIC') + ' 模式 30 秒未连上，换通道…');
    cfFailedOnce = true;
    try {
      child.kill();
    } catch (e) {
      /* 已退出 */
    }
  }, 30000);

  return true;
}

let cfProtoFlip = 0;

function scheduleNext(skipDelay) {
  if (stopping) return;
  retries += 1;
  if (retries > MAX_RETRY) {
    log('');
    log('[tunnel] 公网隧道连续 ' + MAX_RETRY + ' 次失败，异地扫码暂不可用。');
    log('        同一个 Wi-Fi 下仍然可以扫码；也可以换网络（如手机热点）再试。');
    log('');
    process.exit(1);
  }
  setTimeout(start, skipDelay ? 300 : 1500 * Math.min(retries, 4));
}

// ---------------------------------------------------------------- 启动入口

function start() {
  if (stopping) return;

  // 1) 先试用户之前一直在用的 ngrok（历史记录里最后一次手动隧道就是它）
  if ((!DISABLE_NGROK || FORCE === 'ngrok') && !ngrokFailedOnce && FORCE !== 'cloudflare' && FORCE !== 'cpolar') {
    cleanupStaleNgrok();
    if (startNgrok()) return;
    ngrokFailedOnce = true;
  }

  // 2) Cloudflare 兜底
  if (!cfFailedOnce && FORCE !== 'cpolar' && FORCE !== 'ngrok') {
    cfProtoFlip += 1;
    const proto = cfProtoFlip % 2 === 1 ? 'http2' : 'quic';
    if (startCloudflare(proto)) return;
    cfFailedOnce = true;
  }

  // 3) 最后 cpolar（国内节点）
  if (!cpolarFailedOnce && FORCE !== 'cloudflare' && FORCE !== 'ngrok') {
    if (startCpolar()) return;
    if (FORCE === 'cpolar') {
      log('[tunnel] 已强制使用 cpolar，但它不可用，请检查 token。');
    }
    cpolarFailedOnce = true;
  }

  log('[tunnel] 没有可用的穿透组件，异地扫码不可用。');
  process.exit(1);
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  log('\n[tunnel] 正在关闭隧道…');
  clearTunnelFile();
  try {
    if (current) current.kill();
  } catch (e) {
    /* 已退出 */
  }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);
process.on('exit', () => {
  if (!stopping) clearTunnelFile();
});

clearTunnelFile();
start();
