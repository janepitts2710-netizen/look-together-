/**
 * SQLite 持久化层
 *
 * 说明：
 * - 使用 Node.js 内置的 node:sqlite（DatabaseSync，同步 API），无需任何原生依赖。
 *   这样任意 Node.js 22.5+ 的机器都能开箱即用，彻底告别 better-sqlite3 的
 *   编译 / ABI / 预编译二进制问题（数据库文件在 server/data/look.db）。
 * - 房间的“实时状态”仍然在内存 Map 中（因为成员身份就是 socket.id，重启后必然失效），
 *   但房间的生命周期（创建 / 人数峰值 / 关闭原因）会同步落库，重启不丢历史。
 * - 所有对外接口返回的数据都经过序列化，避免把内部字段带出去。
 */

const fs = require('fs');
const path = require('path');

// 抑制 node:sqlite 的「ExperimentalWarning」提示（这是 Node 22 内置模块的提示，
// 对功能无影响，但会让用户误以为是出错，这里静默掉）。
const _origEmitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === 'string' ? warning : (warning && warning.name ? warning.name : '');
  if (String(msg).includes('SQLite') && String(msg).includes('experimental')) return;
  return _origEmitWarning.call(process, warning, ...rest);
};

const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'look.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');
db.exec('PRAGMA foreign_keys = ON');

/**
 * 手写事务：node:sqlite 没有 better-sqlite3 的 db.transaction() 包装器。
 * 这里用 BEGIN / COMMIT / ROLLBACK 模拟，行为一致（出错自动回滚）。
 */
function transaction(fn) {
  return function (...args) {
    db.exec('BEGIN');
    try {
      const result = fn.apply(this, args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };
}

// ---------------------------------------------------------------- 表结构
db.exec(`
CREATE TABLE IF NOT EXISTS admins (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT    NOT NULL UNIQUE,
  password_hash        TEXT    NOT NULL,
  role                 TEXT    NOT NULL DEFAULT 'admin',
  status               TEXT    NOT NULL DEFAULT 'active',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  token_version        INTEGER NOT NULL DEFAULT 1,
  last_login_at        INTEGER,
  last_login_ip        TEXT,
  created_at           INTEGER NOT NULL,
  created_by           TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

-- 房间生命周期记录（每开一个房间一行）
CREATE TABLE IF NOT EXISTS rooms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  kind          TEXT    NOT NULL,
  room_code     TEXT    NOT NULL,
  host_socket   TEXT,
  host_ip       TEXT,
  host_ua       TEXT,
  status        TEXT    NOT NULL DEFAULT 'open',
  member_count  INTEGER NOT NULL DEFAULT 0,
  peak_members  INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  closed_at     INTEGER,
  close_reason  TEXT,
  meta          TEXT
);
CREATE INDEX IF NOT EXISTS idx_rooms_kind_status ON rooms(kind, status);
CREATE INDEX IF NOT EXISTS idx_rooms_created ON rooms(created_at);

-- 房间事件流水（创建/加入/离开/踢出/解散/重置/切歌…）
CREATE TABLE IF NOT EXISTS room_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT,
  room_code  TEXT,
  event      TEXT NOT NULL,
  socket_id  TEXT,
  ip         TEXT,
  detail     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_room_events_created ON room_events(created_at);

-- 连接（会话）记录：一个 socket 一行，断开时补时长
CREATE TABLE IF NOT EXISTS connections (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  socket_id       TEXT NOT NULL,
  ip              TEXT,
  ua              TEXT,
  device          TEXT,
  referer         TEXT,
  connected_at    INTEGER NOT NULL,
  disconnected_at INTEGER,
  duration        INTEGER,
  rooms           TEXT,
  disconnect_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_connections_socket ON connections(socket_id);
CREATE INDEX IF NOT EXISTS idx_connections_ip ON connections(ip);

-- 管理员操作审计
CREATE TABLE IF NOT EXISTS admin_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id   INTEGER,
  admin_name TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  ua         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created ON admin_logs(created_at);

-- 登录尝试（用于失败锁定）
CREATE TABLE IF NOT EXISTS login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT,
  ip         TEXT,
  ua         TEXT,
  success    INTEGER NOT NULL DEFAULT 0,
  reason     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_login_attempts_created ON login_attempts(created_at);

-- IP 封禁
CREATE TABLE IF NOT EXISTS bans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip         TEXT NOT NULL,
  reason     TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  until      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_bans_ip ON bans(ip);

-- 全站公告 / 维护通知
CREATE TABLE IF NOT EXISTS announcements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info',
  popup      INTEGER NOT NULL DEFAULT 1,
  active     INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

-- 错误日志
CREATE TABLE IF NOT EXISTS error_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  level      TEXT NOT NULL DEFAULT 'error',
  message    TEXT,
  stack      TEXT,
  source     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_error_logs_created ON error_logs(created_at);

-- 点歌日志
CREATE TABLE IF NOT EXISTS music_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  room_code  TEXT,
  socket_id  TEXT,
  ip         TEXT,
  song_id    TEXT,
  title      TEXT,
  author     TEXT,
  action     TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_music_logs_created ON music_logs(created_at);
`);

// ---------------------------------------------------------------- 系统配置
// 每一项都有默认值 + 类型校验，后台提交时只接受这里声明过的键，避免被塞脏数据
const SETTING_SCHEMA = {
  siteName: { type: 'string', max: 40, default: '星梦小筑' },

  bilibiliResolveEnabled: { type: 'bool', default: true },
  maxUploadMB: { type: 'int', min: 1, max: 4096, default: 500 },

  musicSource: { type: 'enum', values: ['netease', 'meting'], default: 'netease' },
  metingApiUrl: { type: 'string', max: 300, default: '' },
  dailyRecommendPlaylist: { type: 'string', max: 200, default: '' },
  bannedSongs: { type: 'stringList', max: 200, default: [] },

  roomMaxMembers: { type: 'int', min: 2, max: 50, default: 8 },
  roomIdleDestroyMinutes: { type: 'int', min: 0, max: 1440, default: 120 },
  allowMemberControlPlayback: { type: 'bool', default: true },

  maintenanceMode: { type: 'bool', default: false },
  maintenanceMessage: { type: 'string', max: 300, default: '服务器正在维护，稍后回来～' },
  announcementBanner: { type: 'string', max: 200, default: '' },

  adminIpWhitelist: { type: 'stringList', max: 50, default: [] },
  loginMaxFails: { type: 'int', min: 3, max: 20, default: 5 },
  loginLockMinutes: { type: 'int', min: 1, max: 1440, default: 15 },
  logRetentionDays: { type: 'int', min: 1, max: 365, default: 30 }
};

function coerceSetting(key, raw) {
  const rule = SETTING_SCHEMA[key];
  if (!rule) return undefined;
  if (rule.type === 'bool') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === 1 || raw === '1') return true;
    if (raw === 'false' || raw === 0 || raw === '0') return false;
    return rule.default;
  }
  if (rule.type === 'int') {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return rule.default;
    return Math.min(rule.max, Math.max(rule.min, n));
  }
  if (rule.type === 'enum') {
    return rule.values.includes(raw) ? raw : rule.default;
  }
  if (rule.type === 'stringList') {
    let arr = raw;
    if (typeof raw === 'string') {
      arr = raw.split(/[\n,，]/);
    }
    if (!Array.isArray(arr)) return rule.default;
    return arr
      .map((v) => String(v == null ? '' : v).trim())
      .filter(Boolean)
      .slice(0, rule.max);
  }
  // string
  const s = String(raw == null ? '' : raw);
  return s.length > rule.max ? s.slice(0, rule.max) : s;
}

function defaultsOfSettings() {
  const out = {};
  for (const [key, rule] of Object.entries(SETTING_SCHEMA)) out[key] = rule.default;
  return out;
}

const stmtSettingsAll = db.prepare('SELECT key, value FROM settings');
const stmtSettingUpsert = db.prepare(`
  INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by
`);

let settingsCache = null;

function getSettings(force) {
  if (settingsCache && !force) return settingsCache;
  const out = defaultsOfSettings();
  for (const row of stmtSettingsAll.all()) {
    if (!(row.key in SETTING_SCHEMA)) continue; // 内部隐藏键（__jwt_secret 等）不外泄
    let value;
    try {
      value = JSON.parse(row.value);
    } catch (err) {
      value = row.value;
    }
    const coerced = coerceSetting(row.key, value);
    if (coerced !== undefined) out[row.key] = coerced;
  }
  settingsCache = out;
  return out;
}

function updateSettings(patch, by) {
  const now = Date.now();
  const applied = {};
  const tx = transaction(() => {
    for (const [key, raw] of Object.entries(patch || {})) {
      if (!(key in SETTING_SCHEMA)) continue;
      const value = coerceSetting(key, raw);
      if (value === undefined) continue;
      applied[key] = value;
      stmtSettingUpsert.run(key, JSON.stringify(value), now, by || 'system');
    }
  });
  tx();
  settingsCache = null;
  return { settings: getSettings(true), applied };
}

// 内部隐藏配置（JWT 密钥等），不进后台配置页
function getSecret(key, fallbackFactory) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row) {
    try {
      return JSON.parse(row.value);
    } catch (err) {
      return row.value;
    }
  }
  const value = fallbackFactory();
  stmtSettingUpsert.run(key, JSON.stringify(value), Date.now(), 'system');
  return value;
}

// ---------------------------------------------------------------- 管理员
const stmtAdminByUsername = db.prepare('SELECT * FROM admins WHERE username = ?');
const stmtAdminById = db.prepare('SELECT * FROM admins WHERE id = ?');
const stmtAdminCount = db.prepare('SELECT COUNT(*) AS c FROM admins');

function publicAdmin(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    status: row.status,
    mustChangePassword: !!row.must_change_password,
    lastLoginAt: row.last_login_at || null,
    lastLoginIp: row.last_login_ip || null,
    createdAt: row.created_at
  };
}

function findAdminByUsername(username) {
  return stmtAdminByUsername.get(String(username || '').trim()) || null;
}

function getAdmin(id) {
  return stmtAdminById.get(Number(id)) || null;
}

function listAdmins() {
  return db.prepare('SELECT * FROM admins ORDER BY id ASC').all().map(publicAdmin);
}

function countAdmins() {
  return stmtAdminCount.get().c;
}

function createAdmin({ username, passwordHash, role = 'admin', mustChangePassword = 0, createdBy = 'system' }) {
  try {
    const info = db.prepare(`
      INSERT INTO admins (username, password_hash, role, status, must_change_password, created_at, created_by)
      VALUES (?, ?, ?, 'active', ?, ?, ?)
    `).run(String(username).trim(), passwordHash, role, mustChangePassword ? 1 : 0, Date.now(), createdBy);
    return getAdmin(info.lastInsertRowid);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      const e = new Error('管理员账号已存在');
      e.status = 409;
      throw e;
    }
    throw err;
  }
}

function updateAdminPassword(id, passwordHash, opts = {}) {
  db.prepare(`
    UPDATE admins
    SET password_hash = ?, must_change_password = ?, token_version = token_version + 1
    WHERE id = ?
  `).run(passwordHash, opts.mustChange ? 1 : 0, Number(id));
  return getAdmin(id);
}

function setAdminStatus(id, status) {
  db.prepare('UPDATE admins SET status = ?, token_version = token_version + 1 WHERE id = ?').run(status, Number(id));
  return getAdmin(id);
}

function setAdminRole(id, role) {
  db.prepare('UPDATE admins SET role = ? WHERE id = ?').run(role, Number(id));
  return getAdmin(id);
}

function deleteAdmin(id) {
  db.prepare('DELETE FROM admins WHERE id = ?').run(Number(id));
}

function touchAdminLogin(id, ip) {
  db.prepare('UPDATE admins SET last_login_at = ?, last_login_ip = ? WHERE id = ?').run(Date.now(), ip || '', Number(id));
}

// ---------------------------------------------------------------- 日志
function adminLog({ adminId, adminName, action, target, detail, ip, ua }) {
  db.prepare(`
    INSERT INTO admin_logs (admin_id, admin_name, action, target, detail, ip, ua, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    adminId == null ? null : Number(adminId),
    adminName || '',
    String(action || ''),
    target == null ? '' : String(target),
    detail == null ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
    ip || '',
    ua || '',
    Date.now()
  );
}

function roomEvent({ kind, roomCode, event, socketId, ip, detail }) {
  db.prepare(`
    INSERT INTO room_events (kind, room_code, event, socket_id, ip, detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    kind || '',
    roomCode || '',
    String(event || ''),
    socketId || '',
    ip || '',
    detail == null ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
    Date.now()
  );
}

function errorLog({ level = 'error', message, stack, source }) {
  db.prepare('INSERT INTO error_logs (level, message, stack, source, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(level, String(message || ''), String(stack || ''), String(source || ''), Date.now());
}

function musicLog({ roomCode, socketId, ip, songId, title, author, action }) {
  db.prepare(`
    INSERT INTO music_logs (room_code, socket_id, ip, song_id, title, author, action, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(roomCode || '', socketId || '', ip || '', songId || '', title || '', author || '', action || 'add', Date.now());
}

function loginAttempt({ username, ip, ua, success, reason }) {
  db.prepare('INSERT INTO login_attempts (username, ip, ua, success, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(username || ''), ip || '', ua || '', success ? 1 : 0, reason || '', Date.now());
}

function countRecentLoginFails({ ip, username, since }) {
  const byIp = db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE success = 0 AND created_at >= ? AND ip = ?')
    .get(since, ip || '').c;
  const byUser = db.prepare('SELECT COUNT(*) AS c FROM login_attempts WHERE success = 0 AND created_at >= ? AND username = ?')
    .get(since, String(username || '')).c;
  return { byIp, byUser };
}

function latestFailAt({ ip, username, since }) {
  const row = db.prepare(`
    SELECT MAX(created_at) AS t FROM login_attempts
    WHERE success = 0 AND created_at >= ? AND (ip = ? OR username = ?)
  `).get(since, ip || '', String(username || ''));
  return row && row.t ? row.t : 0;
}

// ---------------------------------------------------------------- 连接
function connectionOpened({ socketId, ip, ua, device, referer }) {
  const info = db.prepare(`
    INSERT INTO connections (socket_id, ip, ua, device, referer, connected_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(socketId, ip || '', ua || '', device || '', referer || '', Date.now());
  return info.lastInsertRowid;
}

function connectionRooms(socketId, rooms) {
  if (!socketId) return;
  db.prepare('UPDATE connections SET rooms = ? WHERE socket_id = ? AND disconnected_at IS NULL')
    .run(JSON.stringify(rooms || []), socketId);
}

function connectionClosed(socketId, reason) {
  const row = db.prepare(`
    SELECT id, connected_at FROM connections
    WHERE socket_id = ? AND disconnected_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(socketId);
  if (!row) return;
  const now = Date.now();
  db.prepare('UPDATE connections SET disconnected_at = ?, duration = ?, disconnect_reason = ? WHERE id = ?')
    .run(now, now - row.connected_at, reason || '', row.id);
}

// ---------------------------------------------------------------- 封禁
function activeBans() {
  const now = Date.now();
  return db.prepare('SELECT * FROM bans WHERE until IS NULL OR until = 0 OR until > ? ORDER BY created_at DESC').all(now);
}

function isBanned(ip) {
  if (!ip) return null;
  const now = Date.now();
  return db.prepare('SELECT * FROM bans WHERE ip = ? AND (until IS NULL OR until = 0 OR until > ?) ORDER BY id DESC LIMIT 1')
    .get(ip, now) || null;
}

function addBan({ ip, reason, minutes, createdBy }) {
  const until = minutes && Number(minutes) > 0 ? Date.now() + Number(minutes) * 60000 : 0;
  const info = db.prepare('INSERT INTO bans (ip, reason, created_by, created_at, until) VALUES (?, ?, ?, ?, ?)')
    .run(String(ip).trim(), reason || '', createdBy || '', Date.now(), until);
  return db.prepare('SELECT * FROM bans WHERE id = ?').get(info.lastInsertRowid);
}

function removeBan(id) {
  db.prepare('DELETE FROM bans WHERE id = ?').run(Number(id));
}

// ---------------------------------------------------------------- 公告
function listAnnouncements(limit = 50) {
  return db.prepare('SELECT * FROM announcements ORDER BY created_at DESC LIMIT ?').all(limit);
}

function activeAnnouncement() {
  const now = Date.now();
  return db.prepare(`
    SELECT * FROM announcements
    WHERE active = 1 AND (expires_at IS NULL OR expires_at = 0 OR expires_at > ?)
    ORDER BY created_at DESC LIMIT 1
  `).get(now) || null;
}

function createAnnouncement({ title, content, level, popup, expiresAt, createdBy }) {
  const info = db.prepare(`
    INSERT INTO announcements (title, content, level, popup, active, created_by, created_at, expires_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `).run(title, content, level || 'info', popup === false ? 0 : 1, createdBy || '', Date.now(), expiresAt || 0);
  return db.prepare('SELECT * FROM announcements WHERE id = ?').get(info.lastInsertRowid);
}

function setAnnouncementActive(id, active) {
  db.prepare('UPDATE announcements SET active = ? WHERE id = ?').run(active ? 1 : 0, Number(id));
}

function deleteAnnouncement(id) {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(Number(id));
}

// ---------------------------------------------------------------- 房间记录同步
/**
 * 用内存中的实时房间列表对账：
 *  - 内存里有、库里没有 open 记录 → 插入（说明是新房间）
 *  - 库里有 open、内存里已不存在 → 标记 closed（房间已空/被解散）
 *  - 都存在 → 更新人数、峰值、快照
 */
const syncRoomsTx = transaction((liveRooms) => {
  const openRows = db.prepare("SELECT id, kind, room_code FROM rooms WHERE status = 'open'").all();
  const liveKeys = new Set(liveRooms.map((r) => r.kind + ':' + r.code));
  const now = Date.now();

  for (const row of openRows) {
    if (!liveKeys.has(row.kind + ':' + row.room_code)) {
      db.prepare("UPDATE rooms SET status = 'closed', closed_at = ?, close_reason = COALESCE(close_reason, 'empty'), updated_at = ? WHERE id = ?")
        .run(now, now, row.id);
    }
  }

  for (const r of liveRooms) {
    const row = db.prepare("SELECT id, peak_members FROM rooms WHERE kind = ? AND room_code = ? AND status = 'open' LIMIT 1")
      .get(r.kind, r.code);
    if (row) {
      db.prepare('UPDATE rooms SET member_count = ?, peak_members = ?, host_socket = ?, host_ip = COALESCE(host_ip, ?), host_ua = COALESCE(host_ua, ?), meta = ?, updated_at = ? WHERE id = ?')
        .run(r.memberCount || 0, Math.max(row.peak_members || 0, r.memberCount || 0), r.hostSocket || '', r.hostIp || '', r.hostUa || '', r.meta ? JSON.stringify(r.meta) : null, now, row.id);
    } else {
      db.prepare(`
        INSERT INTO rooms (kind, room_code, host_socket, host_ip, host_ua, status, member_count, peak_members, created_at, updated_at, meta)
        VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
      `).run(r.kind, r.code, r.hostSocket || '', r.hostIp || '', r.hostUa || '', r.memberCount || 0, r.memberCount || 0, r.createdAt || now, now, r.meta ? JSON.stringify(r.meta) : null);
    }
  }
});

function syncRooms(liveRooms) {
  try {
    syncRoomsTx(liveRooms || []);
  } catch (err) {
    console.error('[db] 同步房间记录失败', err.message);
  }
}

/**
 * 房间创建时立即落库（不等对账周期），
 * 否则「创建后几秒内就解散」的短命房间会漏记。
 */
function openRoom({ kind, code, hostSocket, hostIp, hostUa, memberCount, createdAt, meta }) {
  try {
    const exists = db.prepare("SELECT id FROM rooms WHERE kind = ? AND room_code = ? AND status = 'open'").get(kind, code);
    if (exists) return exists.id;
    const now = Date.now();
    const info = db.prepare(`
      INSERT INTO rooms (kind, room_code, host_socket, host_ip, host_ua, status, member_count, peak_members, created_at, updated_at, meta)
      VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?)
    `).run(
      kind,
      code,
      hostSocket || '',
      hostIp || '',
      hostUa || '',
      memberCount || 1,
      memberCount || 1,
      createdAt || now,
      now,
      meta ? JSON.stringify(meta) : null
    );
    db.prepare('INSERT INTO room_events (kind, room_code, event, socket_id, ip, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(kind, code, 'create', hostSocket || '', hostIp || '', '', now);
    return info.lastInsertRowid;
  } catch (err) {
    console.error('[db] 记录房间创建失败', err.message);
    return null;
  }
}

function closeOpenRooms(reason) {
  const now = Date.now();
  const info = db.prepare("UPDATE rooms SET status = 'closed', closed_at = ?, close_reason = ?, updated_at = ? WHERE status = 'open'")
    .run(now, reason || 'server_restart', now);
  return info.changes;
}

/** 有人加入房间时立刻更新人数与峰值，避免短命房间的峰值统计偏低 */
function touchRoomMembers(kind, roomCode, count) {
  try {
    const n = Math.max(0, Number(count) || 0);
    db.prepare(`UPDATE rooms SET member_count = ?, peak_members = MAX(peak_members, ?), updated_at = ?
      WHERE kind = ? AND room_code = ? AND status = 'open'`).run(n, n, Date.now(), kind, roomCode);
  } catch (err) {
    console.error('[db] 更新房间人数失败', err.message);
  }
}

function markRoomClosed(kind, roomCode, reason) {
  const now = Date.now();
  db.prepare(`UPDATE rooms SET status = 'closed', closed_at = ?, close_reason = ?, updated_at = ?
    WHERE kind = ? AND room_code = ? AND status = 'open'`).run(now, reason || 'manual', now, kind, roomCode);
}

// ---------------------------------------------------------------- 查询 / 统计
function paged(sql, params, page = 1, size = 20) {
  const p = Math.max(1, Number(page) || 1);
  const s = Math.min(200, Math.max(1, Number(size) || 20));
  const total = db.prepare(`SELECT COUNT(*) AS c FROM (${sql})`).get(...params).c;
  const items = db.prepare(`${sql} LIMIT ? OFFSET ?`).all(...params, s, (p - 1) * s);
  return { items, total, page: p, size: s, pages: Math.ceil(total / s) || 1 };
}

function listRoomHistory({ kind, status, page, size }) {
  const where = [];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (status) { where.push('status = ?'); params.push(status); }
  const sql = `SELECT * FROM rooms ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
  return paged(sql, params, page, size);
}

function listAdminLogs({ page, size, action }) {
  const where = [];
  const params = [];
  if (action) { where.push('action LIKE ?'); params.push('%' + action + '%'); }
  const sql = `SELECT * FROM admin_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
  return paged(sql, params, page, size);
}

function listRoomEvents({ page, size, kind, event, roomCode }) {
  const where = [];
  const params = [];
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (event) { where.push('event = ?'); params.push(event); }
  if (roomCode) { where.push('room_code = ?'); params.push(String(roomCode).toUpperCase()); }
  const sql = `SELECT * FROM room_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
  return paged(sql, params, page, size);
}

function listErrorLogs({ page, size, level }) {
  const where = [];
  const params = [];
  if (level) { where.push('level = ?'); params.push(level); }
  const sql = `SELECT * FROM error_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
  return paged(sql, params, page, size);
}

function listLoginAttempts({ page, size, onlyFail }) {
  const where = onlyFail ? ['success = 0'] : [];
  const sql = `SELECT * FROM login_attempts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
  return paged(sql, [], page, size);
}

function listConnections({ page, size, onlyOnline, ip }) {
  const where = [];
  const params = [];
  if (onlyOnline) where.push('disconnected_at IS NULL');
  if (ip) { where.push('ip LIKE ?'); params.push('%' + ip + '%'); }
  const sql = `SELECT * FROM connections ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY connected_at DESC`;
  return paged(sql, params, page, size);
}

function listMusicLogs({ page, size, roomCode }) {
  const where = [];
  const params = [];
  if (roomCode) { where.push('room_code = ?'); params.push(String(roomCode).toUpperCase()); }
  const sql = `SELECT * FROM music_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`;
  return paged(sql, params, page, size);
}

function cleanupLogs(days) {
  const d = Math.max(1, Number(days) || 30);
  const since = Date.now() - d * 86400000;
  const result = {};
  for (const table of ['admin_logs', 'room_events', 'error_logs', 'login_attempts', 'music_logs', 'connections']) {
    const col = table === 'connections' ? 'connected_at' : 'created_at';
    result[table] = db.prepare(`DELETE FROM ${table} WHERE ${col} < ?`).run(since).changes;
  }
  // 关闭超过保留期的历史房间记录也一并清理，避免无限膨胀
  result.rooms = db.prepare("DELETE FROM rooms WHERE status = 'closed' AND closed_at < ?").run(since).changes;
  return result;
}

function statsSnapshot() {
  const dayStart = (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const total = db.prepare('SELECT COUNT(*) AS c FROM rooms').get().c;
  const byKind = db.prepare('SELECT kind, COUNT(*) AS c, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today FROM rooms GROUP BY kind')
    .all(dayStart);
  const openRows = db.prepare("SELECT COUNT(*) AS c FROM rooms WHERE status = 'open'").get().c;
  const today = db.prepare('SELECT COUNT(*) AS c FROM rooms WHERE created_at >= ?').get(dayStart).c;
  const online = db.prepare('SELECT COUNT(*) AS c FROM connections WHERE disconnected_at IS NULL').get().c;
  const totalConn = db.prepare('SELECT COUNT(*) AS c FROM connections').get().c;
  const errors24h = db.prepare('SELECT COUNT(*) AS c FROM error_logs WHERE created_at >= ?').get(Date.now() - 86400000).c;
  const adminLogs24h = db.prepare('SELECT COUNT(*) AS c FROM admin_logs WHERE created_at >= ?').get(Date.now() - 86400000).c;
  const peakRow = db.prepare('SELECT MAX(peak_members) AS p FROM rooms').get();

  const kindMap = { video: 0, gomoku: 0, doudizhu: 0, music: 0 };
  const kindToday = { video: 0, gomoku: 0, doudizhu: 0, music: 0 };
  for (const row of byKind) {
    if (row.kind in kindMap) {
      kindMap[row.kind] = row.c;
      kindToday[row.kind] = row.today || 0;
    }
  }

  return {
    historyTotal: total,
    historyByKind: kindMap,
    todayByKind: kindToday,
    todayCreated: today,
    openRows,
    onlineRows: online,
    totalConnections: totalConn,
    errors24h,
    adminLogs24h,
    peakMembers: peakRow && peakRow.p ? peakRow.p : 0
  };
}

function recentRoomEvents(limit = 15) {
  return db.prepare('SELECT * FROM room_events ORDER BY created_at DESC LIMIT ?').all(limit);
}

function recentAdminLogs(limit = 10) {
  return db.prepare('SELECT * FROM admin_logs ORDER BY created_at DESC LIMIT ?').all(limit);
}

function dbSizeBytes() {
  try {
    return fs.statSync(DB_PATH).size;
  } catch (err) {
    return 0;
  }
}

/** 7 天房间创建趋势（看板折线） */
function roomTrend(days = 7) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  const rows = db.prepare('SELECT created_at, kind FROM rooms WHERE created_at >= ?').all(start.getTime());
  const buckets = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const key = `${d.getMonth() + 1}/${d.getDate()}`;
    buckets.push({ label: key, total: 0, video: 0, gomoku: 0, doudizhu: 0, music: 0, start: d.getTime(), end: d.getTime() + 86400000 });
  }
  for (const row of rows) {
    const bucket = buckets.find((b) => row.created_at >= b.start && row.created_at < b.end);
    if (!bucket) continue;
    bucket.total += 1;
    if (row.kind in bucket) bucket[row.kind] += 1;
  }
  return buckets.map(({ label, total, video, gomoku, doudizhu, music }) => ({ label, total, video, gomoku, doudizhu, music }));
}

module.exports = {
  db,
  DB_PATH,
  DATA_DIR,
  SETTING_SCHEMA,
  getSettings,
  updateSettings,
  getSecret,
  // admins
  publicAdmin,
  findAdminByUsername,
  getAdmin,
  listAdmins,
  countAdmins,
  createAdmin,
  updateAdminPassword,
  setAdminStatus,
  setAdminRole,
  deleteAdmin,
  touchAdminLogin,
  // logs
  adminLog,
  roomEvent,
  errorLog,
  musicLog,
  loginAttempt,
  countRecentLoginFails,
  latestFailAt,
  // connections
  connectionOpened,
  connectionClosed,
  connectionRooms,
  // bans
  activeBans,
  isBanned,
  addBan,
  removeBan,
  // announcements
  listAnnouncements,
  activeAnnouncement,
  createAnnouncement,
  setAnnouncementActive,
  deleteAnnouncement,
  // rooms
  syncRooms,
  openRoom,
  closeOpenRooms,
  touchRoomMembers,
  markRoomClosed,
  listRoomHistory,
  listAdminLogs,
  listRoomEvents,
  listErrorLogs,
  listLoginAttempts,
  listConnections,
  listMusicLogs,
  cleanupLogs,
  statsSnapshot,
  recentRoomEvents,
  recentAdminLogs,
  roomTrend,
  dbSizeBytes
};
