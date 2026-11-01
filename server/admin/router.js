/**
 * 后台管理接口（/api/admin/*）
 *
 * 设计要点：
 * - 由 index.js 以工厂方式注入运行时依赖（db / auth / io / 房间表 / 房间操作），
 *   这样 admin 模块不需要反向 require 主服务，避免循环依赖。
 * - 所有写操作都会写一条 admin_logs 审计记录。
 * - 权限：admin 可看可管房间，superadmin 额外可改系统配置、封禁 IP、管理账号、清理日志。
 */

const express = require('express');
const os = require('os');

const ROOM_KINDS = ['video', 'gomoku', 'doudizhu', 'music'];
const ROOM_KIND_LABEL = { video: '视频房间', gomoku: '五子棋房间', doudizhu: '斗地主房间', music: '音乐房间' };
const SHARE_PATH = {
  video: '/#/pages/room/room?roomId=',
  gomoku: '/#/pages/gomoku/gomoku?roomId=',
  doudizhu: '/#/pages/doudizhu/doudizhu?roomId=',
  music: '/#/pages/music/room?roomId='
};

// 管理接口限流：每个 IP 每分钟最多 300 次（登录另算）
function adminRateLimit(maxPerMinute = 300) {
  const buckets = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) if (now - b.start > 600000) buckets.delete(key);
  }, 600000).unref();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now - bucket.start > 60000) {
      buckets.set(key, { start: now, count: 1 });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > maxPerMinute) {
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
  };
}

function toInt(value, fallback, min, max) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function createAdminRouter(ctx) {
  const { db, auth, io, ops, startedAt, version = '1.0.0' } = ctx;
  const router = express.Router();

  router.use(adminRateLimit());
  // 统一把 IPv4-mapped IPv6（::ffff:127.0.0.1）还原成可读 IP，日志与白名单都依赖它
  // 注意：Express 的 req.ip 是原型上的 getter，直接赋值无效，必须定义自有属性覆盖
  router.use((req, res, next) => {
    Object.defineProperty(req, 'ip', {
      value: auth.normalizeIp(req.ip),
      writable: true,
      configurable: true,
      enumerable: true
    });
    next();
  });
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });

  // IP 白名单：只拦管理接口，公开业务接口不受影响
  router.use((req, res, next) => {
    if (auth.ipAllowed(req.ip)) return next();
    db.errorLog({ level: 'warn', message: `管理接口拒绝非白名单 IP：${req.ip} ${req.method} ${req.originalUrl}`, source: 'admin-ip' });
    res.status(403).json({ error: '当前 IP 不在管理白名单内', code: 'IP_NOT_ALLOWED' });
  });

  const audit = (req, action, target, detail) => {
    db.adminLog({
      adminId: req.admin && req.admin.id,
      adminName: req.admin && req.admin.username,
      action,
      target: target || '',
      detail: detail || '',
      ip: req.ip,
      ua: req.headers['user-agent'] || ''
    });
  };

  const baseUrl = (req) => {
    const host = req.get('host');
    return `${req.protocol}://${host}`;
  };

  // ------------------------------------------------------------ 登录 / 会话
  router.post('/login', (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const ua = req.headers['user-agent'] || '';

    if (!username || !password) {
      return res.status(400).json({ error: '请输入账号和密码' });
    }

    const lock = auth.checkLoginLock({ ip: req.ip, username });
    if (lock.locked) {
      db.loginAttempt({ username, ip: req.ip, ua, success: false, reason: 'locked' });
      return res.status(429).json({
        error: `登录失败次数过多，请 ${Math.ceil(lock.retryAfter / 60)} 分钟后再试`,
        retryAfter: lock.retryAfter
      });
    }

    const admin = db.findAdminByUsername(username);
    if (!admin || !auth.verifyPassword(password, admin.password_hash)) {
      db.loginAttempt({ username, ip: req.ip, ua, success: false, reason: 'bad_credentials' });
      const after = auth.checkLoginLock({ ip: req.ip, username });
      return res.status(401).json({
        error: '账号或密码错误',
        remain: after.locked ? 0 : Math.max(0, db.getSettings().loginMaxFails - after.fails)
      });
    }
    if (admin.status !== 'active') {
      db.loginAttempt({ username, ip: req.ip, ua, success: false, reason: 'disabled' });
      return res.status(403).json({ error: '该账号已被禁用，请联系超级管理员' });
    }

    const { token, expiresIn } = auth.createToken(admin);
    db.touchAdminLogin(admin.id, req.ip);
    db.loginAttempt({ username, ip: req.ip, ua, success: true });
    db.adminLog({
      adminId: admin.id,
      adminName: admin.username,
      action: 'login',
      target: '',
      detail: '',
      ip: req.ip,
      ua
    });

    res.json({
      ok: true,
      token,
      expiresIn,
      admin: db.publicAdmin(admin)
    });
  });

  router.post('/logout', auth.authenticate, (req, res) => {
    auth.revoke(req.tokenPayload.jti, req.tokenPayload.exp);
    audit(req, 'logout');
    res.json({ ok: true });
  });

  router.get('/me', auth.authenticate, (req, res) => {
    res.json({ ok: true, admin: req.admin, tokenTtl: auth.tokenTtlSeconds });
  });

  router.post('/password', auth.authenticate, (req, res) => {
    const oldPassword = String((req.body && req.body.oldPassword) || '');
    const newPassword = String((req.body && req.body.newPassword) || '');
    if (!auth.verifyPassword(oldPassword, req.adminRaw.password_hash)) {
      audit(req, 'password_change_failed', 'self', '旧密码错误');
      return res.status(400).json({ error: '当前密码不正确' });
    }
    const problem = auth.passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: problem });
    if (oldPassword === newPassword) return res.status(400).json({ error: '新密码不能与旧密码相同' });

    db.updateAdminPassword(req.admin.id, auth.hashPassword(newPassword), { mustChange: false });
    audit(req, 'password_change', 'self');
    // 改密后旧 token 全部失效，这里直接返回一个新 token，避免用户被踢出
    const fresh = db.getAdmin(req.admin.id);
    const { token, expiresIn } = auth.createToken(fresh);
    res.json({ ok: true, token, expiresIn, admin: db.publicAdmin(fresh), message: '密码已更新' });
  });

  // ------------------------------------------------------------ 管理员账号
  router.get('/admins', auth.authenticate, auth.requireRole('superadmin'), (req, res) => {
    res.json({ ok: true, admins: db.listAdmins() });
  });

  router.post('/admins', auth.authenticate, auth.requireRole('superadmin'), (req, res) => {
    const username = String((req.body && req.body.username) || '').trim();
    const password = String((req.body && req.body.password) || '');
    const role = req.body && req.body.role === 'superadmin' ? 'superadmin' : 'admin';
    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(username)) {
      return res.status(400).json({ error: '账号需为 3-20 位字母、数字、下划线或点' });
    }
    const problem = auth.passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    try {
      const admin = db.createAdmin({
        username,
        passwordHash: auth.hashPassword(password),
        role,
        mustChangePassword: 1,
        createdBy: req.admin.username
      });
      audit(req, 'admin_create', username, { role });
      res.json({ ok: true, admin: db.publicAdmin(admin) });
    } catch (err) {
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  router.patch('/admins/:id', auth.authenticate, auth.requireRole('superadmin'), (req, res) => {
    const id = Number(req.params.id);
    const target = db.getAdmin(id);
    if (!target) return res.status(404).json({ error: '管理员不存在' });

    const status = req.body && req.body.status;
    const role = req.body && req.body.role;
    if (id === req.admin.id && status === 'disabled') {
      return res.status(400).json({ error: '不能禁用当前登录的账号' });
    }
    if (status && !['active', 'disabled'].includes(status)) {
      return res.status(400).json({ error: '状态值无效' });
    }
    if (role && !['admin', 'superadmin'].includes(role)) {
      return res.status(400).json({ error: '角色值无效' });
    }
    // 不允许把最后一个可用的超管降级/禁用
    if (target.role === 'superadmin' && (role === 'admin' || status === 'disabled')) {
      const others = db.listAdmins().filter((a) => a.role === 'superadmin' && a.status === 'active' && a.id !== id);
      if (!others.length) return res.status(400).json({ error: '至少要保留一个可用的超级管理员' });
    }
    if (status) db.setAdminStatus(id, status);
    if (role) db.setAdminRole(id, role);
    audit(req, 'admin_update', target.username, { status, role });
    res.json({ ok: true, admin: db.publicAdmin(db.getAdmin(id)) });
  });

  router.post('/admins/:id/reset-password', auth.authenticate, auth.requireRole('superadmin'), (req, res) => {
    const id = Number(req.params.id);
    const target = db.getAdmin(id);
    if (!target) return res.status(404).json({ error: '管理员不存在' });
    const password = String((req.body && req.body.password) || '');
    const problem = auth.passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    db.updateAdminPassword(id, auth.hashPassword(password), { mustChange: true });
    audit(req, 'admin_reset_password', target.username);
    res.json({ ok: true, message: '密码已重置，该账号下次登录需修改密码' });
  });

  router.delete('/admins/:id', auth.authenticate, auth.requireRole('superadmin'), (req, res) => {
    const id = Number(req.params.id);
    const target = db.getAdmin(id);
    if (!target) return res.status(404).json({ error: '管理员不存在' });
    if (id === req.admin.id) return res.status(400).json({ error: '不能删除自己' });
    if (target.role === 'superadmin') {
      const others = db.listAdmins().filter((a) => a.role === 'superadmin' && a.id !== id);
      if (!others.length) return res.status(400).json({ error: '至少要保留一个超级管理员' });
    }
    db.deleteAdmin(id);
    audit(req, 'admin_delete', target.username);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ 看板
  router.get('/dashboard', auth.authenticate, (req, res) => {
    const stats = ctx.stats();
    const history = db.statsSnapshot();
    const mem = process.memoryUsage();
    const liveRooms = {
      video: ctx.listRooms('video').length,
      gomoku: ctx.listRooms('gomoku').length,
      doudizhu: ctx.listRooms('doudizhu').length,
      music: ctx.listRooms('music').length
    };
    const liveMembers = {};
    for (const kind of ROOM_KINDS) {
      liveMembers[kind] = ctx.listRooms(kind).reduce((sum, r) => sum + (r.memberCount || 0), 0);
    }

    res.json({
      ok: true,
      now: Date.now(),
      server: {
        version,
        node: process.version,
        platform: `${os.type()} ${os.release()}`,
        uptime: Math.floor(process.uptime()),
        startedAt,
        pid: process.pid,
        cpuCount: os.cpus().length,
        loadavg: os.loadavg().map((n) => Number(n.toFixed(2))),
        memory: {
          rss: mem.rss,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          external: mem.external,
          systemTotal: os.totalmem(),
          systemFree: os.freemem()
        },
        dbSize: db.dbSizeBytes(),
        dataDir: db.DATA_DIR
      },
      live: {
        onlineConnections: stats.onlineConnections,
        socketClients: stats.socketClients,
        rooms: liveRooms,
        members: liveMembers,
        totalRooms: ROOM_KINDS.reduce((s, k) => s + liveRooms[k], 0)
      },
      history,
      trend: db.roomTrend(7),
      settings: {
        maintenanceMode: db.getSettings().maintenanceMode,
        bannedSongs: db.getSettings().bannedSongs.length,
        activeBans: db.activeBans().length,
        announcement: db.activeAnnouncement()
      },
      recentEvents: db.recentRoomEvents(12),
      recentActions: db.recentAdminLogs(8)
    });
  });

  // ------------------------------------------------------------ 房间列表 / 操作
  router.get('/rooms/history', auth.authenticate, (req, res) => {
    const page = toInt(req.query.page, 1, 1, 100000);
    const size = toInt(req.query.size, 20, 1, 200);
    const kind = ROOM_KINDS.includes(req.query.kind) ? req.query.kind : '';
    const status = ['open', 'closed'].includes(req.query.status) ? req.query.status : '';
    const result = db.listRoomHistory({ kind, status, page, size });
    res.json({ ok: true, ...result });
  });

  router.get('/rooms/:kind', auth.authenticate, (req, res) => {
    const kind = req.params.kind;
    if (!ROOM_KINDS.includes(kind)) return res.status(400).json({ error: '未知房间类型' });
    const q = String(req.query.q || '').trim().toUpperCase();
    let rooms = ctx.listRooms(kind);
    if (q) {
      rooms = rooms.filter((r) =>
        String(r.id).toUpperCase().includes(q) ||
        String(r.hostIp || '').includes(q) ||
        String(r.hostSocket || '').includes(q) ||
        String((r.video && r.video.title) || '').toUpperCase().includes(q) ||
        (r.members || []).some((m) => String(m.socketId).toUpperCase().includes(q) || String(m.ip || '').includes(q))
      );
    }
    for (const r of rooms) r.shareLink = baseUrl(req) + SHARE_PATH[kind] + r.id;
    res.json({ ok: true, kind, label: ROOM_KIND_LABEL[kind], rooms, total: rooms.length });
  });

  function roomAction(actionName, handler) {
    return (req, res) => {
      const kind = req.params.kind;
      const id = String(req.params.id || '').toUpperCase();
      if (!ROOM_KINDS.includes(kind)) return res.status(400).json({ error: '未知房间类型' });
      const room = ctx.findRoom(kind, id);
      if (!room) return res.status(404).json({ error: '房间不存在或已关闭' });
      let result;
      try {
        result = handler({ req, kind, room, id });
      } catch (err) {
        console.error('[admin] 房间操作失败', err);
        db.errorLog({ level: 'error', message: err.message, stack: err.stack, source: 'admin/' + actionName });
        return res.status(400).json({ error: err.message || '操作失败' });
      }
      audit(req, actionName, `${kind}:${id}`, result && result.detail);
      res.json({ ok: true, ...(result || {}) });
    };
  }

  router.post('/rooms/:kind/:id/close', auth.authenticate, roomAction('room_close', ({ room, kind, id, req }) => {
    const reason = String((req.body && req.body.reason) || `由管理员 ${req.admin.username} 解散`);
    ops.close(kind, room, reason);
    db.markRoomClosed(kind, id, 'admin');
    db.roomEvent({ kind, roomCode: id, event: 'admin_close', ip: req.ip, detail: { by: req.admin.username, reason } });
    return { detail: { reason } };
  }));

  router.post('/rooms/:kind/:id/kick', auth.authenticate, roomAction('room_kick', ({ room, kind, id, req }) => {
    const socketId = String((req.body && req.body.socketId) || '');
    if (!socketId) throw new Error('请指定要踢出的成员');
    const meta = ctx.getSocketMeta(socketId);
    ops.kick(kind, room, socketId, { reason: '被管理员移出房间', by: req.admin.username });
    db.roomEvent({ kind, roomCode: id, event: 'admin_kick', socketId, ip: (meta && meta.ip) || req.ip, detail: { by: req.admin.username } });
    return { detail: { socketId, ip: meta && meta.ip } };
  }));

  router.post('/rooms/:kind/:id/transfer', auth.authenticate, roomAction('room_transfer', ({ room, kind, id, req }) => {
    const socketId = String((req.body && req.body.socketId) || '');
    if (!socketId) throw new Error('请指定新房主');
    ops.transfer(kind, room, socketId, { by: req.admin.username });
    db.roomEvent({ kind, roomCode: id, event: 'admin_transfer', socketId, ip: req.ip, detail: { by: req.admin.username } });
    return { detail: { socketId } };
  }));

  router.post('/rooms/:kind/:id/reset', auth.authenticate, roomAction('room_reset', ({ room, kind, id, req }) => {
    ops.reset(kind, room, { by: req.admin.username });
    db.roomEvent({ kind, roomCode: id, event: 'admin_reset', ip: req.ip, detail: { by: req.admin.username } });
    return { detail: {} };
  }));

  router.post('/rooms/:kind/:id/queue/clear', auth.authenticate, roomAction('music_queue_clear', ({ room, kind, id, req }) => {
    ops.clearQueue(kind, room, { by: req.admin.username });
    db.roomEvent({ kind, roomCode: id, event: 'admin_clear_queue', ip: req.ip, detail: { by: req.admin.username } });
    return { detail: {} };
  }));

  router.post('/rooms/:kind/:id/queue/remove', auth.authenticate, roomAction('music_queue_remove', ({ room, kind, id, req }) => {
    const index = Number(req.body && req.body.index);
    ops.removeSong(kind, room, index, { by: req.admin.username });
    db.roomEvent({ kind, roomCode: id, event: 'admin_remove_song', ip: req.ip, detail: { index, by: req.admin.username } });
    return { detail: { index } };
  }));

  router.post('/rooms/:kind/:id/play', auth.authenticate, roomAction('music_play', ({ room, kind, id, req }) => {
    const index = Number(req.body && req.body.index);
    ops.playIndex(kind, room, index, { by: req.admin.username });
    db.roomEvent({ kind, roomCode: id, event: 'admin_force_play', ip: req.ip, detail: { index, by: req.admin.username } });
    return { detail: { index } };
  }));

  router.post('/rooms/:kind/:id/next', auth.authenticate, roomAction('music_next', ({ room, kind, id, req }) => {
    ops.nextSong(kind, room, { by: req.admin.username });
    db.roomEvent({ kind, roomCode: id, event: 'admin_force_next', ip: req.ip, detail: { by: req.admin.username } });
    return { detail: {} };
  }));

  // ------------------------------------------------------------ 系统配置
  router.get('/settings', auth.authenticate, (req, res) => {
    res.json({
      ok: true,
      settings: db.getSettings(),
      schema: Object.fromEntries(Object.entries(db.SETTING_SCHEMA).map(([k, v]) => [k, {
        type: v.type,
        min: v.min,
        max: v.max,
        values: v.values,
        default: v.default
      }]))
    });
  });

  router.put('/settings', auth.authenticate, auth.requireRole('superadmin'), (req, res) => {
    const patch = (req.body && req.body.settings) || req.body || {};
    const before = db.getSettings();
    const { settings, applied } = db.updateSettings(patch, req.admin.username);
    const changedKeys = Object.keys(applied).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(applied[k]));

    // 配置变更即时生效的副作用
    if (changedKeys.includes('siteName')) io.emit('site-settings', { siteName: settings.siteName });
    if (changedKeys.includes('maintenanceMode') || changedKeys.includes('maintenanceMessage')) {
      io.emit('maintenance-mode', {
        enabled: settings.maintenanceMode,
        message: settings.maintenanceMessage
      });
    }
    if (changedKeys.includes('announcementBanner')) {
      io.emit('site-settings', { announcementBanner: settings.announcementBanner });
    }

    audit(req, 'settings_update', changedKeys.join(','), { changed: applied, keys: changedKeys });
    res.json({ ok: true, settings, changed: changedKeys });
  });

  // 用当前配置试搜一次，验证音乐接口有没有配错
  router.post('/music/test-search', auth.authenticate, auth.requireRole('superadmin'), async (req, res) => {
    const keyword = String((req.body && req.body.keyword) || '').trim() || '周杰伦';
    try {
      const result = await ops.testMusicSearch(keyword);
      res.json({ ok: true, keyword, items: result.items, source: result.source, endpoint: result.endpoint });
    } catch (err) {
      res.status(400).json({ error: err.message || '搜索失败' });
    }
  });

  // ------------------------------------------------------------ 公告
  router.get('/announcements', auth.authenticate, (req, res) => {
    res.json({ ok: true, items: db.listAnnouncements(100), active: db.activeAnnouncement() });
  });

  router.post('/announcements', auth.authenticate, (req, res) => {
    const title = String((req.body && req.body.title) || '').trim();
    const content = String((req.body && req.body.content) || '').trim();
    const level = ['info', 'warning', 'danger'].includes(req.body && req.body.level) ? req.body.level : 'info';
    const popup = !(req.body && req.body.popup === false);
    const hours = toInt(req.body && req.body.expiresHours, 0, 0, 24 * 30);
    if (!title) return res.status(400).json({ error: '请填写公告标题' });
    if (!content) return res.status(400).json({ error: '请填写公告内容' });

    const item = db.createAnnouncement({
      title,
      content,
      level,
      popup,
      expiresAt: hours > 0 ? Date.now() + hours * 3600000 : 0,
      createdBy: req.admin.username
    });
    const payload = { id: item.id, title, content, level, popup, createdAt: item.created_at };
    io.emit('announcement', payload);
    audit(req, 'announcement_publish', String(item.id), { title, level });
    res.json({ ok: true, item });
  });

  router.post('/announcements/:id/toggle', auth.authenticate, (req, res) => {
    const id = Number(req.params.id);
    const active = !!(req.body && req.body.active);
    db.setAnnouncementActive(id, active);
    // 重新启用时立刻推给在线用户；停用则通知前台撤下横幅
    if (active) {
      const item = db.activeAnnouncement();
      if (item && Number(item.id) === id) {
        io.emit('announcement', {
          id: item.id,
          title: item.title,
          content: item.content,
          level: item.level,
          popup: !!item.popup,
          createdAt: item.created_at
        });
      }
    } else {
      io.emit('announcement-removed', { id });
    }
    audit(req, 'announcement_toggle', String(id), { active });
    res.json({ ok: true, active });
  });

  router.delete('/announcements/:id', auth.authenticate, (req, res) => {
    const id = Number(req.params.id);
    db.deleteAnnouncement(id);
    io.emit('announcement-removed', { id });
    audit(req, 'announcement_delete', req.params.id);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ 日志
  router.get('/logs/admin', auth.authenticate, (req, res) => {
    res.json({ ok: true, ...db.listAdminLogs({
      page: toInt(req.query.page, 1, 1, 100000),
      size: toInt(req.query.size, 20, 1, 200),
      action: req.query.action
    }) });
  });

  router.get('/logs/rooms', auth.authenticate, (req, res) => {
    res.json({ ok: true, ...db.listRoomEvents({
      page: toInt(req.query.page, 1, 1, 100000),
      size: toInt(req.query.size, 20, 1, 200),
      kind: ROOM_KINDS.includes(req.query.kind) ? req.query.kind : '',
      event: req.query.event,
      roomCode: req.query.roomCode
    }) });
  });

  router.get('/logs/errors', auth.authenticate, (req, res) => {
    res.json({ ok: true, ...db.listErrorLogs({
      page: toInt(req.query.page, 1, 1, 100000),
      size: toInt(req.query.size, 20, 1, 200),
      level: req.query.level
    }) });
  });

  router.get('/logs/logins', auth.authenticate, (req, res) => {
    res.json({ ok: true, ...db.listLoginAttempts({
      page: toInt(req.query.page, 1, 1, 100000),
      size: toInt(req.query.size, 20, 1, 200),
      onlyFail: req.query.onlyFail === '1'
    }) });
  });

  router.get('/logs/music', auth.authenticate, (req, res) => {
    res.json({ ok: true, ...db.listMusicLogs({
      page: toInt(req.query.page, 1, 1, 100000),
      size: toInt(req.query.size, 20, 1, 200),
      roomCode: req.query.roomCode
    }) });
  });

  router.post('/logs/cleanup', auth.authenticate, auth.requireRole('superadmin'), (req, res) => {
    const days = toInt(req.body && req.body.days, db.getSettings().logRetentionDays, 1, 365);
    const result = db.cleanupLogs(days);
    audit(req, 'logs_cleanup', String(days) + ' 天前', result);
    res.json({ ok: true, removed: result, days });
  });

  // ------------------------------------------------------------ 连接管理
  router.get('/connections', auth.authenticate, (req, res) => {
    const result = db.listConnections({
      page: toInt(req.query.page, 1, 1, 100000),
      size: toInt(req.query.size, 20, 1, 200),
      onlyOnline: req.query.online === '1',
      ip: req.query.ip
    });
    const onlineIds = new Set(ctx.onlineSocketIds());
    result.items = result.items.map((c) => ({ ...c, live: onlineIds.has(c.socket_id) }));
    res.json({ ok: true, ...result, online: ctx.onlineSocketIds().length });
  });

  router.post('/connections/:socketId/kick', auth.authenticate, (req, res) => {
    const socketId = String(req.params.socketId);
    if (!ctx.onlineSocketIds().includes(socketId)) {
      return res.status(404).json({ error: '该连接已断开' });
    }
    ops.kickConnection(socketId, '被管理员强制下线');
    audit(req, 'connection_kick', socketId);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ 封禁
  router.get('/bans', auth.authenticate, (req, res) => {
    res.json({ ok: true, items: db.activeBans() });
  });

  router.post('/bans', auth.authenticate, auth.requireRole('superadmin'), (req, res) => {
    const ip = String((req.body && req.body.ip) || '').trim();
    const reason = String((req.body && req.body.reason) || '').trim();
    const minutes = toInt(req.body && req.body.minutes, 0, 0, 60 * 24 * 365);
    if (!/^[0-9a-fA-F:.]+$/.test(ip)) return res.status(400).json({ error: 'IP 格式不正确' });
    const ban = db.addBan({ ip, reason, minutes, createdBy: req.admin.username });
    audit(req, 'ip_ban', ip, { minutes, reason });
    // 已经在线的直接踢掉
    for (const socketId of ctx.onlineSocketIds()) {
      const meta = ctx.getSocketMeta(socketId);
      if (meta && meta.ip === ip) ops.kickConnection(socketId, '该 IP 已被封禁');
    }
    res.json({ ok: true, ban });
  });

  router.delete('/bans/:id', auth.authenticate, auth.requireRole('superadmin'), (req, res) => {
    db.removeBan(Number(req.params.id));
    audit(req, 'ip_unban', req.params.id);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ 系统信息
  router.get('/system', auth.authenticate, (req, res) => {
    res.json({
      ok: true,
      version,
      node: process.version,
      startedAt,
      uptime: Math.floor(process.uptime()),
      dataDir: db.DATA_DIR,
      dbPath: db.DB_PATH,
      dbSize: db.dbSizeBytes(),
      admins: db.listAdmins().length,
      rooms: db.listRoomHistory({ page: 1, size: 1 }).total,
      env: {
        port: process.env.PORT || 3000,
        nodeEnv: process.env.NODE_ENV || 'development',
        adminTokenTtlHours: Math.round(auth.tokenTtlSeconds / 3600)
      }
    });
  });

  // 统一兜底：管理接口不要掉到 SPA 或业务 404 里
  router.use((req, res) => {
    res.status(404).json({ error: '管理接口不存在' });
  });

  // 管理接口错误处理
  router.use((err, req, res, next) => {
    console.error('[admin] 接口异常', err);
    db.errorLog({ level: 'error', message: err.message, stack: err.stack, source: 'admin' });
    res.status(500).json({ error: '服务器内部错误' });
  });

  return router;
}

module.exports = { createAdminRouter, ROOM_KINDS, ROOM_KIND_LABEL };
