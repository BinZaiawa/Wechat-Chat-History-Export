'use strict';
/**
 * 核心业务编排：发现 → 密钥 → 解密 → 读取 → 导出
 */
const fs = require('fs');
const path = require('path');
const config = require('./config');
const discover = require('./discover');
const sqlcipher = require('./sqlcipher');
const keysMod = require('./keys');
const msgdb = require('./msgdb');
const contactsMod = require('./contacts');
const exporter = require('./exporter');

const state = {
  busy: false,
  task: '',
  progress: 0,
  log: [],
};

function log(msg) {
  const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`;
  state.log.push(line);
  if (state.log.length > 500) state.log.shift();
  console.log(line);
}

function setProgress(p, task) {
  state.progress = p;
  if (task) state.task = task;
}

/** 列出所有账号（含解密状态） */
function getAccounts(cfg) {
  const roots = discover.detect();
  const accounts = [];
  for (const r of roots) {
    for (const a of r.accounts) {
      accounts.push({ ...a, root: r.root });
    }
  }
  // 配置里手动指定的根目录
  if (cfg.wechatRoot && fs.existsSync(cfg.wechatRoot)) {
    const extra = discover.listAccounts(cfg.wechatRoot);
    for (const a of extra) {
      if (!accounts.find((x) => x.path === a.path)) accounts.push({ ...a, root: cfg.wechatRoot });
    }
  }
  return accounts;
}

/** 账号目录下的 db_storage */
function dbStorageOf(accountPath) {
  return path.join(accountPath, 'db_storage');
}

/** 解密工作目录（按账号隔离） */
function workDirOf(cfg, account) {
  return path.join(cfg.workDir, account);
}

/** 获取某账号已解密的库目录 */
function decryptedDir(cfg, account, sub) {
  return path.join(workDirOf(cfg, account), sub || '');
}

/**
 * 解密整个账号的所有库
 * @param {(msg:string)=>void} onLog
 */
function decryptAccount(cfg, accountPath, onLog) {
  const accountName = path.basename(accountPath);
  const dbStorage = dbStorageOf(accountPath);
  if (!fs.existsSync(dbStorage)) throw new Error('找不到 db_storage 目录: ' + dbStorage);

  const outRoot = workDirOf(cfg, accountName);
  const dbs = keysMod.collectDbs(dbStorage);
  log(`发现 ${dbs.length} 个数据库，${new Set(dbs.map((d) => d.saltHex)).size} 个不同 salt`);

  const keyMap = cfg.keys || {};
  const decrypted = [];
  const failed = [];

  for (const db of dbs) {
    const k = keyMap[db.rel];
    if (!k || !k.encKey) {
      failed.push({ rel: db.rel, reason: '无密钥' });
      continue;
    }
    const encKey = Buffer.from(k.encKey, 'hex');
    if (encKey.length !== 32) {
      failed.push({ rel: db.rel, reason: '密钥长度错误' });
      continue;
    }
    const outPath = path.join(outRoot, db.rel);
    try {
      sqlcipher.decryptDatabase(db.path, outPath, encKey, { verify: true });
      // 合并 WAL
      const wal = db.path + '-wal';
      let walInfo = null;
      if (fs.existsSync(wal)) {
        walInfo = sqlcipher.mergeWal(wal, outPath, encKey);
      }
      decrypted.push({ rel: db.rel, out: outPath, wal: walInfo });
      log(`解密成功: ${db.rel}${walInfo ? ` (WAL +${walInfo.applied} 帧)` : ''}`);
    } catch (e) {
      failed.push({ rel: db.rel, reason: e.message });
      log(`解密失败: ${db.rel} — ${e.message}`);
    }
  }
  return { decrypted, failed, outRoot };
}

/**
 * 扫描密钥（内存）
 */
function scanKeys(cfg, accountPath) {
  const dbStorage = dbStorageOf(accountPath);
  const dbs = keysMod.collectDbs(dbStorage);
  log(`准备扫描密钥：${dbs.length} 个库`);

  const pids = keysMod.findWeChatPids();
  if (!pids.length) {
    return {
      ok: false,
      err: '未发现微信主进程（Weixin.exe）。请先启动并登录微信，再执行扫描。',
      pids: [],
      dbs: dbs.length,
    };
  }
  log(`发现微信进程: ${pids.map((p) => p.pid + '(' + p.memMB + 'MB)').join(', ')}`);

  const allCandidates = [];
  for (const p of pids) {
    log(`扫描进程 ${p.pid} ...`);
    const r = keysMod.scanProcessMemory(p.pid);
    if (!r.ok && r.err) log(`进程 ${p.pid} 扫描异常: ${r.err}`);
    log(`进程 ${p.pid}: ${r.regions} 区域 / ${r.totalMB}MB，命中 ${r.candidates.length} 个 hex 模式`);
    allCandidates.push(...r.candidates);
  }

  if (!allCandidates.length) {
    return {
      ok: false,
      err: '内存中未找到任何 x\'<hex>\' 形式的密钥缓存。该微信版本（4.1.10+）可能已改为零驻留，需用 Frida 方案。',
      pids,
      dbs: dbs.length,
      candidates: 0,
    };
  }

  const m = keysMod.matchKeys(allCandidates, dbs);
  log(`密钥匹配: ${m.matchedSalts}/${m.totalSalts} 个 salt 命中`);

  if (m.matchedSalts > 0) {
    cfg.keys = cfg.keys || {};
    for (const [rel, v] of Object.entries(m.result)) {
      cfg.keys[rel] = { encKey: v.encKey, salt: v.salt, by: v.by, addr: v.addr };
    }
    config.save(cfg);
    log(`已保存 ${Object.keys(m.result).length} 个库的密钥到配置`);
  }

  return {
    ok: m.matchedSalts > 0,
    pids,
    dbs: dbs.length,
    candidates: allCandidates.length,
    matched: m.matchedSalts,
    totalSalts: m.totalSalts,
    keys: m.result,
    err: m.matchedSalts === 0 ? '扫描到候选但 HMAC 校验均未通过' : undefined,
  };
}

/**
 * 用 passphrase 派生密钥
 */
function deriveKeysFromPassphrase(cfg, accountPath, passphraseHex) {
  const dbStorage = dbStorageOf(accountPath);
  const dbs = keysMod.collectDbs(dbStorage);
  log(`用 passphrase 派生 ${dbs.length} 个库的密钥...`);
  const result = keysMod.keysFromPassphrase(passphraseHex, dbs);
  const n = Object.keys(result).length;
  if (n > 0) {
    cfg.keys = cfg.keys || {};
    for (const [rel, v] of Object.entries(result)) {
      cfg.keys[rel] = { encKey: v.encKey, salt: v.salt, by: 'pbkdf2' };
    }
    config.save(cfg);
  }
  log(`派生完成：${n}/${dbs.length} 个库校验通过`);
  return { ok: n > 0, matched: n, total: dbs.length, keys: result };
}

/**
 * 列出某账号的会话（需要已解密）
 */
function listChats(cfg, accountName) {
  const dir = decryptedDir(cfg, accountName);
  const msgDir = path.join(dir, 'message');
  if (!fs.existsSync(msgDir)) {
    return { ok: false, err: '该账号尚未解密，请先解密', chats: [] };
  }
  const contactDb = path.join(dir, 'contact', 'contact.db');
  const sessionDb = path.join(dir, 'session', 'session.db');
  const contacts = contactsMod.loadContacts(contactDb);
  const sessions = contactsMod.loadSessions(sessionDb);

  // 用消息库反查真实存在的会话
  const talkers = contactsMod.listTalkersFromMsgDbs(msgDir);
  const chats = [];
  const seenTable = new Set();

  // 1) session.db 里的会话
  for (const s of sessions) {
    const c = contacts.get(s.username);
    const tbl = msgdb.tableNameFor(s.username);
    const hit = talkers.find((t) => t.table === tbl);
    if (hit) seenTable.add(tbl);

    // 名称优先级：联系人备注 > 联系人昵称 > session 里的最后发言人 > username
    let name = '';
    if (c) name = contactsMod.displayName(c, '');
    if (!name && s.nickName) name = s.nickName;
    if (!name) name = s.username;

    chats.push({
      username: s.username,
      name,
      nickName: s.nickName || '',
      remark: c ? c.remark : '',
      digest: s.digest || '',
      time: s.time || 0,
      timeText: s.time ? exporter.fmtTime(s.time) : '',
      unread: s.unread || 0,
      isGroup: s.username.endsWith('@chatroom'),
      isOfficial: s.username.startsWith('gh_'),
      hasMessages: !!hit,
      dbFiles: hit ? hit.dbs : [],
      table: tbl,
    });
  }

  // 2) 有消息但不在 session 里的（用 Name2Id 反查 username）
  for (const t of talkers) {
    if (seenTable.has(t.table)) continue;
    // 从该库的 Name2Id 里找出所有 username，逐个算 md5 比对
    let matchedUser = '';
    for (const f of t.dbs) {
      const users = contactsMod.listUsernamesFromMsgDb(msgDir, f);
      for (const u of users) {
        if (msgdb.tableNameFor(u) === t.table) { matchedUser = u; break; }
      }
      if (matchedUser) break;
    }
    if (matchedUser) {
      const c = contacts.get(matchedUser);
      chats.push({
        username: matchedUser,
        name: contactsMod.displayName(c, matchedUser),
        nickName: '',
        remark: c ? c.remark : '',
        digest: '',
        time: 0,
        timeText: '',
        unread: 0,
        isGroup: matchedUser.endsWith('@chatroom'),
        isOfficial: matchedUser.startsWith('gh_'),
        hasMessages: true,
        dbFiles: t.dbs,
        table: t.table,
        noSession: true,
      });
    } else {
      chats.push({
        username: '',
        name: '(未知) ' + t.table.slice(4, 12),
        nickName: '',
        remark: '',
        digest: '',
        time: 0,
        timeText: '',
        unread: 0,
        isGroup: false,
        isOfficial: false,
        hasMessages: true,
        dbFiles: t.dbs,
        table: t.table,
        unknown: true,
      });
    }
  }

  chats.sort((a, b) => (b.time || 0) - (a.time || 0));
  return { ok: true, chats, contactCount: contacts.size, sessionCount: sessions.length };
}

/**
 * 读取某会话消息
 */
function readChat(cfg, accountName, chat, opts = {}) {
  const dir = decryptedDir(cfg, accountName);
  const msgDir = path.join(dir, 'message');
  const contactDb = path.join(dir, 'contact', 'contact.db');
  const contacts = contactsMod.loadContacts(contactDb);

  const table = chat.table || msgdb.tableNameFor(chat.username);
  const files = chat.dbFiles && chat.dbFiles.length
    ? chat.dbFiles
    : fs.readdirSync(msgDir).filter((f) => /^message_\d+\.db$/.test(f));

  const all = [];
  for (const f of files) {
    const dbPath = path.join(msgDir, f);
    if (!fs.existsSync(dbPath)) continue;
    let db;
    try {
      db = msgdb.safeOpen(dbPath);
      if (!msgdb.tableExists(db, table)) continue;
      const msgs = msgdb.readMessages(db, table, opts);
      for (const m of msgs) m._dbFile = f;
      all.push(...msgs);
    } catch (e) {
      log(`读取 ${f}/${table} 失败: ${e.message}`);
    } finally {
      try { db && db.close(); } catch (_) {}
    }
  }
  // 去重（按 serverId，没有则按 localId+时间）
  const seen = new Set();
  const dedup = [];
  for (const m of all) {
    const k = m.serverId ? 's' + m.serverId : 'l' + m.createTime + '_' + m.localId;
    if (seen.has(k)) continue;
    seen.add(k);
    dedup.push(m);
  }
  dedup.sort((a, b) => (a.createTime - b.createTime) || (a.localId - b.localId));
  return { messages: dedup, contacts };
}

/**
 * 读取账号下所有头像（username -> {buf, md5}）
 * head_image.db 表结构：username, md5, image_buffer, update_time
 */
function loadAvatars(cfg, accountName) {
  const map = new Map();
  const dbPath = path.join(decryptedDir(cfg, accountName), 'head_image', 'head_image.db');
  if (!fs.existsSync(dbPath)) return map;
  let db;
  try {
    db = msgdb.safeOpen(dbPath);
    const rows = db.prepare('SELECT username, md5, image_buffer FROM head_image').all();
    for (const r of rows) {
      if (!r.username || !r.image_buffer) continue;
      const buf = Buffer.isBuffer(r.image_buffer) ? r.image_buffer : Buffer.from(r.image_buffer);
      if (buf.length < 16) continue;
      map.set(r.username, { buf, md5: r.md5 || '' });
    }
  } catch (_) {
  } finally {
    try { db && db.close(); } catch (_) {}
  }
  return map;
}

/**
 * 取单个头像的 Buffer
 */
function getAvatar(cfg, accountName, username) {
  if (!username) return null;
  const dbPath = path.join(decryptedDir(cfg, accountName), 'head_image', 'head_image.db');
  if (!fs.existsSync(dbPath)) return null;
  let db;
  try {
    db = msgdb.safeOpen(dbPath);
    const row = db.prepare('SELECT image_buffer FROM head_image WHERE username = ?').get(username);
    if (!row || !row.image_buffer) return null;
    return Buffer.isBuffer(row.image_buffer) ? row.image_buffer : Buffer.from(row.image_buffer);
  } catch (_) {
    return null;
  } finally {
    try { db && db.close(); } catch (_) {}
  }
}

module.exports = {
  state, log, setProgress,
  getAccounts, dbStorageOf, workDirOf, decryptedDir,
  decryptAccount, scanKeys, deriveKeysFromPassphrase,
  listChats, readChat,
  loadAvatars, getAvatar,
};
