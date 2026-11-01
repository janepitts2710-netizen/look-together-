/* =========================================================
   星梦小筑 · 后台管理前端（原生 JS，无构建依赖）
   路由：hash 形式，如 #/dashboard、#/rooms/video
   ========================================================= */
(function () {
  'use strict';

  const TOKEN_KEY = 'look_admin_token';
  const API_BASE = '/api/admin';

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    admin: null,
    page: 'dashboard',
    data: {},
    counts: { video: 0, gomoku: 0, doudizhu: 0, music: 0 },
    expanded: new Set(),
    q: '',
    historyKind: '',
    logTab: 'admin',
    pager: {},
    pollTimer: null,
    countsTimer: null
  };

  // ---------------------------------------------------------------- 工具
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  const pad = (n) => String(n).padStart(2, '0');

  function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function fmtDate(ts) {
    if (!ts) return '—';
    const d = new Date(Number(ts));
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function ago(ts) {
    if (!ts) return '—';
    const diff = Math.max(0, Date.now() - Number(ts));
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    return Math.floor(diff / 86400000) + ' 天前';
  }
  function fmtDur(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return d + ' 天 ' + h + ' 小时';
    if (h) return h + ' 小时 ' + m + ' 分';
    if (m) return m + ' 分 ' + (s % 60) + ' 秒';
    return s + ' 秒';
  }
  function fmtClock(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = s % 60;
    return (h ? h + ':' : '') + pad(m) + ':' + pad(ss);
  }
  function fmtBytes(bytes) {
    const b = Number(bytes) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
  }
  function pct(part, total) {
    if (!total) return 0;
    return Math.min(100, Math.round((part / total) * 100));
  }

  function toast(message, type) {
    const wrap = $('#toast-wrap');
    const node = document.createElement('div');
    node.className = 'toast ' + (type === 'ok' ? 'ok' : type === 'err' ? 'err' : '');
    node.textContent = message;
    wrap.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .2s';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 220);
    }, type === 'err' ? 4200 : 2600);
  }

  let modalResolve = null;
  function confirmDialog(opts) {
    const options = opts || {};
    const mask = $('#modal');
    const okBtn = mask.querySelector('[data-modal="ok"]');
    const cancelBtn = mask.querySelector('[data-modal="cancel"]');
    $('#modal-title').textContent = options.title || '确认操作';
    $('#modal-body').innerHTML = options.message || '';
    okBtn.textContent = options.okText || '确定';
    okBtn.className = 'btn ' + (options.danger ? 'btn-danger' : 'btn-primary');
    mask.hidden = false;

    const finish = (val) => {
      mask.hidden = true;
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      mask.onclick = null;
      if (modalResolve) {
        const fn = modalResolve;
        modalResolve = null;
        fn(val);
      }
    };
    okBtn.onclick = () => finish(true);
    cancelBtn.onclick = () => finish(false);
    mask.onclick = (e) => { if (e.target === mask) finish(false); };

    return new Promise((resolve) => { modalResolve = resolve; });
  }

  // ---------------------------------------------------------------- 接口
  async function api(path, options) {
    const opts = options || {};
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers.Authorization = 'Bearer ' + state.token;
    let res;
    try {
      res = await fetch(API_BASE + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store'
      });
    } catch (err) {
      throw new Error('网络异常，无法连接服务器');
    }
    let data = {};
    try { data = await res.json(); } catch (err) { data = {}; }

    if (res.status === 401) {
      const code = data.code || '';
      logout(true);
      throw new Error(data.error || '登录已失效，请重新登录');
    }
    if (!res.ok) {
      throw new Error(data.error || ('请求失败（' + res.status + '）'));
    }
    return data;
  }

  // ---------------------------------------------------------------- 登录
  function showLogin(message) {
    stopPolling();
    $('#app-shell').hidden = true;
    $('#login-screen').hidden = false;
    const errBox = $('#login-error');
    if (message) {
      errBox.hidden = false;
      errBox.textContent = message;
    } else {
      errBox.hidden = true;
    }
    setTimeout(() => { try { $('#login-username').focus(); } catch (e) {} }, 60);
  }

  function logout(silent) {
    const oldToken = state.token;
    state.token = '';
    state.admin = null;
    localStorage.removeItem(TOKEN_KEY);
    if (oldToken && !silent) {
      // 通知后端吊销 token（失败也无所谓，token 到期自动失效）
      fetch(API_BASE + '/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + oldToken } }).catch(() => {});
    }
    showLogin(silent ? '登录状态已失效，请重新登录' : '');
    if (!silent) toast('已退出登录');
  }

  async function handleLogin(event) {
    event.preventDefault();
    const btn = $('#login-btn');
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    if (!username || !password) return;
    btn.disabled = true;
    btn.textContent = '登录中…';
    $('#login-error').hidden = true;
    try {
      const res = await fetch(API_BASE + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '登录失败');
      state.token = data.token;
      state.admin = data.admin;
      localStorage.setItem(TOKEN_KEY, data.token);
      $('#login-password').value = '';
      await bootShell();
      if (data.admin && data.admin.mustChangePassword) {
        toast('当前使用的是初始密码，请尽快修改', 'err');
        location.hash = '#/account';
      }
    } catch (err) {
      $('#login-error').hidden = false;
      $('#login-error').textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '登 录';
    }
  }

  // ---------------------------------------------------------------- 布局
  const NAV = [
    { group: '总览', items: [{ id: 'dashboard', label: '数据看板', ico: '◐' }] },
    {
      group: '房间管理',
      items: [
        { id: 'rooms/video', label: '视频房间', ico: '▤', badge: 'video' },
        { id: 'rooms/gomoku', label: '五子棋房间', ico: '⌗', badge: 'gomoku' },
        { id: 'rooms/doudizhu', label: '斗地主房间', ico: '♠', badge: 'doudizhu' },
        { id: 'rooms/music', label: '音乐房间', ico: '♪', badge: 'music' },
        { id: 'history', label: '历史房间', ico: '⏱' }
      ]
    },
    {
      group: '运营配置',
      items: [
        { id: 'settings', label: '系统配置', ico: '⚙' },
        { id: 'music-config', label: '音乐配置', ico: '♫' },
        { id: 'announcements', label: '公告通知', ico: '⚑' }
      ]
    },
    {
      group: '运维审计',
      items: [
        { id: 'connections', label: '连接管理', ico: '⇄' },
        { id: 'logs', label: '日志审计', ico: '▦' },
        { id: 'system', label: '系统信息', ico: 'ⓘ' }
      ]
    },
    { group: '账号', items: [{ id: 'account', label: '我的账号', ico: '◍' }] }
  ];

  function buildNav() {
    const html = NAV.map((group) => {
      const items = group.items.map((item) => (
        '<a class="nav-item" href="#/' + item.id + '" data-nav="' + item.id + '">'
        + '<span class="ico">' + item.ico + '</span>'
        + '<span>' + item.label + '</span>'
        + (item.badge ? '<span class="badge-dot" data-badge="' + item.badge + '">0</span>' : '')
        + '</a>'
      )).join('');
      return '<div class="nav-group">' + group.group + '</div>' + items;
    }).join('');
    $('#nav').innerHTML = html;
  }

  function syncNavActive() {
    $$('.nav-item').forEach((node) => {
      node.classList.toggle('active', node.getAttribute('data-nav') === state.page);
    });
  }

  function updateBadges() {
    Object.keys(state.counts).forEach((kind) => {
      const node = $('[data-badge="' + kind + '"]');
      if (node) node.textContent = state.counts[kind];
    });
  }

  async function refreshCounts() {
    try {
      const data = await api('/dashboard');
      state.counts = data.live.rooms;
      updateBadges();
      const online = data.live.onlineConnections;
      $('#online-count').textContent = online;
      if (state.page === 'dashboard') {
        state.data.dashboard = data;
        renderCurrent();
      }
    } catch (err) {
      /* 静默：不要把后台刷成报错页 */
    }
  }

  async function bootShell() {
    if (!state.admin) {
      const me = await api('/me');
      state.admin = me.admin;
    }
    $('#login-screen').hidden = true;
    $('#app-shell').hidden = false;
    $('#side-username').textContent = state.admin.username;
    $('#side-role').textContent = state.admin.role === 'superadmin' ? '超级管理员' : '普通管理员';
    $('#side-avatar').textContent = String(state.admin.username).slice(0, 1).toUpperCase();
    buildNav();
    await refreshCounts();
    await navigate(location.hash ? location.hash.replace(/^#\/?/, '') : 'dashboard', true);
    if (state.countsTimer) clearInterval(state.countsTimer);
    state.countsTimer = setInterval(refreshCounts, 15000);
  }

  // ---------------------------------------------------------------- 路由
  function currentRoute() {
    const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
    return raw;
  }

  async function navigate(route, isBoot) {
    const page = route || 'dashboard';
    if (!pages[page]) {
      location.hash = '#/dashboard';
      return;
    }
    state.page = page;
    state.q = '';
    syncNavActive();
    const meta = pages[page];
    $('#page-title').textContent = meta.title;
    $('#page-sub').textContent = meta.sub || '';
    $('#view').innerHTML = '<div class="card"><div class="empty">加载中…</div></div>';
    stopPolling();
    try {
      await meta.load();
      renderCurrent();
      if (meta.poll) {
        state.pollTimer = setInterval(() => {
          if (document.hidden) return;
          meta.load().then(renderCurrent).catch(() => {});
        }, meta.poll);
      }
    } catch (err) {
      $('#view').innerHTML = '<div class="card"><div class="empty"><span class="big">⚠</span>' + esc(err.message) + '</div></div>';
      if (!isBoot) toast(err.message, 'err');
    }
  }

  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function renderCurrent() {
    const meta = pages[state.page];
    if (!meta) return;
    $('#view').innerHTML = meta.render();
    if (typeof meta.mount === 'function') meta.mount();
  }

  // ---------------------------------------------------------------- 复用片段
  function table(cols, rows, emptyText) {
    if (!rows || !rows.length) {
      return '<div class="empty"><span class="big">◌</span>' + esc(emptyText || '暂无数据') + '</div>';
    }
    return '<div class="table-wrap"><table><thead><tr>'
      + cols.map((c) => '<th' + (c.width ? ' style="width:' + c.width + '"' : '') + '>' + c.title + '</th>').join('')
      + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }

  function pager(key, result, actPrefix) {
    if (!result || !result.total) return '';
    return '<div class="pager">'
      + '<span>共 ' + result.total + ' 条 · 第 ' + result.page + ' / ' + result.pages + ' 页</span>'
      + '<button class="btn btn-ghost btn-sm" data-act="page" data-key="' + key + '" data-dir="-1"'
      + (result.page <= 1 ? ' disabled' : '') + '>上一页</button>'
      + '<button class="btn btn-ghost btn-sm" data-act="page" data-key="' + key + '" data-dir="1"'
      + (result.page >= result.pages ? ' disabled' : '') + '>下一页</button>'
      + '</div>';
  }

  function statCard(o) {
    return '<div class="stat ' + (o.tone || '') + '">'
      + '<div class="label">' + o.label + '</div>'
      + '<div class="value">' + o.value + (o.unit ? '<small>' + o.unit + '</small>' : '') + '</div>'
      + '<div class="foot">' + (o.foot || '') + '</div>'
      + '</div>';
  }

  function typeLabel(kind) {
    return { video: '视频', gomoku: '五子棋', doudizhu: '斗地主', music: '音乐' }[kind] || kind;
  }

  const EVENT_LABEL = {
    create: '创建房间',
    join: '加入房间',
    leave: '离开房间',
    disconnect: '连接断开',
    close: '解散房间',
    transfer: '转让房主',
    reset: '重置对局',
    clear_queue: '清空队列',
    remove_song: '移除歌曲',
    force_play: '强制切歌',
    force_next: '下一首',
    idle_destroy: '空闲销毁',
    admin_close: '管理员解散',
    admin_kick: '管理员踢人',
    admin_transfer: '管理员转让',
    admin_reset: '管理员重置',
    admin_clear_queue: '管理员清空队列',
    admin_remove_song: '管理员移除歌曲',
    admin_force_play: '管理员切歌',
    admin_force_next: '管理员下一首'
  };
  function eventLabel(event) {
    return EVENT_LABEL[event] || event;
  }

  // 管理操作的动作码 → 中文文案（后端 audit() 写入的 action）
  const ACTION_LABEL = {
    login: '登录后台',
    login_failed: '登录失败',
    logout: '退出登录',
    password_change: '修改密码',
    password_change_failed: '修改密码失败',
    admin_create: '新增管理员',
    admin_update: '修改管理员',
    admin_reset_password: '重置管理员密码',
    admin_delete: '删除管理员',
    room_close: '强制关房',
    room_kick: '踢出成员',
    room_transfer: '转让房主',
    room_reset: '重置对局',
    music_queue_clear: '清空队列',
    music_queue_remove: '移除歌曲',
    music_play: '强制切歌',
    music_next: '强制下一首',
    settings_update: '修改系统配置',
    announcement_publish: '发布公告',
    announcement_toggle: '启停公告',
    announcement_delete: '删除公告',
    logs_cleanup: '清理日志',
    connection_kick: '强制断线',
    ip_ban: '封禁 IP',
    ip_unban: '解除封禁'
  };
  function actionLabel(action) {
    return ACTION_LABEL[action] || action;
  }

  // ---------------------------------------------------------------- 页面：看板
  const pages = {};

  pages.dashboard = {
    title: '数据看板',
    sub: '在线、房间、运行状态一目了然',
    poll: 8000,
    async load() {
      state.data.dashboard = await api('/dashboard');
      state.counts = state.data.dashboard.live.rooms;
      updateBadges();
      $('#online-count').textContent = state.data.dashboard.live.onlineConnections;
    },
    render() {
      const d = state.data.dashboard;
      if (!d) return '<div class="card"><div class="empty">暂无数据</div></div>';
      const live = d.live;
      const hist = d.history;
      const mem = d.server.memory;
      const memUsedPct = pct(mem.systemTotal - mem.systemFree, mem.systemTotal);
      const maxTrend = Math.max.apply(null, d.trend.map((t) => t.total).concat([1]));

      const trendBars = d.trend.map((t) => {
        const h = 8 + Math.round((t.total / maxTrend) * 84);
        return '<div class="bar-wrap">'
          + '<span class="bar-num">' + t.total + '</span>'
          + '<div class="bar" style="height:' + h + '%" title="' + esc(t.label + '：' + t.total + ' 个房间') + '"></div>'
          + '<span class="bar-label">' + esc(t.label) + '</span>'
          + '</div>';
      }).join('');

      const events = (d.recentEvents || []).map((e) => (
        '<div class="tl-item"><span class="tl-dot"></span><div class="tl-body">'
        + '<div class="t">' + esc(typeLabel(e.kind)) + '房间 <b>' + esc(e.room_code) + '</b> · ' + esc(eventLabel(e.event))
        + (e.ip ? ' · <span class="mono">' + esc(e.ip) + '</span>' : '')
        + '</div><div class="m">' + fmtTime(e.created_at) + '</div></div></div>'
      )).join('') || '<div class="empty">暂无房间事件</div>';

      const actions = (d.recentActions || []).map((a) => (
        '<div class="tl-item"><span class="tl-dot"></span><div class="tl-body">'
        + '<div class="t">' + esc(a.admin_name || '系统') + ' · ' + esc(actionLabel(a.action)) + (a.target ? ' · ' + esc(a.target) : '') + '</div>'
        + '<div class="m">' + fmtTime(a.created_at) + (a.ip ? ' · ' + esc(a.ip) : '') + '</div></div></div>'
      )).join('') || '<div class="empty">暂无管理操作</div>';

      const maintenance = d.settings.maintenanceMode
        ? '<div class="form-note" style="border-color:rgba(251,191,36,.35);background:rgba(251,191,36,.1);color:#ffdf9e">站点处于「维护模式」：新用户无法创建 / 加入房间。</div>'
        : '';

      const ann = d.settings.announcement
        ? '<div class="form-note">当前公告：<b>' + esc(d.settings.announcement.title) + '</b> · ' + esc(d.settings.announcement.content).slice(0, 60) + '</div>'
        : '';

      return maintenance + ann
        + '<div class="grid cols-4 section">'
        + statCard({ label: '当前在线连接', value: live.onlineConnections, unit: '人', tone: 'accent', foot: 'Socket 会话数 ' + live.socketClients })
        + statCard({ label: '视频房间', value: live.rooms.video, unit: '个', tone: 'cyan', foot: '共 ' + (live.members.video || 0) + ' 人在房间' })
        + statCard({ label: '棋牌房间', value: (live.rooms.gomoku + live.rooms.doudizhu), unit: '个', tone: 'green', foot: '五子棋 ' + live.rooms.gomoku + ' · 斗地主 ' + live.rooms.doudizhu })
        + statCard({ label: '音乐房间', value: live.rooms.music, unit: '个', tone: 'amber', foot: '共 ' + (live.members.music || 0) + ' 人听歌' })
        + '</div>'

        + '<div class="grid cols-4 section">'
        + statCard({ label: '历史房间总数', value: hist.historyTotal, unit: '个', foot: '今日新建 ' + hist.todayCreated + ' 个' })
        + statCard({ label: '单房间人数峰值', value: hist.peakMembers, unit: '人', foot: '历史最高同房人数' })
        + statCard({ label: '服务器运行时长', value: fmtDur(d.server.uptime), foot: '启动于 ' + fmtDate(d.server.startedAt) })
        + statCard({ label: '内存占用', value: fmtBytes(mem.rss), foot: '堆内存 ' + fmtBytes(mem.heapUsed) + ' / ' + fmtBytes(mem.heapTotal) })
        + '</div>'

        + '<div class="grid cols-2-1 section">'
        + '<div class="card"><div class="card-head"><div><h3>近 7 天房间创建趋势</h3><div class="sub">按天统计，包含所有房间类型</div></div></div>'
        + '<div class="trend">' + trendBars + '</div></div>'
        + '<div class="card"><div class="card-head"><div><h3>服务器状态</h3><div class="sub">Node ' + esc(d.server.node) + ' · PID ' + d.server.pid + '</div></div></div>'
        + '<dl class="kv">'
        + '<dt>系统</dt><dd>' + esc(d.server.platform) + '</dd>'
        + '<dt>CPU 核心</dt><dd>' + d.server.cpuCount + ' 核 · 负载 ' + d.server.loadavg.join(' / ') + '</dd>'
        + '<dt>系统内存</dt><dd>' + fmtBytes(mem.systemTotal - mem.systemFree) + ' / ' + fmtBytes(mem.systemTotal) + '</dd>'
        + '<dt>数据库</dt><dd>' + fmtBytes(d.server.dbSize) + '</dd>'
        + '<dt>24h 错误</dt><dd>' + hist.errors24h + ' 条</dd>'
        + '<dt>24h 管理操作</dt><dd>' + hist.adminLogs24h + ' 次</dd>'
        + '<dt>封禁 IP</dt><dd>' + d.settings.activeBans + ' 个</dd>'
        + '</dl>'
        + '<div style="margin-top:14px"><div class="meter"><i style="width:' + memUsedPct + '%"></i></div>'
        + '<div class="foot" style="font-size:11.5px;color:var(--muted);margin-top:6px">系统内存使用率 ' + memUsedPct + '%</div></div>'
        + '</div></div>'

        + '<div class="grid cols-2">'
        + '<div class="card"><div class="card-head"><div><h3>最近房间事件</h3><div class="sub">创建 / 加入 / 离开 / 解散</div></div>'
        + '<a class="btn-link" href="#/logs">查看全部</a></div><div class="timeline">' + events + '</div></div>'
        + '<div class="card"><div class="card-head"><div><h3>最近管理操作</h3><div class="sub">审计日志</div></div>'
        + '<a class="btn-link" href="#/logs">查看全部</a></div><div class="timeline">' + actions + '</div></div>'
        + '</div>';
    }
  };

  // ---------------------------------------------------------------- 页面：房间
  const ROOM_META = {
    video: {
      title: '视频房间',
      sub: '查看在线观影房，可踢人、转让房主、强制解散',
      columns: ['房间号', '房主', '人数', '当前视频', '播放', '创建时间', '操作']
    },
    gomoku: {
      title: '五子棋房间',
      sub: '查看对局状态，可重置对局或解散房间',
      columns: ['房间号', '房主', '人数', '对局状态', '手数', '创建时间', '操作']
    },
    doudizhu: {
      title: '斗地主房间',
      sub: '查看三人牌局状态，可重置或解散',
      columns: ['房间号', '房主', '人数', '阶段', '地主', '创建时间', '操作']
    },
    music: {
      title: '音乐房间',
      sub: '查看听歌房与播放队列，可强制切歌、清空队列',
      columns: ['房间号', '房主', '人数', '正在播放', '队列', '创建时间', '操作']
    }
  };

  function kindFromPage() {
    return state.page.split('/')[1];
  }

  function renderMembers(room, kind) {
    const rows = (room.members || []).map((m) => (
      '<div class="member">'
      + (m.isHost ? '<span class="badge accent">房主</span>' : '<span class="badge mute">成员</span>')
      + '<span class="sid">' + esc(m.socketId) + '</span>'
      + '<span class="meta">' + esc(m.ip || '未知 IP') + ' · ' + esc(m.device || '未知设备') + '</span>'
      + '<span class="meta">进入 ' + fmtTime(m.connectedAt) + '</span>'
      + '<span class="spacer"></span>'
      + (m.isHost ? '' : '<button class="btn btn-ghost btn-sm" data-act="room-transfer" data-kind="' + kind + '" data-room="' + esc(room.id) + '" data-socket="' + esc(m.socketId) + '">设为房主</button>'
        + '<button class="btn btn-danger btn-sm" data-act="room-kick" data-kind="' + kind + '" data-room="' + esc(room.id) + '" data-socket="' + esc(m.socketId) + '">踢出</button>')
      + '</div>'
    )).join('') || '<div class="empty">房间里还没有成员</div>';

    let extra = '';
    if (kind === 'music') {
      const items = (room.queue || []).map((song) => (
        '<div class="queue-item' + (song.index === room.currentIndex ? ' now' : '') + '">'
        + '<span class="idx">' + (song.index + 1) + '</span>'
        + '<span class="name">' + esc(song.title) + (song.author ? ' <span class="who">· ' + esc(song.author) + '</span>' : '') + '</span>'
        + '<span class="who">' + esc(song.addedByIp || '') + '</span>'
        + '<button class="btn-link" data-act="queue-play" data-room="' + esc(room.id) + '" data-index="' + song.index + '">播放</button>'
        + '<button class="btn-link danger" data-act="queue-remove" data-room="' + esc(room.id) + '" data-index="' + song.index + '">移除</button>'
        + '</div>'
      )).join('') || '<div class="empty">队列为空</div>';

      extra = '<h4>播放队列（' + (room.queue || []).length + ' 首）</h4>'
        + '<div class="queue-list">' + items + '</div>'
        + '<div style="display:flex;gap:8px;margin-top:10px">'
        + '<button class="btn btn-ghost btn-sm" data-act="queue-next" data-room="' + esc(room.id) + '">下一首</button>'
        + '<button class="btn btn-danger btn-sm" data-act="queue-clear" data-room="' + esc(room.id) + '">清空队列</button>'
        + '</div>';
    }

    if (kind === 'gomoku' && room.players && room.players.length) {
      extra = '<h4>对局玩家</h4><div class="member-list">'
        + room.players.map((p) => (
          '<div class="member"><span class="badge ' + (p.color === 'black' ? 'mute' : 'info') + '">' + (p.color === 'black' ? '黑棋' : '白棋') + '</span>'
          + '<span class="sid">' + esc(p.socketId) + '</span>'
          + '<span class="meta">' + esc(p.ip || '') + ' · ' + esc(p.device || '') + '</span></div>'
        )).join('') + '</div>';
    }

    if (kind === 'doudizhu') {
      extra = '<h4>座位</h4><div class="member-list">'
        + (room.seats || []).map((s) => (
          s.empty
            ? '<div class="member"><span class="badge mute">空位</span><span class="meta">座位 ' + (s.seat + 1) + '</span></div>'
            : '<div class="member"><span class="badge ' + (s.isLandlord ? 'warn' : 'mute') + '">' + esc(s.name) + (s.isLandlord ? ' · 地主' : '') + '</span>'
              + '<span class="sid">' + esc(s.socketId) + '</span>'
              + '<span class="meta">' + esc(s.ip || '') + ' · 手牌 ' + s.cardCount + ' 张</span></div>'
        )).join('') + '</div>';
    }

    return '<div class="sub-panel"><h4>房间成员（' + (room.members || []).length + '）</h4>'
      + '<div class="member-list">' + rows + '</div>'
      + (extra ? '<div style="margin-top:14px">' + extra + '</div>' : '')
      + '</div>';
  }

  ['video', 'gomoku', 'doudizhu', 'music'].forEach((kind) => {
    pages['rooms/' + kind] = {
      title: ROOM_META[kind].title,
      sub: ROOM_META[kind].sub,
      poll: 6000,
      async load() {
        const q = state.q ? '?q=' + encodeURIComponent(state.q) : '';
        state.data['rooms_' + kind] = await api('/rooms/' + kind + q);
        state.counts[kind] = state.data['rooms_' + kind].total;
        updateBadges();
      },
      render() {
        const data = state.data['rooms_' + kind];
        if (!data) return '<div class="card"><div class="empty">暂无数据</div></div>';
        const meta = ROOM_META[kind];
        const rows = [];
        (data.rooms || []).forEach((room) => {
          const expanded = state.expanded.has(room.id);
          let cells = '';
          if (kind === 'video') {
            cells = '<td>' + (room.video
              ? '<span class="strong">' + esc((room.video.title || '').slice(0, 28) || '未设置标题') + '</span>'
              + (room.video.part ? '<div class="mono" style="color:var(--muted);font-size:11px">' + esc(room.video.part) + '</div>' : '')
              : '<span class="badge mute">未添加视频</span>') + '</td>'
              + '<td>' + (room.playing
                ? '<span class="badge ok">播放中</span>'
                : '<span class="badge mute">已暂停</span>')
              + '<div class="mono" style="font-size:11px;color:var(--muted);margin-top:2px">' + fmtClock(room.time) + ' · ' + room.rate + 'x</div></td>';
          } else if (kind === 'gomoku') {
            cells = '<td>' + (room.winner
              ? '<span class="badge warn">' + esc(room.statusText) + '</span>'
              : room.players.length < 2
                ? '<span class="badge mute">等待对手</span>'
                : '<span class="badge ok">对局中</span>') + '</td>'
              + '<td class="mono">' + room.moves + '</td>';
          } else if (kind === 'doudizhu') {
            const phaseText = { waiting: '等待中', bidding: '叫地主', playing: '出牌中', ended: '已结束' }[room.phase] || room.phase;
            const tone = room.phase === 'playing' || room.phase === 'bidding' ? 'ok' : room.phase === 'ended' ? 'warn' : 'mute';
            cells = '<td><span class="badge ' + tone + '">' + esc(phaseText) + '</span>'
              + '<div class="mono" style="font-size:11px;color:var(--muted);margin-top:2px">' + esc(room.statusText || '') + '</div></td>'
              + '<td class="mono">' + (room.landlordIndex >= 0 ? '座位 ' + (room.landlordIndex + 1) : '—') + '</td>';
          } else {
            cells = '<td>' + (room.currentSong
              ? '<span class="strong">' + esc(room.currentSong.title) + '</span>'
              + '<div style="font-size:11px;color:var(--muted)">' + esc(room.currentSong.author || '') + '</div>'
              : '<span class="badge mute">未播放</span>') + '</td>'
              + '<td><span class="badge info">' + room.queue.length + ' 首</span>'
              + '<span class="badge ' + (room.playing ? 'ok' : 'mute') + '" style="margin-left:4px">' + (room.playing ? '播放中' : '暂停') + '</span></td>';
          }

          rows.push('<tr>'
            + '<td><span class="room-code" data-act="copy" data-text="' + esc(room.shareLink) + '" title="点击复制分享链接">' + esc(room.id) + '</span></td>'
            + '<td><div class="strong mono">' + esc(room.hostIp || '未知') + '</div>'
            + '<div style="font-size:11px;color:var(--muted)">' + esc(room.hostDevice || '') + '</div></td>'
            + '<td><span class="badge accent">' + room.memberCount + ' 人</span></td>'
            + cells
            + '<td class="mono" style="font-size:11.5px;color:var(--muted)">' + fmtTime(room.createdAt) + '</td>'
            + '<td><div class="row-actions">'
            + '<button class="btn btn-ghost btn-sm" data-act="toggle" data-room="' + esc(room.id) + '">' + (expanded ? '收起' : '成员') + '</button>'
            + (kind === 'gomoku' || kind === 'doudizhu'
              ? '<button class="btn btn-ghost btn-sm" data-act="room-reset" data-kind="' + kind + '" data-room="' + esc(room.id) + '">重置</button>'
              : '')
            + '<button class="btn btn-danger btn-sm" data-act="room-close" data-kind="' + kind + '" data-room="' + esc(room.id) + '">解散</button>'
            + '</div></td>'
            + '</tr>');

          if (expanded) {
            rows.push('<tr class="sub-row"><td colspan="7">' + renderMembers(room, kind) + '</td></tr>');
          }
        });

        return '<div class="toolbar">'
          + '<div class="search"><input type="text" id="room-search" placeholder="搜索房间号 / IP / 视频标题" value="' + esc(state.q) + '" /></div>'
          + '<span class="badge info">当前 ' + data.total + ' 个房间</span>'
          + '<span class="grow"></span>'
          + '<button class="btn btn-ghost btn-sm" data-act="refresh">刷新</button>'
          + '</div>'
          + '<div class="card">'
          + '<div class="card-head"><div><h3>' + meta.title + '列表</h3><div class="sub">每 6 秒自动刷新 · 点击房间号可复制分享链接</div></div></div>'
          + table(meta.columns.map((c, i) => ({ title: c, width: i === 6 ? '250px' : undefined })), rows, '当前没有在线房间')
          + '</div>';
      },
      mount() {
        const input = $('#room-search');
        if (!input) return;
        input.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          state.q = input.value.trim();
          state.data['rooms_' + kind] = null;
          pages['rooms/' + kind].load().then(renderCurrent).catch((err) => toast(err.message, 'err'));
        });
      }
    };
  });

  // ---------------------------------------------------------------- 页面：历史房间
  pages.history = {
    title: '历史房间',
    sub: '所有房间的创建与关闭记录（持久化在 SQLite）',
    async load() {
      const page = state.pager.history || 1;
      const kind = state.historyKind ? '&kind=' + state.historyKind : '';
      state.data.history = await api('/rooms/history?page=' + page + '&size=20' + kind);
    },
    render() {
      const data = state.data.history;
      if (!data) return '<div class="card"><div class="empty">加载中…</div></div>';
      const PHASE_TEXT = { waiting: '等待中', bidding: '叫地主', playing: '出牌中', ended: '已结束' };
      const rows = (data.items || []).map((r) => {
        const meta = (() => { try { return JSON.parse(r.meta || '{}'); } catch (e) { return {}; } })();
        const detail = meta.video && meta.video.title ? meta.video.title
          : meta.current ? '播放：' + meta.current
            : meta.status ? meta.status
              : meta.phase ? PHASE_TEXT[meta.phase] || meta.phase : '—';
        return '<tr>'
          + '<td class="mono">#' + r.id + '</td>'
          + '<td><span class="badge ' + (r.kind === 'video' ? 'info' : r.kind === 'music' ? 'warn' : 'accent') + '">' + typeLabel(r.kind) + '</span></td>'
          + '<td class="mono strong">' + esc(r.room_code) + '</td>'
          + '<td class="mono">' + esc(r.host_ip || '—') + '</td>'
          + '<td class="mono">' + r.peak_members + '</td>'
          + '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(detail) + '</td>'
          + '<td>' + fmtTime(r.created_at) + '</td>'
          + '<td>' + (r.status === 'open'
            ? '<span class="badge ok">进行中</span>'
            : '<span class="badge mute">已关闭</span><div style="font-size:11px;color:var(--muted)">' + esc(r.close_reason || '') + '</div>') + '</td>'
          + '<td>' + (r.closed_at ? fmtTime(r.closed_at) : '—') + '</td>'
          + '</tr>';
      });

      return '<div class="tabs">'
        + ['', 'video', 'gomoku', 'doudizhu', 'music'].map((k) => (
          '<span class="tab' + (state.historyKind === k ? ' active' : '') + '" data-act="hist-kind" data-kind="' + k + '">' + (k ? typeLabel(k) : '全部') + '</span>'
        )).join('')
        + '</div>'
        + '<div class="card"><div class="card-head"><div><h3>房间记录</h3><div class="sub">服务重启后仍保留，便于回溯</div></div></div>'
        + table([
          { title: 'ID', width: '70px' }, { title: '类型', width: '90px' }, { title: '房间号' }, { title: '房主 IP' },
          { title: '峰值人数', width: '90px' }, { title: '内容' }, { title: '创建时间' }, { title: '状态', width: '110px' }, { title: '关闭时间' }
        ], rows, '还没有房间记录')
        + pager('history', data)
        + '</div>';
    }
  };

  // ---------------------------------------------------------------- 页面：系统配置
  const SETTING_FIELDS = {
    general: [
      { key: 'siteName', label: '站点名称', type: 'text', ph: '星梦小筑' },
      { key: 'bilibiliResolveEnabled', label: '视频解析开关', type: 'switch', hint: '控制 /api/video/resolve 与 /api/bilibili/resolve，关闭后统一返回 403' },
      { key: 'maxUploadMB', label: '上传文件大小上限（MB）', type: 'number', min: 1, max: 4096 },
      { key: 'roomMaxMembers', label: '房间人数上限', type: 'number', min: 2, max: 50, hint: '视频房间与音乐房间共用' },
      { key: 'roomIdleDestroyMinutes', label: '房间空闲自动销毁（分钟）', type: 'number', min: 0, max: 1440, hint: '填 0 表示关闭自动销毁' },
      { key: 'allowMemberControlPlayback', label: '允许成员控制播放', type: 'switch', hint: '关闭后只有音乐房房主能播放 / 暂停 / 切歌' },
      { key: 'maintenanceMode', label: '维护模式', type: 'switch', hint: '开启后新用户不能创建或加入房间' },
      { key: 'maintenanceMessage', label: '维护提示文案', type: 'text', ph: '服务器正在维护，稍后回来～' },
      { key: 'announcementBanner', label: '全站顶部横幅', type: 'text', ph: '留空则不展示' },
      { key: 'loginMaxFails', label: '登录失败锁定次数', type: 'number', min: 3, max: 20 },
      { key: 'loginLockMinutes', label: '锁定时长（分钟）', type: 'number', min: 1, max: 1440 },
      { key: 'logRetentionDays', label: '日志默认保留天数', type: 'number', min: 1, max: 365 },
      { key: 'adminIpWhitelist', label: '后台 IP 白名单', type: 'list', full: true, ph: '192.168.1.10\n192.168.1.*', hint: '每行一个 IP，支持 192.168.1.* 通配；留空表示不限制（改错会把自己锁在外面，请谨慎）' }
    ],
    music: [
      { key: 'musicSource', label: '音乐搜索来源', type: 'select', options: [['netease', '网易云公开接口（默认）'], ['meting', '自建 Meting 接口']] },
      { key: 'metingApiUrl', label: 'Meting 接口地址', type: 'text', ph: 'https://api.example.com/api', hint: '留空则回落到网易云公开接口' },
      { key: 'dailyRecommendPlaylist', label: '每日推荐歌单 ID', type: 'text', full: true, ph: '3778678,3779629', hint: '多个用逗号分隔，按天轮换；留空则使用内置榜单' },
      { key: 'bannedSongs', label: '禁播歌曲', type: 'list', full: true, ph: '466122628\n某首歌名', hint: '每行一条：歌曲 ID 或歌名 / 歌手关键词（至少 2 个字）' }
    ]
  };

  function renderFields(fields, settings, disabled) {
    return fields.map((f) => {
      const value = settings[f.key];
      const dis = disabled ? ' disabled' : '';
      let control = '';
      if (f.type === 'switch') {
        control = '<label class="switch"><input type="checkbox" name="' + f.key + '"' + (value ? ' checked' : '') + dis + ' />'
          + '<span class="track"></span><span style="font-size:12.5px;color:var(--text-dim)">' + (value ? '已开启' : '已关闭') + '</span></label>';
      } else if (f.type === 'number') {
        control = '<input type="number" name="' + f.key + '" value="' + esc(value) + '" min="' + f.min + '" max="' + f.max + '"' + dis + ' />';
      } else if (f.type === 'select') {
        control = '<select name="' + f.key + '"' + dis + '>' + f.options.map((o) => (
          '<option value="' + esc(o[0]) + '"' + (String(value) === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>'
        )).join('') + '</select>';
      } else if (f.type === 'list') {
        const text = Array.isArray(value) ? value.join('\n') : String(value || '');
        control = '<textarea name="' + f.key + '"' + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : '') + dis + '>' + esc(text) + '</textarea>';
      } else {
        control = '<input type="text" name="' + f.key + '" value="' + esc(value == null ? '' : value) + '"'
          + (f.ph ? ' placeholder="' + esc(f.ph) + '"' : '') + dis + ' />';
      }
      return '<div class="field' + (f.full ? ' full' : '') + '"><span>' + esc(f.label) + '</span>'
        + control + (f.hint ? '<span class="hint">' + esc(f.hint) + '</span>' : '') + '</div>';
    }).join('');
  }

  function collectSettings(fields) {
    const out = {};
    fields.forEach((f) => {
      const node = $('[name="' + f.key + '"]');
      if (!node) return;
      if (f.type === 'switch') out[f.key] = node.checked;
      else if (f.type === 'number') out[f.key] = Number(node.value);
      else if (f.type === 'list') out[f.key] = node.value.split('\n').map((s) => s.trim()).filter(Boolean);
      else out[f.key] = node.value;
    });
    return out;
  }

  async function loadSettings() {
    const data = await api('/settings');
    state.data.settings = data.settings;
    state.data.schema = data.schema;
    state.data.settingsLoaded = true;
  }

  function settingsPage(fields, group, title, sub) {
    return {
      title: title,
      sub: sub,
      async load() { await loadSettings(); },
      render() {
        const settings = state.data.settings;
        if (!settings) return '<div class="card"><div class="empty">加载中…</div></div>';
        const isSuper = state.admin && state.admin.role === 'superadmin';
        return (isSuper ? '' : '<div class="form-note">当前账号是普通管理员，只能查看配置，无法保存修改。</div>')
          + '<form data-form="settings" data-group="' + group + '">'
          + '<div class="card"><div class="card-head"><div><h3>' + esc(title) + '</h3><div class="sub">' + esc(sub) + '</div></div></div>'
          + '<div class="form-grid">' + renderFields(fields, settings, !isSuper) + '</div>'
          + (isSuper ? '<div class="form-actions"><button type="submit" class="btn btn-primary">保存配置</button></div>' : '')
          + '</div></form>'
          + (group === 'music'
            ? '<div class="card" style="margin-top:16px"><div class="card-head"><div><h3>接口连通性测试</h3><div class="sub">用当前配置真实搜索一次，确认接口可用</div></div></div>'
            + '<div class="toolbar" style="margin-bottom:0"><div class="grow"><input type="text" id="music-test-keyword" placeholder="输入歌名，例如 晴天" value="晴天" /></div>'
            + '<button class="btn btn-ghost" data-act="music-test">测试搜索</button></div>'
            + '<div id="music-test-result" style="margin-top:14px"></div></div>'
            : '');
      },
      mount() {
        $$('[name]').forEach((node) => {
          if (node.type === 'checkbox' && node.closest('.switch')) {
            node.addEventListener('change', () => {
              const text = node.closest('.switch').querySelector('span:last-child');
              if (text) text.textContent = node.checked ? '已开启' : '已关闭';
            });
          }
        });
      }
    };
  }

  pages.settings = settingsPage(SETTING_FIELDS.general, 'general', '系统配置', '站点开关、限额与安全策略');
  pages['music-config'] = settingsPage(SETTING_FIELDS.music, 'music', '音乐配置', '搜索来源、推荐歌单与禁播歌曲');

  // ---------------------------------------------------------------- 页面：公告
  pages.announcements = {
    title: '公告通知',
    sub: '发布全站公告，房间里会实时弹窗',
    async load() {
      state.data.announcements = await api('/announcements');
    },
    render() {
      const data = state.data.announcements;
      if (!data) return '<div class="card"><div class="empty">加载中…</div></div>';
      const rows = (data.items || []).map((a) => (
        '<tr>'
        + '<td class="mono">#' + a.id + '</td>'
        + '<td><span class="strong">' + esc(a.title) + '</span><div style="font-size:11.5px;color:var(--muted);max-width:420px">' + esc(a.content).slice(0, 80) + '</div></td>'
        + '<td><span class="badge ' + (a.level === 'danger' ? 'danger' : a.level === 'warning' ? 'warn' : 'info') + '">' + esc(a.level) + '</span></td>'
        + '<td>' + (a.popup ? '<span class="badge accent">弹窗</span>' : '<span class="badge mute">仅横幅</span>') + '</td>'
        + '<td>' + (a.active ? '<span class="badge ok">生效中</span>' : '<span class="badge mute">已停用</span>') + '</td>'
        + '<td class="mono" style="font-size:11.5px">' + fmtTime(a.created_at) + '</td>'
        + '<td class="mono" style="font-size:11.5px">' + (a.expires_at ? fmtTime(a.expires_at) : '长期') + '</td>'
        + '<td><div class="row-actions">'
        + '<button class="btn btn-ghost btn-sm" data-act="ann-toggle" data-id="' + a.id + '" data-active="' + (a.active ? '1' : '0') + '">' + (a.active ? '停用' : '启用') + '</button>'
        + '<button class="btn btn-danger btn-sm" data-act="ann-del" data-id="' + a.id + '">删除</button>'
        + '</div></td></tr>'
      ));

      return '<div class="grid cols-2-1">'
        + '<div class="card"><div class="card-head"><div><h3>发布新公告</h3><div class="sub">发布后会立即推送给所有在线用户</div></div></div>'
        + '<form data-form="announcement">'
        + '<div class="form-grid">'
        + '<label class="field"><span>标题</span><input type="text" name="title" placeholder="例如：今晚 22:00 维护升级" required /></label>'
        + '<label class="field"><span>级别</span><select name="level"><option value="info">普通通知</option><option value="warning">重要提醒</option><option value="danger">紧急公告</option></select></label>'
        + '<label class="field full"><span>内容</span><textarea name="content" placeholder="公告正文，支持换行" required></textarea></label>'
        + '<label class="field"><span>有效期（小时）</span><input type="number" name="expiresHours" value="0" min="0" max="720" /><span class="hint">0 表示长期有效</span></label>'
        + '<div class="field"><span>自动弹窗</span><div style="padding-top:8px"><label class="switch"><input type="checkbox" name="popup" checked /><span class="track"></span><span style="font-size:12.5px;color:var(--text-dim)">打开页面即弹出，每人只弹一次</span></label></div></div>'
        + '</div>'
        + '<div class="form-actions"><button type="submit" class="btn btn-primary">发布公告</button></div>'
        + '</form></div>'
        + '<div class="card"><div class="card-head"><div><h3>已发布公告</h3><div class="sub">最多显示最近 100 条</div></div></div>'
        + '<div class="timeline">' + ((data.items || []).slice(0, 6).map((a) => (
          '<div class="tl-item"><span class="tl-dot"></span><div class="tl-body">'
          + '<div class="t"><b>' + esc(a.title) + '</b> · ' + (a.active ? '生效中' : '已停用') + '</div>'
          + '<div class="m">' + fmtTime(a.created_at) + ' · ' + esc(a.created_by || '') + '</div></div></div>'
        )).join('') || '<div class="empty">还没有公告</div>') + '</div></div>'
        + '</div>'
        + '<div class="card section" style="margin-top:16px"><div class="card-head"><div><h3>公告列表</h3></div></div>'
        + table([{ title: 'ID', width: '64px' }, { title: '标题 / 内容' }, { title: '级别', width: '90px' },
          { title: '展示方式', width: '100px' }, { title: '状态', width: '90px' },
          { title: '发布时间' }, { title: '到期时间' }, { title: '操作', width: '150px' }], rows, '还没有发布过公告')
        + '</div>';
    }
  };

  // ---------------------------------------------------------------- 页面：连接管理
  pages.connections = {
    title: '连接管理',
    sub: '按 IP / 设备 / Socket 查看在线与历史连接',
    poll: 10000,
    async load() {
      const page = state.pager.connections || 1;
      const onlyOnline = state.data.onlyOnline ? '&online=1' : '';
      const ip = state.data.connIp ? '&ip=' + encodeURIComponent(state.data.connIp) : '';
      state.data.connections = await api('/connections?page=' + page + '&size=20' + onlyOnline + ip);
      state.data.bans = await api('/bans');
    },
    render() {
      const data = state.data.connections;
      if (!data) return '<div class="card"><div class="empty">加载中…</div></div>';
      const rows = (data.items || []).map((c) => (
        '<tr>'
        + '<td class="mono" style="font-size:11px">' + esc(c.socket_id) + '</td>'
        + '<td class="mono">' + esc(c.ip || '—') + '</td>'
        + '<td>' + esc(c.device || '—') + '</td>'
        + '<td class="mono" style="font-size:11px">' + fmtTime(c.connected_at) + '</td>'
        + '<td>' + (c.live ? '<span class="badge ok">在线</span>' : '<span class="badge mute">已断开</span>') + '</td>'
        + '<td>' + (c.duration != null ? fmtDur(c.duration / 1000) : (c.live ? fmtDur((Date.now() - c.connected_at) / 1000) : '—')) + '</td>'
        + '<td class="mono" style="font-size:11px">' + esc(c.rooms || '') + '</td>'
        + '<td>' + (c.live ? '<button class="btn btn-danger btn-sm" data-act="conn-kick" data-socket="' + esc(c.socket_id) + '">强制下线</button>' : '') + '</td>'
        + '</tr>'
      ));

      const bans = (state.data.bans && state.data.bans.items) || [];
      const banRows = bans.map((b) => (
        '<tr><td class="mono">' + esc(b.ip) + '</td><td>' + esc(b.reason || '—') + '</td>'
        + '<td class="mono" style="font-size:11.5px">' + (b.until ? fmtTime(b.until) : '永久') + '</td>'
        + '<td class="mono" style="font-size:11.5px">' + esc(b.created_by || '') + ' · ' + fmtTime(b.created_at) + '</td>'
        + '<td><button class="btn btn-ghost btn-sm" data-act="ban-remove" data-id="' + b.id + '">解除</button></td></tr>'
      ));

      return '<div class="toolbar">'
        + '<label class="switch"><input type="checkbox" id="only-online"' + (state.data.onlyOnline ? ' checked' : '') + ' /><span class="track"></span>'
        + '<span style="font-size:12.5px;color:var(--text-dim)">只看在线</span></label>'
        + '<div class="search"><input type="text" id="conn-ip" placeholder="按 IP 过滤" value="' + esc(state.data.connIp || '') + '" /></div>'
        + '<span class="badge ok">在线 ' + data.online + ' 个连接</span>'
        + '<span class="grow"></span><button class="btn btn-ghost btn-sm" data-act="refresh">刷新</button>'
        + '</div>'
        + '<div class="card section"><div class="card-head"><div><h3>连接会话</h3><div class="sub">每 10 秒自动刷新 · 断开后仍保留记录便于排查</div></div></div>'
        + table([{ title: 'Socket ID' }, { title: 'IP', width: '130px' }, { title: '设备' }, { title: '进入时间' },
          { title: '状态', width: '90px' }, { title: '在线时长' }, { title: '所在房间' }, { title: '操作', width: '110px' }], rows, '暂无连接记录')
        + pager('connections', data)
        + '</div>'
        + '<div class="card"><div class="card-head"><div><h3>IP 封禁</h3><div class="sub">被封禁的 IP 无法建立 Socket 连接</div></div></div>'
        + '<form data-form="ban" class="toolbar">'
        + '<input type="text" name="ip" placeholder="IP 地址" style="max-width:180px" required />'
        + '<input type="text" name="reason" placeholder="封禁原因（可选）" style="max-width:240px" />'
        + '<input type="number" name="minutes" placeholder="时长（分钟，0=永久）" value="0" style="max-width:200px" />'
        + '<button type="submit" class="btn btn-danger">添加封禁</button>'
        + '</form>'
        + table([{ title: 'IP', width: '160px' }, { title: '原因' }, { title: '到期时间', width: '150px' }, { title: '操作人', width: '200px' }, { title: '操作', width: '90px' }], banRows, '当前没有封禁记录')
        + '</div>';
    },
    mount() {
      const only = $('#only-online');
      if (only) {
        only.addEventListener('change', () => {
          state.data.onlyOnline = only.checked;
          state.pager.connections = 1;
          pages.connections.load().then(renderCurrent).catch((err) => toast(err.message, 'err'));
        });
      }
      const ipInput = $('#conn-ip');
      if (ipInput) {
        ipInput.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          state.data.connIp = ipInput.value.trim();
          state.pager.connections = 1;
          pages.connections.load().then(renderCurrent).catch((err) => toast(err.message, 'err'));
        });
      }
    }
  };

  // ---------------------------------------------------------------- 页面：日志
  const LOG_TABS = [
    { id: 'admin', label: '管理操作' },
    { id: 'rooms', label: '房间事件' },
    { id: 'errors', label: '错误日志' },
    { id: 'logins', label: '登录尝试' },
    { id: 'music', label: '点歌日志' }
  ];

  pages.logs = {
    title: '日志审计',
    sub: '管理员操作、房间事件、错误与登录记录',
    async load() {
      const tab = state.logTab;
      const page = state.pager['log_' + tab] || 1;
      const data = await api('/logs/' + tab + '?page=' + page + '&size=20');
      state.data.logs = { tab: tab, result: data };
    },
    render() {
      const logs = state.data.logs;
      if (!logs) return '<div class="card"><div class="empty">加载中…</div></div>';
      const tab = logs.tab;
      const result = logs.result;
      const isSuper = state.admin && state.admin.role === 'superadmin';

      let cols = [];
      let rows = [];
      if (tab === 'admin') {
        cols = [{ title: '时间', width: '160px' }, { title: '管理员', width: '130px' }, { title: '操作', width: '180px' }, { title: '对象' }, { title: 'IP', width: '130px' }, { title: '详情' }];
        rows = (result.items || []).map((l) => '<tr><td class="mono" style="font-size:11.5px">' + fmtTime(l.created_at) + '</td>'
          + '<td class="strong">' + esc(l.admin_name || '—') + '</td>'
          + '<td><span class="badge accent">' + esc(actionLabel(l.action)) + '</span></td>'
          + '<td class="mono" style="font-size:11.5px">' + esc(l.target || '—') + '</td>'
          + '<td class="mono">' + esc(l.ip || '—') + '</td>'
          + '<td style="max-width:360px;font-size:11.5px;color:var(--muted);word-break:break-all">' + esc(String(l.detail || '').slice(0, 160)) + '</td></tr>');
      } else if (tab === 'rooms') {
        cols = [{ title: '时间', width: '160px' }, { title: '类型', width: '100px' }, { title: '房间号', width: '100px' }, { title: '事件', width: '140px' }, { title: 'Socket', width: '200px' }, { title: 'IP', width: '130px' }, { title: '详情' }];
        rows = (result.items || []).map((l) => '<tr><td class="mono" style="font-size:11.5px">' + fmtTime(l.created_at) + '</td>'
          + '<td><span class="badge info">' + typeLabel(l.kind) + '</span></td>'
          + '<td class="mono strong">' + esc(l.room_code) + '</td>'
          + '<td><span class="badge ' + (String(l.event).indexOf('admin') === 0 ? 'warn' : 'mute') + '">' + esc(eventLabel(l.event)) + '</span></td>'
          + '<td class="mono" style="font-size:11px">' + esc(l.socket_id || '—') + '</td>'
          + '<td class="mono">' + esc(l.ip || '—') + '</td>'
          + '<td style="max-width:260px;font-size:11.5px;color:var(--muted);word-break:break-all">' + esc(String(l.detail || '').slice(0, 120)) + '</td></tr>');
      } else if (tab === 'errors') {
        cols = [{ title: '时间', width: '160px' }, { title: '级别', width: '90px' }, { title: '来源', width: '220px' }, { title: '错误信息' }];
        rows = (result.items || []).map((l) => '<tr><td class="mono" style="font-size:11.5px">' + fmtTime(l.created_at) + '</td>'
          + '<td><span class="badge ' + (l.level === 'fatal' ? 'danger' : l.level === 'warn' ? 'warn' : 'danger') + '">' + esc(l.level) + '</span></td>'
          + '<td class="mono" style="font-size:11.5px">' + esc(l.source || '—') + '</td>'
          + '<td style="font-size:11.5px;word-break:break-all">' + esc(String(l.message || '').slice(0, 300)) + '</td></tr>');
      } else if (tab === 'logins') {
        cols = [{ title: '时间', width: '160px' }, { title: '账号', width: '140px' }, { title: '结果', width: '110px' }, { title: '原因', width: '150px' }, { title: 'IP', width: '140px' }, { title: '设备' }];
        rows = (result.items || []).map((l) => '<tr><td class="mono" style="font-size:11.5px">' + fmtTime(l.created_at) + '</td>'
          + '<td class="mono strong">' + esc(l.username || '—') + '</td>'
          + '<td>' + (l.success ? '<span class="badge ok">成功</span>' : '<span class="badge danger">失败</span>') + '</td>'
          + '<td class="mono" style="font-size:11.5px">' + esc(l.reason || '—') + '</td>'
          + '<td class="mono">' + esc(l.ip || '—') + '</td>'
          + '<td style="font-size:11.5px;color:var(--muted)">' + esc(String(l.ua || '').slice(0, 60)) + '</td></tr>');
      } else {
        cols = [{ title: '时间', width: '160px' }, { title: '房间号', width: '100px' }, { title: '歌名' }, { title: '歌手', width: '160px' }, { title: '点歌 IP', width: '140px' }, { title: '动作', width: '90px' }];
        rows = (result.items || []).map((l) => '<tr><td class="mono" style="font-size:11.5px">' + fmtTime(l.created_at) + '</td>'
          + '<td class="mono strong">' + esc(l.room_code) + '</td>'
          + '<td>' + esc(l.title || '—') + '</td>'
          + '<td>' + esc(l.author || '—') + '</td>'
          + '<td class="mono">' + esc(l.ip || '—') + '</td>'
          + '<td><span class="badge mute">' + esc(l.action) + '</span></td></tr>');
      }

      return '<div class="tabs">' + LOG_TABS.map((t) => (
        '<span class="tab' + (tab === t.id ? ' active' : '') + '" data-act="log-tab" data-tab="' + t.id + '">' + t.label + '</span>'
      )).join('') + '</div>'
        + '<div class="card">'
        + '<div class="card-head"><div><h3>' + (LOG_TABS.find((t) => t.id === tab) || {}).label + '</h3>'
        + '<div class="sub">共 ' + result.total + ' 条记录</div></div>'
        + (isSuper ? '<button class="btn btn-ghost btn-sm" data-act="logs-cleanup">清理过期日志</button>' : '')
        + '</div>'
        + table(cols, rows, '暂无日志')
        + pager('log_' + tab, result)
        + '</div>';
    }
  };

  // ---------------------------------------------------------------- 页面：系统信息
  pages.system = {
    title: '系统信息',
    sub: '运行环境、数据文件与版本',
    async load() {
      state.data.system = await api('/system');
      state.data.settings = (await api('/settings')).settings;
    },
    render() {
      const s = state.data.system;
      if (!s) return '<div class="card"><div class="empty">加载中…</div></div>';
      const st = state.data.settings || {};
      return '<div class="grid cols-2">'
        + '<div class="card"><div class="card-head"><div><h3>运行环境</h3></div></div><dl class="kv">'
        + '<dt>版本</dt><dd>' + esc(s.version) + '</dd>'
        + '<dt>Node</dt><dd>' + esc(s.node) + '</dd>'
        + '<dt>端口</dt><dd>' + esc(s.env.port) + '</dd>'
        + '<dt>环境</dt><dd>' + esc(s.env.nodeEnv) + '</dd>'
        + '<dt>运行时长</dt><dd>' + fmtDur(s.uptime) + '</dd>'
        + '<dt>启动时间</dt><dd>' + fmtDate(s.startedAt) + '</dd>'
        + '<dt>Token 有效期</dt><dd>' + s.env.adminTokenTtlHours + ' 小时</dd>'
        + '</dl></div>'
        + '<div class="card"><div class="card-head"><div><h3>数据存储</h3></div></div><dl class="kv">'
        + '<dt>数据库文件</dt><dd class="mono" style="font-size:11px">' + esc(s.dbPath) + '</dd>'
        + '<dt>数据目录</dt><dd class="mono" style="font-size:11px">' + esc(s.dataDir) + '</dd>'
        + '<dt>文件大小</dt><dd>' + fmtBytes(s.dbSize) + '</dd>'
        + '<dt>管理员数量</dt><dd>' + s.admins + '</dd>'
        + '<dt>房间记录</dt><dd>' + s.rooms + '</dd>'
        + '</dl></div>'
        + '</div>'
        + '<div class="card section" style="margin-top:16px"><div class="card-head"><div><h3>当前生效的关键配置</h3>'
        + '<div class="sub">完整配置请到「系统配置」修改</div></div><a class="btn-link" href="#/settings">去修改</a></div>'
        + '<dl class="kv">'
        + '<dt>站点名称</dt><dd>' + esc(st.siteName || '') + '</dd>'
        + '<dt>房间人数上限</dt><dd>' + esc(st.roomMaxMembers) + ' 人</dd>'
        + '<dt>空闲销毁</dt><dd>' + (st.roomIdleDestroyMinutes ? st.roomIdleDestroyMinutes + ' 分钟' : '已关闭') + '</dd>'
        + '<dt>上传上限</dt><dd>' + esc(st.maxUploadMB) + ' MB</dd>'
        + '<dt>维护模式</dt><dd>' + (st.maintenanceMode ? '<span class="badge warn">开启</span>' : '<span class="badge ok">关闭</span>') + '</dd>'
        + '<dt>IP 白名单</dt><dd>' + ((st.adminIpWhitelist || []).length ? esc(st.adminIpWhitelist.join('、')) : '未启用') + '</dd>'
        + '</dl></div>';
    }
  };

  // ---------------------------------------------------------------- 页面：账号
  pages.account = {
    title: '我的账号',
    sub: '修改密码与管理员账号管理',
    async load() {
      if (state.admin && state.admin.role === 'superadmin') {
        state.data.admins = (await api('/admins')).admins;
      }
    },
    render() {
      const isSuper = state.admin && state.admin.role === 'superadmin';
      const admins = state.data.admins || [];
      const rows = admins.map((a) => (
        '<tr>'
        + '<td class="mono">#' + a.id + '</td>'
        + '<td class="strong">' + esc(a.username) + (state.admin && a.id === state.admin.id ? ' <span class="badge info">当前</span>' : '') + '</td>'
        + '<td><span class="badge ' + (a.role === 'superadmin' ? 'accent' : 'mute') + '">' + (a.role === 'superadmin' ? '超级管理员' : '普通管理员') + '</span></td>'
        + '<td>' + (a.status === 'active' ? '<span class="badge ok">正常</span>' : '<span class="badge danger">已禁用</span>') + '</td>'
        + '<td class="mono" style="font-size:11.5px">' + (a.lastLoginAt ? fmtTime(a.lastLoginAt) : '从未登录') + '</td>'
        + '<td class="mono" style="font-size:11.5px">' + esc(a.lastLoginIp || '—') + '</td>'
        + '<td><div class="row-actions">'
        + '<button class="btn btn-ghost btn-sm" data-act="admin-reset" data-id="' + a.id + '" data-name="' + esc(a.username) + '">重置密码</button>'
        + (a.id === (state.admin && state.admin.id) ? '' : '<button class="btn btn-ghost btn-sm" data-act="admin-toggle" data-id="' + a.id + '" data-status="' + (a.status === 'active' ? 'disabled' : 'active') + '">' + (a.status === 'active' ? '禁用' : '启用') + '</button>'
          + '<button class="btn btn-danger btn-sm" data-act="admin-del" data-id="' + a.id + '" data-name="' + esc(a.username) + '">删除</button>')
        + '</div></td></tr>'
      ));

      return '<div class="grid cols-2-1">'
        + '<div class="card"><div class="card-head"><div><h3>修改密码</h3><div class="sub">修改后其它设备上的登录会立即失效</div></div></div>'
        + '<form data-form="password">'
        + '<label class="field"><span>当前密码</span><input type="password" name="oldPassword" autocomplete="current-password" required /></label>'
        + '<label class="field"><span>新密码</span><input type="password" name="newPassword" autocomplete="new-password" required /><span class="hint">至少 8 位，需包含字母和数字</span></label>'
        + '<label class="field"><span>确认新密码</span><input type="password" name="confirmPassword" autocomplete="new-password" required /></label>'
        + '<div class="form-actions"><button type="submit" class="btn btn-primary">保存新密码</button></div>'
        + '</form></div>'
        + '<div class="card"><div class="card-head"><div><h3>当前账号</h3></div></div><dl class="kv">'
        + '<dt>用户名</dt><dd class="strong">' + esc(state.admin ? state.admin.username : '') + '</dd>'
        + '<dt>角色</dt><dd>' + (isSuper ? '超级管理员' : '普通管理员') + '</dd>'
        + '<dt>上次登录</dt><dd>' + (state.admin && state.admin.lastLoginAt ? fmtTime(state.admin.lastLoginAt) : '—') + '</dd>'
        + '<dt>上次登录 IP</dt><dd class="mono">' + esc((state.admin && state.admin.lastLoginIp) || '—') + '</dd>'
        + '<dt>创建时间</dt><dd>' + (state.admin ? fmtTime(state.admin.createdAt) : '—') + '</dd>'
        + '</dl>'
        + (isSuper ? '<div class="form-note" style="margin:16px 0 0">超级管理员可以管理其它后台账号、修改系统配置与封禁 IP。</div>' : '')
        + '</div></div>'
        + (isSuper
          ? '<div class="card" style="margin-top:16px"><div class="card-head"><div><h3>管理员账号</h3><div class="sub">普通管理员可管理房间与公告，不能改配置</div></div></div>'
          + '<form data-form="admin-create" class="toolbar">'
          + '<input type="text" name="username" placeholder="账号（3-20 位字母数字）" style="max-width:220px" required />'
          + '<input type="password" name="password" placeholder="初始密码（至少 8 位）" style="max-width:220px" required />'
          + '<select name="role" style="max-width:180px"><option value="admin">普通管理员</option><option value="superadmin">超级管理员</option></select>'
          + '<button type="submit" class="btn btn-primary">新增管理员</button>'
          + '</form>'
          + table([{ title: 'ID', width: '64px' }, { title: '账号' }, { title: '角色', width: '130px' }, { title: '状态', width: '90px' },
            { title: '最近登录' }, { title: '登录 IP' }, { title: '操作', width: '240px' }], rows, '暂无管理员')
          + '</div>'
          : '');
    }
  };

  // ---------------------------------------------------------------- 表单提交
  async function handleSubmit(form) {
    const type = form.getAttribute('data-form');
    const fd = new FormData(form);
    try {
      if (type === 'settings') {
        const group = form.getAttribute('data-group');
        const fields = SETTING_FIELDS[group];
        const payload = collectSettings(fields);
        const res = await api('/settings', { method: 'PUT', body: { settings: payload } });
        state.data.settings = res.settings;
        toast(res.changed && res.changed.length ? '已保存：' + res.changed.join('、') : '配置已保存', 'ok');
        renderCurrent();
      } else if (type === 'announcement') {
        const body = {
          title: String(fd.get('title') || '').trim(),
          content: String(fd.get('content') || '').trim(),
          level: fd.get('level'),
          popup: fd.get('popup') === 'on',
          expiresHours: Number(fd.get('expiresHours') || 0)
        };
        await api('/announcements', { method: 'POST', body: body });
        toast('公告已发布并推送给在线用户', 'ok');
        await pages.announcements.load();
        renderCurrent();
      } else if (type === 'password') {
        const oldPassword = String(fd.get('oldPassword') || '');
        const newPassword = String(fd.get('newPassword') || '');
        const confirmPassword = String(fd.get('confirmPassword') || '');
        if (newPassword !== confirmPassword) throw new Error('两次输入的新密码不一致');
        const res = await api('/password', { method: 'POST', body: { oldPassword: oldPassword, newPassword: newPassword } });
        if (res.token) {
          state.token = res.token;
          localStorage.setItem(TOKEN_KEY, res.token);
        }
        if (res.admin) state.admin = res.admin;
        form.reset();
        toast('密码已更新', 'ok');
      } else if (type === 'admin-create') {
        await api('/admins', {
          method: 'POST',
          body: {
            username: String(fd.get('username') || '').trim(),
            password: String(fd.get('password') || ''),
            role: fd.get('role')
          }
        });
        toast('管理员已创建', 'ok');
        form.reset();
        await pages.account.load();
        renderCurrent();
      } else if (type === 'ban') {
        await api('/bans', {
          method: 'POST',
          body: {
            ip: String(fd.get('ip') || '').trim(),
            reason: String(fd.get('reason') || '').trim(),
            minutes: Number(fd.get('minutes') || 0)
          }
        });
        toast('已添加封禁', 'ok');
        await pages.connections.load();
        renderCurrent();
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  // ---------------------------------------------------------------- 交互分发
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form.getAttribute || !form.getAttribute('data-form')) return;
    e.preventDefault();
    handleSubmit(form);
  });

  document.addEventListener('change', (e) => {
    const node = e.target;
    if (node && node.type === 'checkbox' && node.closest('.switch')) {
      const label = node.closest('.switch').querySelector('span:last-child');
      if (label && label.style.fontSize) label.textContent = node.checked ? '已开启' : '已关闭';
    }
  });

  document.addEventListener('click', async (e) => {
    // 导航
    const navItem = e.target.closest('.nav-item');
    if (navItem) return; // 交给 hash 变化

    // 成功/失败提示用的事件委托
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    const kind = btn.getAttribute('data-kind');
    const roomId = btn.getAttribute('data-room');

    try {
      if (act === 'logout') {
        logout();
        return;
      }
      if (act === 'refresh') {
        await pages[state.page].load();
        renderCurrent();
        toast('已刷新', 'ok');
        return;
      }
      if (act === 'copy') {
        const text = btn.getAttribute('data-text') || '';
        try {
          await navigator.clipboard.writeText(text);
          toast('已复制：' + text, 'ok');
        } catch (err) {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
          toast('已复制：' + text, 'ok');
        }
        return;
      }
      if (act === 'toggle') {
        if (state.expanded.has(roomId)) state.expanded.delete(roomId);
        else state.expanded.add(roomId);
        renderCurrent();
        return;
      }
      if (act === 'room-close') {
        const ok = await confirmDialog({
          title: '强制解散房间 ' + roomId,
          message: '房间内的所有成员会被立即断开连接，且无法恢复。<br>确定要继续吗？',
          okText: '解散房间',
          danger: true
        });
        if (!ok) return;
        await api('/rooms/' + kind + '/' + roomId + '/close', { method: 'POST', body: { reason: '被管理员解散' } });
        toast('房间已解散', 'ok');
        await pages[state.page].load();
        renderCurrent();
        return;
      }
      if (act === 'room-kick') {
        const socketId = btn.getAttribute('data-socket');
        const ok = await confirmDialog({
          title: '踢出成员',
          message: '确定把 <span class="mono">' + esc(socketId) + '</span> 移出房间？',
          okText: '踢出',
          danger: true
        });
        if (!ok) return;
        await api('/rooms/' + kind + '/' + roomId + '/kick', { method: 'POST', body: { socketId: socketId } });
        toast('已踢出该成员', 'ok');
        await pages[state.page].load();
        renderCurrent();
        return;
      }
      if (act === 'room-transfer') {
        const socketId = btn.getAttribute('data-socket');
        const ok = await confirmDialog({
          title: '转让房主',
          message: '确定把房主转让给 <span class="mono">' + esc(socketId) + '</span>？',
          okText: '转让'
        });
        if (!ok) return;
        await api('/rooms/' + kind + '/' + roomId + '/transfer', { method: 'POST', body: { socketId: socketId } });
        toast('房主已转让', 'ok');
        await pages[state.page].load();
        renderCurrent();
        return;
      }
      if (act === 'room-reset') {
        const ok = await confirmDialog({
          title: '重置对局',
          message: '将清空当前牌局/棋局并重新开始，房间成员不受影响。',
          okText: '重置',
          danger: true
        });
        if (!ok) return;
        await api('/rooms/' + kind + '/' + roomId + '/reset', { method: 'POST' });
        toast('对局已重置', 'ok');
        await pages[state.page].load();
        renderCurrent();
        return;
      }
      if (act === 'queue-clear') {
        const ok = await confirmDialog({ title: '清空播放队列', message: '全部歌曲会从队列移除，且停止播放。', okText: '清空', danger: true });
        if (!ok) return;
        await api('/rooms/music/' + roomId + '/queue/clear', { method: 'POST' });
        toast('队列已清空', 'ok');
        await pages[state.page].load();
        renderCurrent();
        return;
      }
      if (act === 'queue-next') {
        await api('/rooms/music/' + roomId + '/next', { method: 'POST' });
        toast('已切换到下一首', 'ok');
        await pages[state.page].load();
        renderCurrent();
        return;
      }
      if (act === 'queue-play') {
        const index = Number(btn.getAttribute('data-index'));
        await api('/rooms/music/' + roomId + '/play', { method: 'POST', body: { index: index } });
        toast('已强制切歌', 'ok');
        await pages[state.page].load();
        renderCurrent();
        return;
      }
      if (act === 'queue-remove') {
        const index = Number(btn.getAttribute('data-index'));
        await api('/rooms/music/' + roomId + '/queue/remove', { method: 'POST', body: { index: index } });
        toast('已从队列移除', 'ok');
        await pages[state.page].load();
        renderCurrent();
        return;
      }
      if (act === 'conn-kick') {
        const socketId = btn.getAttribute('data-socket');
        const ok = await confirmDialog({ title: '强制下线', message: '让该连接立即断开？<br><span class="mono">' + esc(socketId) + '</span>', okText: '下线', danger: true });
        if (!ok) return;
        await api('/connections/' + encodeURIComponent(socketId) + '/kick', { method: 'POST' });
        toast('已强制下线', 'ok');
        await pages.connections.load();
        renderCurrent();
        return;
      }
      if (act === 'ban-remove') {
        await api('/bans/' + btn.getAttribute('data-id'), { method: 'DELETE' });
        toast('已解除封禁', 'ok');
        await pages.connections.load();
        renderCurrent();
        return;
      }
      if (act === 'ann-toggle') {
        const active = btn.getAttribute('data-active') === '1';
        await api('/announcements/' + btn.getAttribute('data-id') + '/toggle', { method: 'POST', body: { active: !active } });
        toast(active ? '公告已停用' : '公告已启用', 'ok');
        await pages.announcements.load();
        renderCurrent();
        return;
      }
      if (act === 'ann-del') {
        const ok = await confirmDialog({ title: '删除公告', message: '删除后不可恢复。', okText: '删除', danger: true });
        if (!ok) return;
        await api('/announcements/' + btn.getAttribute('data-id'), { method: 'DELETE' });
        toast('公告已删除', 'ok');
        await pages.announcements.load();
        renderCurrent();
        return;
      }
      if (act === 'log-tab') {
        state.logTab = btn.getAttribute('data-tab');
        state.pager['log_' + state.logTab] = 1;
        await pages.logs.load();
        renderCurrent();
        return;
      }
      if (act === 'hist-kind') {
        state.historyKind = btn.getAttribute('data-kind');
        state.pager.history = 1;
        await pages.history.load();
        renderCurrent();
        return;
      }
      if (act === 'logs-cleanup') {
        const ok = await confirmDialog({
          title: '清理过期日志',
          message: '将按「日志默认保留天数」删除更早的日志，不可恢复。',
          okText: '清理',
          danger: true
        });
        if (!ok) return;
        const res = await api('/logs/cleanup', { method: 'POST', body: {} });
        toast('已清理 ' + Object.keys(res.removed).reduce((s, k) => s + res.removed[k], 0) + ' 条记录', 'ok');
        await pages.logs.load();
        renderCurrent();
        return;
      }
      if (act === 'page') {
        const key = btn.getAttribute('data-key');
        const dir = Number(btn.getAttribute('data-dir'));
        state.pager[key] = Math.max(1, (state.pager[key] || 1) + dir);
        const pageKey = key.indexOf('log_') === 0 ? 'logs' : key;
        await pages[pageKey].load();
        renderCurrent();
        return;
      }
      if (act === 'admin-toggle') {
        const id = Number(btn.getAttribute('data-id'));
        await api('/admins/' + id, { method: 'PATCH', body: { status: btn.getAttribute('data-status') } });
        toast('状态已更新', 'ok');
        await pages.account.load();
        renderCurrent();
        return;
      }
      if (act === 'admin-del') {
        const id = Number(btn.getAttribute('data-id'));
        const ok = await confirmDialog({ title: '删除管理员', message: '删除账号「' + esc(btn.getAttribute('data-name')) + '」？', okText: '删除', danger: true });
        if (!ok) return;
        await api('/admins/' + id, { method: 'DELETE' });
        toast('管理员已删除', 'ok');
        await pages.account.load();
        renderCurrent();
        return;
      }
      if (act === 'admin-reset') {
        const id = Number(btn.getAttribute('data-id'));
        const password = window.prompt('为「' + btn.getAttribute('data-name') + '」设置新密码（至少 8 位，含字母和数字）');
        if (!password) return;
        await api('/admins/' + id + '/reset-password', { method: 'POST', body: { password: password } });
        toast('密码已重置，该账号下次登录需修改', 'ok');
        return;
      }
      if (act === 'music-test') {
        const input = $('#music-test-keyword');
        const keyword = (input && input.value.trim()) || '晴天';
        const box = $('#music-test-result');
        box.innerHTML = '<div class="empty">测试中…</div>';
        const res = await api('/music/test-search', { method: 'POST', body: { keyword: keyword } });
        const items = res.items || [];
        box.innerHTML = '<div class="form-note">来源：' + esc(res.source) + ' · 接口：<span class="mono">' + esc(res.endpoint) + '</span> · 返回 ' + items.length + ' 首</div>'
          + (items.length
            ? '<div class="queue-list">' + items.slice(0, 8).map((s, i) => (
              '<div class="queue-item"><span class="idx">' + (i + 1) + '</span>'
              + '<span class="name">' + esc(s.title) + '</span>'
              + '<span class="who">' + esc(s.author) + '</span></div>'
            )).join('') + '</div>'
            : '<div class="empty">接口返回空结果，检查关键词或接口配置</div>');
        return;
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  // ---------------------------------------------------------------- 启动
  window.addEventListener('hashchange', () => {
    navigate(currentRoute());
  });

  $('#login-form').addEventListener('submit', handleLogin);

  (async function boot() {
    if (!state.token) {
      showLogin('');
      return;
    }
    try {
      await bootShell();
    } catch (err) {
      showLogin(err.message || '登录状态已失效，请重新登录');
    }
  })();
})();
