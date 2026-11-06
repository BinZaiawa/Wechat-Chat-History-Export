'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const state = {
  accounts: [],
  currentAccount: null,
  chats: [],
  currentChat: null,
  messages: [],
  selected: new Set(),
  lastLogLen: 0,
};

/* ================= 基础工具 ================= */

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('服务返回异常: ' + text.slice(0, 200));
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function toast(msg, type) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);

  // 长消息（多行 / 超过 60 字）停留更久，方便阅读
  const isLong = msg.includes('\n') || msg.length > 60;
  const dur = isLong ? 12000 : (type === 'err' ? 6000 : 2800);

  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, dur);

  // 点击可立即关闭
  el.onclick = () => {
    clearTimeout(toastTimer);
    el.className = 'toast';
  };
}

function setBusy(busy, text) {
  const dot = $('#busyDot');
  dot.className = 'dot ' + (busy ? 'busy' : 'ok');
  $('#busyText').textContent = busy ? (text || '处理中') : '就绪';
  $$('.mini-btn, .primary-btn').forEach((b) => {
    if (b.id !== 'btnOpenDir') b.disabled = busy;
  });
}

/* ================= 主题 ================= */

function initTheme() {
  const saved = localStorage.getItem('wx-theme') || 'light';
  applyTheme(saved);
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const icon = document.querySelector('.theme-icon');
  if (icon) icon.textContent = t === 'dark' ? '☀' : '🌙';
  localStorage.setItem('wx-theme', t);
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

/* ================= 抽屉 ================= */

function openDrawer(id) {
  $('#' + id).classList.add('open');
  $('#mask').classList.add('show');
}

function closeDrawers() {
  $$('.drawer').forEach((d) => d.classList.remove('open'));
  $('#mask').classList.remove('show');
}

/* ================= 日志 ================= */

async function pollStatus() {
  try {
    const s = await api('/api/status');
    const box = $('#logBox');
    if (s.log && s.log.length !== state.lastLogLen) {
      state.lastLogLen = s.log.length;
      box.innerHTML = s.log.map((l) => {
        let cls = '';
        if (/失败|错误|异常|ERR/.test(l)) cls = 'l-err';
        else if (/成功|完成|已保存/.test(l)) cls = 'l-ok';
        return `<span class="${cls}">${esc(l)}</span>`;
      }).join('\n');
      box.scrollTop = box.scrollHeight;
    }
    if (s.busy !== undefined && !s.busy) {
      setBusy(false);
    }
    if (s.keyCount !== undefined) {
      const ki = $('#keyInfo');
      if (ki) {
        ki.textContent = s.keyCount > 0
          ? `已配置 ${s.keyCount} 个数据库的密钥`
          : '未配置密钥 — 请先运行根目录的「提取密钥.bat」';
      }
    }
  } catch (_) {}
}

/* ================= 账号 ================= */

async function loadAccounts() {
  const sel = $('#selAccount');
  try {
    const r = await api('/api/accounts');
    state.accounts = r.accounts || [];
    if (!state.accounts.length) {
      sel.innerHTML = '<option value="">未发现微信数据</option>';
      $('#chatList').innerHTML = '<div class="empty">未找到微信数据目录</div>';
      return;
    }
    sel.innerHTML = state.accounts
      .map((a, i) => `<option value="${i}">${esc(a.name)}</option>`)
      .join('');
    sel.value = '0';
    selectAccount(0);
  } catch (e) {
    sel.innerHTML = '<option value="">加载失败</option>';
    toast(e.message, 'err');
  }
}

function selectAccount(idx) {
  const a = state.accounts[+idx];
  if (!a) return;
  state.currentAccount = a;

  // 缺密钥提示（只提示有内容的库，0 字节空库忽略）
  const real = a.missingReal || [];
  const info = $('#accInfo');
  if (info) {
    if (real.length) {
      info.className = 'hint err';
      info.innerHTML =
        `⚠ ${real.length} 个库缺密钥：` +
        real.slice(0, 3).map((r) => `<b>${esc(r)}</b>`).join('、') +
        (real.length > 3 ? ` 等 ${real.length} 个` : '') +
        `<br>请以管理员身份运行「提取密钥.bat」补齐`;
    } else if (a.dbTotal) {
      info.className = 'hint ok';
      info.textContent = `✅ 密钥齐全（${a.dbTotal} 个库）`;
    } else {
      info.className = 'hint';
      info.textContent = '';
    }
  }

  loadChats();
}

/* ================= 会话列表 ================= */

async function loadChats() {
  const a = state.currentAccount;
  const list = $('#chatList');
  if (!a) return;
  list.innerHTML = '<div class="empty">读取中…</div>';
  try {
    const r = await api('/api/chats?account=' + encodeURIComponent(a.name));
    if (!r.ok) {
      list.innerHTML = `<div class="empty">${esc(r.err || '读取失败')}<br><br>请先点「解密数据库」</div>`;
      return;
    }
    state.chats = r.chats || [];
    renderChats();
  } catch (e) {
    list.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}

function avatarOf(c) {
  if (c.isGroup) return 'group';
  if (c.isOfficial) return 'official';
  return '';
}

function initialOf(name) {
  if (!name) return '?';
  return name.trim().slice(0, 1).toUpperCase();
}

/** 头像 URL（无头像时服务端返回透明 PNG） */
function avatarUrl(username) {
  if (!username || !state.currentAccount) return '';
  return `/api/avatar?account=${encodeURIComponent(state.currentAccount.name)}&username=${encodeURIComponent(username)}`;
}

/** 生成头像元素：图片 + 文字兜底 */
function avatarHtml(username, name, cls) {
  const url = avatarUrl(username);
  const ch = esc(initialOf(name));
  if (!url) {
    return `<div class="avatar ${cls}">${ch}</div>`;
  }
  return `<div class="avatar ${cls}">
    <span class="av-fallback">${ch}</span>
    <img src="${url}" alt="" loading="lazy"
      onerror="this.style.display='none'"
      onload="this.previousElementSibling.style.display='none';this.style.display='block'">
  </div>`;
}

function renderChats() {
  const kw = ($('#inpSearch').value || '').trim().toLowerCase();
  const list = $('#chatList');
  let items = state.chats;
  if (kw) {
    items = items.filter(
      (c) =>
        (c.name || '').toLowerCase().includes(kw) ||
        (c.username || '').toLowerCase().includes(kw) ||
        (c.digest || '').toLowerCase().includes(kw)
    );
  }
  if (!items.length) {
    list.innerHTML = `<div class="empty">${state.chats.length ? '无匹配会话' : '暂无会话'}</div>`;
    return;
  }

  list.innerHTML = items
    .map((c) => {
      const idx = state.chats.indexOf(c);
      const active = state.currentChat && state.currentChat.table === c.table ? ' active' : '';
      const timeTxt = (c.timeText || '').slice(5, 16);
      const unread = c.unread > 0 ? `<span class="ci-unread">${c.unread > 99 ? '99+' : c.unread}</span>` : '';
      return `<div class="chat-item${active}" data-idx="${idx}">
        ${avatarHtml(c.username, c.name, avatarOf(c))}
        <div class="ci-main">
          <div class="ci-row1">
            <span class="ci-name">${esc(c.name)}</span>
            <span class="ci-time">${esc(timeTxt)}</span>
          </div>
          <div class="ci-row2">${esc((c.digest || '').slice(0, 40))}${unread}</div>
        </div>
      </div>`;
    })
    .join('');

  list.querySelectorAll('.chat-item').forEach((el) => {
    el.addEventListener('click', () => {
      const idx = +el.dataset.idx;
      selectChat(state.chats[idx]);
    });
  });
}

/* ================= 聊天气泡 ================= */

async function selectChat(chat) {
  state.currentChat = chat;
  state.selected.clear();
  updateSelCount();
  renderChats();

  $('#chatTitle').textContent = chat.name;
  $('#chatMeta').textContent = '加载中…';
  const box = $('#bubbles');
  box.innerHTML = '<div class="empty big">加载中…</div>';

  if (!chat.hasMessages) {
    box.innerHTML = '<div class="empty big">该会话在消息库中没有记录</div>';
    $('#chatMeta').textContent = '';
    return;
  }

  try {
    const r = await api('/api/messages', {
      method: 'POST',
      body: JSON.stringify({ account: state.currentAccount.name, chat, limit: 500 }),
    });
    if (!r.ok) {
      box.innerHTML = `<div class="empty big">${esc(r.err || '读取失败')}</div>`;
      return;
    }
    state.messages = r.messages;
    $('#chatMeta').textContent = r.total > r.count
      ? `显示最近 ${r.count} / 共 ${r.total} 条`
      : `共 ${r.total} 条`;
    renderBubbles();
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    box.innerHTML = `<div class="empty big">${esc(e.message)}</div>`;
  }
}

function renderBubbles() {
  const box = $('#bubbles');
  const msgs = state.messages;
  if (!msgs.length) {
    box.innerHTML = '<div class="empty big">没有消息</div>';
    return;
  }

  const parts = [];
  let lastDate = '';
  let lastSender = '';
  let lastTime = 0;

  for (const m of msgs) {
    // 日期分隔
    if (m.date !== lastDate) {
      lastDate = m.date;
      lastSender = '';
      parts.push(`<div class="date-sep"><span>${esc(m.date)}</span></div>`);
    }

    const sel = state.selected.has(m.id) ? ' selected' : '';
    const self = m.isSelf ? ' self' : '';
    const ts = m.timeShort || '';

    // 是否显示发送者名（对方且与上一条不同）
    let showSender = '';
    if (!m.isSelf && m.senderName && m.senderName !== lastSender) {
      showSender = `<div class="msg-sender">${esc(m.senderName)}</div>`;
    }

    // 系统消息
    if (m.type === 10000 || m.type === 10002) {
      parts.push(`<div class="msg-row sys${sel}" data-id="${esc(m.id)}">
        <input type="checkbox" class="msg-check" data-id="${esc(m.id)}"${state.selected.has(m.id) ? ' checked' : ''}>
        <div class="msg-body" style="max-width:100%"><div class="bubble sys">${esc(m.summary || m.content)}</div></div>
      </div>`);
      lastSender = m.senderName;
      continue;
    }

    // 正文
    let inner = '';
    const mediaTypes = [3, 34, 43, 47, 42, 48, 50];
    if (mediaTypes.includes(m.type)) {
      inner = renderMedia(m);
    } else if (m.type === 49) {
      inner = renderRich(m);
    } else {
      inner = renderText(m.content || m.summary || '');
    }

    const mediaCls = mediaTypes.includes(m.type) || m.type === 49 ? ' media' : '';

    parts.push(`<div class="msg-row${self}${sel}" data-id="${esc(m.id)}">
      <input type="checkbox" class="msg-check" data-id="${esc(m.id)}"${state.selected.has(m.id) ? ' checked' : ''}>
      ${avatarHtml(m.sender, m.isSelf ? '我' : m.senderName, 'msg-avatar' + (m.isSelf ? ' self' : ''))}
      <div class="msg-body">
        ${showSender}
        <div class="bubble${mediaCls}">${inner}</div>
        <div class="msg-time">${esc(ts)}</div>
      </div>
    </div>`);

    lastSender = m.senderName;
    lastTime = 0;
  }

  box.innerHTML = parts.join('');
  bindBubbleEvents();
}

function renderMedia(m) {
  const icon = {
    3: '🖼', 34: '🎤', 43: '🎬', 47: '😀', 42: '👤', 48: '📍', 50: '📞',
  }[m.type] || '📎';
  let label = m.typeName || '媒体';
  if (m.type === 34 && m.voicelen) label += ` ${m.voicelen}"`;
  if (m.type === 43 && m.xml && m.xml.playlength) label += ` ${m.xml.playlength}s`;
  if (m.type === 42 && m.xml && m.xml.nickname) label += ` ${m.xml.nickname}`;
  if (m.type === 48 && m.xml && m.xml.label) label += ` ${m.xml.label}`;
  return `<span class="media-icon">${icon}</span>${esc(label)}`;
}

function renderRich(m) {
  const x = m.xml || {};
  if (x.special === 'transfer') return `💰 转账 ${esc(x.title || '')}`;
  if (x.special === 'redpacket') return `🧧 红包 ${esc(x.title || '')}`;
  if (x.type === '6' || x.filename) return `📄 ${esc(x.title || x.filename || '文件')}`;
  if (x.type === '57') return `💬 引用 ${esc(x.title || '')}`;
  if (x.type === '5') {
    const t = esc(x.title || x.url || '链接');
    const u = x.url ? `<br><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a>` : '';
    return `🔗 ${t}${u}`;
  }
  if (x.type === '19') return `📦 合并转发 ${esc(x.title || '')}`;
  if (x.type === '36' || x.type === '33') return `📱 小程序 ${esc(x.title || '')}`;
  if (x.type === '3') return `🎵 ${esc(x.title || '')}`;
  return `📎 ${esc(x.title || x.des || '富媒体')}`;
}

function renderText(txt) {
  let s = esc(txt);
  // 自动链接
  s = s.replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );
  return s;
}

function bindBubbleEvents() {
  $$('.msg-check').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) state.selected.add(id);
      else state.selected.delete(id);
      const row = e.target.closest('.msg-row');
      if (row) row.classList.toggle('selected', e.target.checked);
      updateSelCount();
    });
  });

  // 点击行也能切换（但不干扰复选框本身）
  $$('.msg-row').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'A') return;
      const cb = row.querySelector('.msg-check');
      if (!cb) return;
      cb.checked = !cb.checked;
      cb.dispatchEvent(new Event('change'));
    });
  });
}

function updateSelCount() {
  const n = state.selected.size;
  $('#selCount').textContent = `已选 ${n}`;
}

/* ================= 选择操作 ================= */

function selAll() {
  state.messages.forEach((m) => state.selected.add(m.id));
  syncChecks();
}

function selNone() {
  state.selected.clear();
  syncChecks();
}

function selInvert() {
  state.messages.forEach((m) => {
    if (state.selected.has(m.id)) state.selected.delete(m.id);
    else state.selected.add(m.id);
  });
  syncChecks();
}

function syncChecks() {
  $$('.msg-check').forEach((cb) => {
    const id = cb.dataset.id;
    const on = state.selected.has(id);
    cb.checked = on;
    const row = cb.closest('.msg-row');
    if (row) row.classList.toggle('selected', on);
  });
  updateSelCount();
}

/* ================= 动作 ================= */

async function doDecrypt() {
  const a = state.currentAccount;
  if (!a) return toast('请先选择账号', 'err');
  setBusy(true, '解密中');
  toast('正在解密数据库…');
  try {
    const r = await api('/api/decrypt', {
      method: 'POST',
      body: JSON.stringify({ accountPath: a.path }),
    });
    if (r.ok) {
      const miss = r.missingKeys || [];
      const real = r.realFailures || [];

      let msg = `解密完成：成功 ${r.decrypted} 个`;
      if (r.failed) msg += `，失败 ${r.failed} 个`;

      // 缺密钥的库，明确列出来并给出解决办法
      if (miss.length) {
        msg += `\n\n⚠ ${miss.length} 个库缺密钥：`;
        miss.slice(0, 5).forEach((rel) => {
          msg += `\n  · ${rel}`;
        });
        if (miss.length > 5) msg += `\n  · ... 还有 ${miss.length - 5} 个`;
        msg += '\n\n解决办法：以管理员身份运行「提取密钥.bat」';
      }

      // 真失败（密钥对但解不开）
      if (real.length) {
        msg += `\n\n❌ ${real.length} 个库解密失败：`;
        real.slice(0, 3).forEach((f) => {
          msg += `\n  · ${f.rel}：${f.reason}`;
        });
      }

      toast(msg, real.length ? 'err' : (miss.length ? '' : 'ok'));
      if (r.decrypted > 0) loadChats();
    } else {
      toast(r.err || '解密失败', 'err');
    }
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    setBusy(false);
    pollStatus();
  }
}

async function doExport() {
  const a = state.currentAccount;
  const c = state.currentChat;
  if (!a || !c) return toast('请先选择会话', 'err');

  const scope = $('#selScope').value;
  const fmt = $('#selFormat').value;
  const outDir = $('#inpOutDir').value.trim();

  const payload = { account: a.name, chat: c, format: fmt, outDir: outDir || undefined };

  if (scope === 'selected') {
    if (state.selected.size === 0) {
      return toast('没有勾选任何消息\n点消息行或复选框选择', 'err');
    }
    payload.selectedIds = [...state.selected];
  } else if (scope === 'date') {
    const s = $('#inpSince').value;
    const u = $('#inpUntil').value;
    if (s) payload.since = Math.floor(new Date(s + 'T00:00:00').getTime() / 1000);
    if (u) payload.until = Math.floor(new Date(u + 'T23:59:59').getTime() / 1000);
  }

  setBusy(true, '导出中');
  toast('正在导出…');
  try {
    const r = await api('/api/export', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (r.ok) {
      const name = r.file.split(/[\\/]/).pop();
      toast(`导出成功：${r.count} 条\n${name}`, 'ok');
    } else {
      toast(r.err || '导出失败', 'err');
    }
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    setBusy(false);
    pollStatus();
  }
}

async function doDerive() {
  const a = state.currentAccount;
  if (!a) return toast('请先选择账号', 'err');
  const hex = ($('#inpPass').value || '').trim().replace(/\s/g, '');
  const box = $('#deriveResult');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    box.className = 'hint err';
    box.textContent = 'passphrase 必须是 64 个 hex 字符';
    return;
  }
  setBusy(true, '派生中');
  box.className = 'hint';
  box.textContent = '正在派生…';
  try {
    const r = await api('/api/derive-keys', {
      method: 'POST',
      body: JSON.stringify({ accountPath: a.path, passphrase: hex }),
    });
    if (r.ok) {
      box.className = 'hint ok';
      box.textContent = `成功：${r.matched}/${r.total} 个库`;
    } else {
      box.className = 'hint err';
      box.textContent = r.err || `无库通过校验（${r.matched || 0}/${r.total || 0}）`;
    }
  } catch (e) {
    box.className = 'hint err';
    box.textContent = e.message;
  } finally {
    setBusy(false);
  }
}

/* ================= 绑定 ================= */

window.addEventListener('DOMContentLoaded', () => {
  initTheme();

  $('#btnTheme').addEventListener('click', toggleTheme);
  $('#btnSettings').addEventListener('click', () => openDrawer('drawerSettings'));
  $('#btnLog').addEventListener('click', () => openDrawer('drawerLog'));
  $('#mask').addEventListener('click', closeDrawers);
  $$('[data-close]').forEach((b) =>
    b.addEventListener('click', () => closeDrawers())
  );

  $('#selAccount').addEventListener('change', (e) => selectAccount(e.target.value));
  $('#btnReload').addEventListener('click', () => {
    loadAccounts();
    pollStatus();
  });
  $('#btnDecrypt').addEventListener('click', doDecrypt);
  $('#btnDerive').addEventListener('click', doDerive);

  $('#inpSearch').addEventListener('input', renderChats);

  $('#btnSelAll').addEventListener('click', selAll);
  $('#btnSelNone').addEventListener('click', selNone);
  $('#btnSelInvert').addEventListener('click', selInvert);

  $('#selScope').addEventListener('change', (e) => {
    $('#dateRange').style.display = e.target.value === 'date' ? 'inline-flex' : 'none';
  });

  $('#btnExport').addEventListener('click', doExport);
  $('#btnOpenDir').addEventListener('click', async () => {
    const dir = $('#inpOutDir').value.trim();
    await api('/api/open-dir', { method: 'POST', body: JSON.stringify({ dir: dir || undefined }) });
  });

  $('#btnClearLog').addEventListener('click', () => {
    $('#logBox').innerHTML = '';
    state.lastLogLen = -1;
  });

  // 快捷键
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawers();
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      selAll();
    }
  });

  loadAccounts();
  pollStatus();
  setInterval(pollStatus, 1500);
});
