/**
 * 管理员认证
 *
 * - 密码：bcrypt（bcryptjs，纯 JS 实现，不需要编译原生模块）
 * - 会话：JWT（HS256），密钥首次启动时随机生成并写入数据库隐藏键 __jwt_secret
 * - 失效：改密码 / 禁用 / 改角色时 token_version + 1，旧 token 立即失效；
 *         主动退出会把 jti 放进内存黑名单（重启后清空，最长存活时间 = token TTL）
 * - 防爆破：同一 IP 或同一账号在窗口期内失败次数超限，直接锁定一段时间
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const BCRYPT_ROUNDS = 10;
const TOKEN_TTL_HOURS = Math.max(1, Number(process.env.ADMIN_TOKEN_TTL_HOURS) || 12);
const TOKEN_TTL_SECONDS = TOKEN_TTL_HOURS * 3600;

// jti 黑名单（只存内存，够用；生产可换 Redis）
const revokedJti = new Map(); // jti -> exp(ms)

function hashPassword(password) {
  return bcrypt.hashSync(String(password), BCRYPT_ROUNDS);
}

function verifyPassword(password, hash) {
  if (!hash) return false;
  try {
    return bcrypt.compareSync(String(password), hash);
  } catch (err) {
    return false;
  }
}

function passwordProblem(password) {
  const pwd = String(password || '');
  if (pwd.length < 8) return '密码至少 8 位';
  if (pwd.length > 72) return '密码不能超过 72 位';
  if (!/[a-zA-Z]/.test(pwd)) return '密码需要包含字母';
  if (!/\d/.test(pwd)) return '密码需要包含数字';
  return '';
}

function createAuth({ db }) {
  const secret = db.getSecret('__jwt_secret', () => crypto.randomBytes(48).toString('hex'));

  function signToken(admin) {
    const jti = crypto.randomBytes(12).toString('hex');
    const token = jwt.sign(
      {
        sub: String(admin.id),
        u: admin.username,
        role: admin.role,
        tv: admin.token_version,
        jti
      },
      secret,
      { expiresIn: TOKEN_TTL_SECONDS, issuer: 'look-admin' }
    );
    return { token, jti, expiresIn: TOKEN_TTL_SECONDS };
  }

  function revoke(jti, exp) {
    if (!jti) return;
    revokedJti.set(jti, (exp || Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS) * 1000);
    // 顺手清理过期项
    const now = Date.now();
    for (const [key, expireAt] of revokedJti) {
      if (expireAt < now) revokedJti.delete(key);
    }
  }

  function decodeHeader(req) {
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    // 兼容 cookie（后台默认用 localStorage，这里只是留个口子）
    if (req.cookies && req.cookies.admin_token) return req.cookies.admin_token;
    return '';
  }

  function authenticate(req, res, next) {
    const token = decodeHeader(req);
    if (!token) {
      return res.status(401).json({ error: '请先登录', code: 'NO_TOKEN' });
    }
    let payload;
    try {
      payload = jwt.verify(token, secret, { issuer: 'look-admin' });
    } catch (err) {
      const expired = err && err.name === 'TokenExpiredError';
      return res.status(401).json({ error: expired ? '登录已过期，请重新登录' : '登录状态无效', code: expired ? 'TOKEN_EXPIRED' : 'BAD_TOKEN' });
    }
    if (payload.jti && revokedJti.has(payload.jti)) {
      return res.status(401).json({ error: '登录已退出，请重新登录', code: 'TOKEN_REVOKED' });
    }
    const admin = db.getAdmin(payload.sub);
    if (!admin) {
      return res.status(401).json({ error: '管理员不存在', code: 'ADMIN_NOT_FOUND' });
    }
    if (admin.status !== 'active') {
      return res.status(403).json({ error: '账号已被禁用', code: 'ADMIN_DISABLED' });
    }
    if (Number(payload.tv) !== Number(admin.token_version)) {
      return res.status(401).json({ error: '密码或权限已变更，请重新登录', code: 'TOKEN_STALE' });
    }
    req.admin = db.publicAdmin(admin);
    req.adminRaw = admin;
    req.tokenPayload = payload;
    req.token = token;
    next();
  }

  function requireRole(...roles) {
    return (req, res, next) => {
      if (!req.admin) return res.status(401).json({ error: '请先登录' });
      if (!roles.includes(req.admin.role)) {
        return res.status(403).json({ error: '当前账号没有该操作权限' });
      }
      next();
    };
  }

  /**
   * 登录前的账号锁定检查
   * 返回 { locked, retryAfter, fails }
   */
  function checkLoginLock({ ip, username }) {
    const settings = db.getSettings();
    const windowMs = settings.loginLockMinutes * 60000;
    const since = Date.now() - windowMs;
    const { byIp, byUser } = db.countRecentLoginFails({ ip, username, since });
    const max = settings.loginMaxFails;
    const failed = Math.max(byIp, byUser);
    if (failed < max) return { locked: false, fails: failed };
    const last = db.latestFailAt({ ip, username, since });
    const retryAfter = Math.max(1, Math.ceil((last + windowMs - Date.now()) / 1000));
    return { locked: true, retryAfter, fails: failed };
  }

  /**
   * IP 白名单：配置为空表示不启用；启用后 /api/admin 只接受名单内的 IP
   * 支持精确匹配和简单通配（192.168.1.*）
   */
  function ipAllowed(ip) {
    const list = db.getSettings().adminIpWhitelist || [];
    if (!list.length) return true;
    const target = normalizeIp(ip);
    return list.some((rule) => {
      const r = normalizeIp(rule);
      if (!r) return false;
      if (r.endsWith('.*')) return target.startsWith(r.slice(0, -1));
      if (r.includes('*')) {
        const re = new RegExp('^' + r.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        return re.test(target);
      }
      return r === target;
    });
  }

  function normalizeIp(ip) {
    return String(ip || '').replace(/^::ffff:/, '').trim();
  }

  return {
    secret,
    tokenTtlSeconds: TOKEN_TTL_SECONDS,
    hashPassword,
    verifyPassword,
    passwordProblem,
    createToken: signToken,
    revoke,
    authenticate,
    requireRole,
    checkLoginLock,
    ipAllowed,
    normalizeIp
  };
}

/**
 * 首次启动时如果没有管理员，自动建一个
 * 密码优先取环境变量 ADMIN_INIT_PASSWORD，否则随机生成并在控制台打印一次
 */
function ensureInitialAdmin({ db, auth }) {
  if (db.countAdmins() > 0) return null;
  const username = (process.env.ADMIN_INIT_USERNAME || 'admin').trim();
  const fromEnv = process.env.ADMIN_INIT_PASSWORD;
  const password = fromEnv && fromEnv.length >= 8
    ? fromEnv
    : 'Lk' + crypto.randomBytes(5).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) + Math.floor(Math.random() * 90 + 10);
  db.createAdmin({
    username,
    passwordHash: auth.hashPassword(password),
    role: 'superadmin',
    mustChangePassword: fromEnv ? 0 : 1,
    createdBy: 'bootstrap'
  });
  return { username, password, generated: !fromEnv };
}

module.exports = { createAuth, ensureInitialAdmin, hashPassword, verifyPassword, passwordProblem };
