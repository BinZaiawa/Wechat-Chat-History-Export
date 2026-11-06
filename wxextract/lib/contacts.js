'use strict';
/**
 * 会话 / 联系人 / 聊天对象解析（微信 4.x）
 *
 * 实测表结构（4.1.15.56）：
 *   session.db / SessionTable:
 *     username, type, unread_count, summary, draft, status,
 *     last_timestamp, sort_timestamp, last_msg_locald_id,
 *     last_msg_type, last_msg_sender, last_sender_display_name
 *   contact.db / contact: username, remark, nick_name, alias, ...
 *   message/message_N.db: Msg_<md5(username)>, Name2Id
 */
const fs = require('fs');
const path = require('path');
const { safeOpen, tableExists, listTables, tableNameFor } = require('./msgdb');

/** 从 contact.db 读取联系人映射 */
function loadContacts(contactDbPath) {
  const map = new Map();
  if (!contactDbPath || !fs.existsSync(contactDbPath)) return map;
  let db;
  try {
    db = safeOpen(contactDbPath);
    if (!tableExists(db, 'contact')) return map;
    const cols = new Set(db.prepare('PRAGMA table_info(contact)').all().map((c) => c.name));
    const sel = ['username'];
    for (const c of ['remark', 'nick_name', 'alias', 'description', 'flag', 'verify_flag', 'big_head_url', 'small_head_url']) {
      sel.push(cols.has(c) ? c : `NULL AS ${c}`);
    }
    const rows = db.prepare(`SELECT ${sel.join(',')} FROM contact`).all();
    for (const r of rows) {
      if (!r.username) continue;
      map.set(r.username, {
        username: r.username,
        remark: r.remark || '',
        nickName: r.nick_name || '',
        alias: r.alias || '',
        description: r.description || '',
        isFriend: (r.flag & 3) !== 0 || !!r.remark,
        isGroup: r.username.endsWith('@chatroom'),
        isOfficial: r.username.startsWith('gh_'),
        headUrl: r.big_head_url || r.small_head_url || '',
      });
    }
  } catch (_) {
  } finally {
    try { db && db.close(); } catch (_) {}
  }
  return map;
}

/** 显示名优先级：remark > nick_name > username */
function displayName(contact, fallback) {
  if (contact) {
    if (contact.remark) return contact.remark;
    if (contact.nickName) return contact.nickName;
  }
  return fallback || (contact && contact.username) || '';
}

/**
 * 从 session.db 读取会话列表（4.x SessionTable）
 */
function loadSessions(sessionDbPath) {
  const list = [];
  if (!sessionDbPath || !fs.existsSync(sessionDbPath)) return list;
  let db;
  try {
    db = safeOpen(sessionDbPath);
    const tables = listTables(db);

    // 4.x: SessionTable
    let tname = tables.find((t) => t === 'SessionTable');
    // 兼容 3.x
    if (!tname) tname = tables.find((t) => /^session$/i.test(t) || /^SessionTable$/i.test(t));
    if (!tname) {
      // 兜底：任何含 username 列的表
      for (const t of tables) {
        try {
          const c = db.prepare(`PRAGMA table_info([${t}])`).all().map((x) => x.name);
          if (c.includes('username') && c.includes('summary')) { tname = t; break; }
        } catch (_) {}
      }
    }
    if (!tname) return list;

    const cols = new Set(db.prepare(`PRAGMA table_info([${tname}])`).all().map((c) => c.name));
    const get = (n) => (cols.has(n) ? `[${n}]` : `NULL AS ${n}`);

    const sel = [
      get('username'),
      get('summary'),
      get('last_msg_type'),
      get('last_msg_locald_id'),
      get('last_timestamp'),
      get('sort_timestamp'),
      get('unread_count'),
      get('is_hidden'),
      get('last_msg_sender'),
      get('last_sender_display_name'),
      get('draft'),
    ];
    let rows = [];
    try {
      rows = db.prepare(`SELECT ${sel.join(',')} FROM [${tname}]`).all();
    } catch (_) {
      return list;
    }
    for (const r of rows) {
      const username = r.username || '';
      if (!username) continue;
      const ts = r.last_timestamp || r.sort_timestamp || 0;
      list.push({
        username,
        nickName: r.last_sender_display_name || '',
        digest: r.summary || '',
        msgType: r.last_msg_type,
        lastMsgId: r.last_msg_locald_id,
        time: ts,
        unread: r.unread_count || 0,
        hidden: !!r.is_hidden,
        draft: r.draft || '',
        lastSender: r.last_msg_sender || '',
      });
    }
  } catch (_) {
  } finally {
    try { db && db.close(); } catch (_) {}
  }
  list.sort((a, b) => b.time - a.time);
  return list;
}

/**
 * 扫描所有已解密消息库，建立 username -> [{dbFile, table}] 索引
 */
function buildMsgIndex(decryptedMsgDir, usernames) {
  const index = new Map();
  for (const u of usernames) index.set(u, []);
  if (!fs.existsSync(decryptedMsgDir)) return index;

  const files = fs.readdirSync(decryptedMsgDir).filter((f) => /^message_\d+\.db$/.test(f));
  const tblOf = new Map();
  for (const u of usernames) tblOf.set(tableNameFor(u), u);

  for (const f of files) {
    const dbPath = path.join(decryptedMsgDir, f);
    let db;
    try {
      db = safeOpen(dbPath);
      const tables = new Set(listTables(db));
      for (const [tbl, u] of tblOf) {
        if (tables.has(tbl)) {
          const arr = index.get(u);
          if (arr) arr.push({ dbFile: f, dbPath, table: tbl });
        }
      }
    } catch (_) {
    } finally {
      try { db && db.close(); } catch (_) {}
    }
  }
  return index;
}

/** 列出所有存在于消息库中的 Msg_ 表 */
function listTalkersFromMsgDbs(decryptedMsgDir) {
  const map = new Map();
  if (!fs.existsSync(decryptedMsgDir)) return [];
  const files = fs.readdirSync(decryptedMsgDir).filter((f) => /^message_\d+\.db$/.test(f));
  for (const f of files) {
    const dbPath = path.join(decryptedMsgDir, f);
    let db;
    try {
      db = safeOpen(dbPath);
      const tables = listTables(db).filter((t) => t.startsWith('Msg_'));
      for (const t of tables) {
        if (!map.has(t)) map.set(t, { table: t, dbs: [] });
        map.get(t).dbs.push(f);
      }
    } catch (_) {
    } finally {
      try { db && db.close(); } catch (_) {}
    }
  }
  return [...map.values()];
}

/** 从消息库反推 username：Name2Id 里出现的所有 user_name */
function listUsernamesFromMsgDb(decryptedMsgDir, dbFile) {
  const out = new Set();
  const p = path.join(decryptedMsgDir, dbFile);
  if (!fs.existsSync(p)) return out;
  let db;
  try {
    db = safeOpen(p);
    if (tableExists(db, 'Name2Id')) {
      for (const r of db.prepare('SELECT user_name FROM Name2Id').all()) {
        if (r.user_name) out.add(r.user_name);
      }
    }
  } catch (_) {
  } finally {
    try { db && db.close(); } catch (_) {}
  }
  return out;
}

module.exports = {
  loadContacts, displayName, loadSessions, buildMsgIndex,
  listTalkersFromMsgDbs, listUsernamesFromMsgDb,
};
