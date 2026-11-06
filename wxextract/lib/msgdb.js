'use strict';
/**
 * 消息库解析（微信 4.x）
 *
 * 关键点（均已核实）：
 *  - 消息按联系人分表：Msg_<MD5(wxid)>，跨多个 message_N.db 分片
 *  - real_sender_id 指向本库 Name2Id.rowid（每个库独立，不可跨库复用）
 *  - WCDB_CT_message_content = 4 表示 message_content 为 zstd 压缩
 *  - local_type: 1文本 3图片 34语音 42名片 43视频 47表情 48定位 49富媒体 10000系统
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite');

const MSG_TYPE = {
  1: '文本',
  3: '图片',
  34: '语音',
  42: '名片',
  43: '视频',
  47: '表情',
  48: '位置',
  49: '富媒体',
  50: '通话',
  10000: '系统消息',
  10002: '系统消息',
};

function tableNameFor(username) {
  return 'Msg_' + crypto.createHash('md5').update(username, 'utf8').digest('hex');
}

function safeOpen(dbPath) {
  // 只读打开，避免任何写入
  return new DatabaseSync(dbPath, { readOnly: true });
}

function tableExists(db, name) {
  try {
    const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    return !!row;
  } catch (_) {
    return false;
  }
}

function listTables(db) {
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  } catch (_) {
    return [];
  }
}

/** 解压消息内容
 * 微信 4.x 实测：
 *   - message_content 常为 BLOB（zstd 压缩），即使列声明是 TEXT
 *   - WCDB_CT_message_content 可能为 NULL，不能依赖它判断
 *   - 因此一律先嗅探 zstd 魔数 28 B5 2F FD
 */
function decodeContent(raw, ctFlag) {
  if (raw == null) return { text: '', kind: 'empty' };

  // 字符串直接返回
  if (typeof raw === 'string') {
    // 有些情况下字符串里也可能藏着压缩数据，但罕见，直接返回
    return { text: raw, kind: 'text' };
  }

  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.length === 0) return { text: '', kind: 'empty' };

  // 1) zstd 魔数嗅探（0xFD2FB528 小端 = 28 B5 2F FD）
  const isZstd = buf.length >= 4
    && buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd;
  if (isZstd) {
    try {
      return { text: zlib.zstdDecompressSync(buf).toString('utf8'), kind: 'zstd' };
    } catch (_) {
      // 解压失败，退回原文
    }
  }

  // 2) 标志位为 4 也尝试 zstd（兜底）
  if (ctFlag === 4) {
    try {
      return { text: zlib.zstdDecompressSync(buf).toString('utf8'), kind: 'zstd-flag' };
    } catch (_) {}
  }

  // 3) 尝试 UTF-8，失败则 latin1
  let text = buf.toString('utf8');
  if (text.includes('\ufffd')) text = buf.toString('latin1');
  return { text, kind: 'raw' };
}

/** 从 XML 富媒体内容提取信息 */
function parseXmlContent(xml) {
  const out = {};
  if (!xml || typeof xml !== 'string') return out;
  const pick = (tag) => {
    const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? unescapeXml(m[1]) : '';
  };
  out.title = pick('title');
  out.des = pick('des');
  out.url = pick('url');
  out.thumburl = pick('thumburl');
  out.type = pick('type');
  out.appname = pick('appname');
  out.md5 = pick('md5');
  out.filesize = pick('totallen');
  out.filename = pick('title') || pick('filename');
  out.appmsgType = pick('appmsg');
  // 红包/转账
  if (/wcpay/i.test(xml)) out.special = 'transfer';
  else if (/redenvelope/i.test(xml)) out.special = 'redpacket';
  return out;
}

function unescapeXml(s) {
  if (!s) return '';
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .trim();
}

/** 生成消息的可读摘要（纯文本，不含 XML） */
function summarize(msg, typeName) {
  const t = msg.local_type;
  const content = msg.content || '';
  const x = msg.xml || {};

  if (t === 1) return content;
  if (t === 3) return '[图片]';
  if (t === 34) return '[语音]' + (msg.voicelen ? ` ${msg.voicelen}"` : '');
  if (t === 43) return '[视频]' + (x.playlength ? ` ${x.playlength}s` : '');
  if (t === 47) return '[表情]';
  if (t === 42) return '[名片]' + (x.nickname ? ` ${x.nickname}` : '');
  if (t === 48) return '[位置]' + (x.label ? ` ${x.label}` : '');
  if (t === 49) {
    if (x.special === 'transfer') return '[转账]' + (x.title ? ` ${x.title}` : '');
    if (x.special === 'redpacket') return '[红包]' + (x.title ? ` ${x.title}` : '');
    if (x.type === '6' || x.filename) return '[文件] ' + (x.title || x.filename || '');
    if (x.type === '57') return '[引用] ' + (x.title || '');
    if (x.type === '5') return '[链接] ' + (x.title || '') + (x.url ? ` ${x.url}` : '');
    if (x.type === '3') return '[音乐] ' + (x.title || '');
    if (x.type === '19') return '[合并转发] ' + (x.title || '');
    if (x.type === '36' || x.type === '33') return '[小程序] ' + (x.title || '');
    return '[富媒体] ' + (x.title || x.des || '');
  }
  if (t === 50) return '[通话]';
  if (t === 10000 || t === 10002) {
    // 系统消息：去掉 XML 残留
    const clean = content.replace(/<[^>]+>/g, '').trim();
    return '[系统] ' + (clean || content);
  }
  // 兜底：如果内容像 XML，就不要原样输出
  if (content.trim().startsWith('<')) {
    return `[${typeName}]`;
  }
  return content || `[${typeName}]`;
}

/**
 * 扫描账号下所有消息库，返回 { dbs:[...], names:Map }
 */
function scanMessageDbs(dbStorageDir) {
  const msgDir = path.join(dbStorageDir, 'message');
  const dbs = [];
  if (!fs.existsSync(msgDir)) return dbs;
  for (const f of fs.readdirSync(msgDir)) {
    if (!/^message_\d+\.db$/.test(f)) continue;
    dbs.push({ file: f, path: path.join(msgDir, f) });
  }
  dbs.sort((a, b) => {
    const na = +a.file.match(/(\d+)/)[1];
    const nb = +b.file.match(/(\d+)/)[1];
    return na - nb;
  });
  return dbs;
}

/** 列出某解密库中所有 Msg_ 表 */
function listMsgTables(dbPath) {
  let db;
  try {
    db = safeOpen(dbPath);
    const tables = listTables(db).filter((t) => t.startsWith('Msg_'));
    return tables;
  } finally {
    try { db && db.close(); } catch (_) {}
  }
}

/** 读取某库的 Name2Id 映射 */
function readName2Id(db) {
  const map = new Map();
  if (!tableExists(db, 'Name2Id')) return map;
  try {
    const rows = db.prepare('SELECT rowid AS rid, user_name FROM Name2Id').all();
    for (const r of rows) map.set(r.rid, r.user_name);
  } catch (_) {}
  return map;
}

/**
 * 读取单个 Msg_ 表的全部消息
 * @returns {Array<object>}
 */
function readMessages(db, tableName, opts = {}) {
  const nameMap = readName2Id(db);
  const cols = new Set();
  try {
    for (const c of db.prepare(`PRAGMA table_info([${tableName}])`).all()) cols.add(c.name);
  } catch (_) {
    return [];
  }
  const has = (c) => cols.has(c);

  // 关键：server_id / server_seq 是 64 位整数，超出 JS 安全整数范围，
  // node:sqlite 直接读取会抛 ERR_OUT_OF_RANGE。用 CAST(... AS TEXT) 规避。
  const bigInt = (c) => (has(c) ? `CAST([${c}] AS TEXT) AS ${c}` : `NULL AS ${c}`);

  const select = [
    'local_id',
    bigInt('server_id'),
    'local_type',
    'sort_seq',
    'real_sender_id',
    'create_time',
    'status',
    bigInt('server_seq'),
    has('message_content') ? 'message_content' : 'NULL AS message_content',
    has('compress_content') ? 'compress_content' : 'NULL AS compress_content',
    has('WCDB_CT_message_content') ? 'WCDB_CT_message_content' : 'NULL AS WCDB_CT_message_content',
    has('packed_info_data') ? 'packed_info_data' : 'NULL AS packed_info_data',
  ];
  let sql = `SELECT ${select.join(',')} FROM [${tableName}]`;
  const params = [];
  if (opts.since) { sql += ' WHERE create_time >= ?'; params.push(opts.since); }
  if (opts.until) { sql += (params.length ? ' AND' : ' WHERE') + ' create_time <= ?'; params.push(opts.until); }
  sql += ' ORDER BY sort_seq ASC, create_time ASC, local_id ASC';
  if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }

  let rows = [];
  try {
    rows = params.length ? db.prepare(sql).all(...params) : db.prepare(sql).all();
  } catch (e) {
    // 兜底：去掉排序重试（某些表可能缺列）
    try {
      const fallback = `SELECT ${select.join(',')} FROM [${tableName}] LIMIT ${opts.limit || 100000}`;
      rows = db.prepare(fallback).all();
    } catch (e2) {
      return [];
    }
  }

  const out = [];
  for (const r of rows) {
    const ctFlag = r.WCDB_CT_message_content;
    let content = '';
    let contentKind = '';
    if (r.message_content != null) {
      const d = decodeContent(r.message_content, ctFlag);
      content = d.text; contentKind = d.kind;
    } else if (r.compress_content != null) {
      const d = decodeContent(r.compress_content, ctFlag);
      content = d.text; contentKind = d.kind;
    }
    const typeName = MSG_TYPE[r.local_type] || `类型${r.local_type}`;
    let xml = null;
    // 需要解析 XML 的类型：49 富媒体 / 42 名片 / 48 位置 / 47 表情 / 43 视频 / 3 图片
    if ([49, 42, 48, 47, 43, 3, 34].includes(r.local_type)) {
      xml = parseXmlContent(content);
      if (r.local_type === 42) xml.nickname = (content.match(/nickname="([^"]*)"/) || [])[1] || '';
      if (r.local_type === 48) xml.label = (content.match(/label="([^"]*)"/) || [])[1] || '';
      if (r.local_type === 34) xml.voicelen = (content.match(/voicelength="(\d+)"/) || [])[1] || '';
      if (r.local_type === 43) xml.playlength = (content.match(/playlength="(\d+)"/) || [])[1] || '';
    }
    let voicelen = '';
    if (r.local_type === 34) {
      const m = content.match(/voicelength="(\d+)"/);
      if (m) voicelen = Math.round(+m[1] / 1000);
    }
    const msg = {
      localId: r.local_id,
      serverId: r.server_id,
      type: r.local_type,
      typeName,
      sortSeq: r.sort_seq,
      senderId: r.real_sender_id,
      sender: nameMap.get(r.real_sender_id) || '',
      createTime: r.create_time,
      status: r.status,
      content,
      contentKind,
      xml,
      voicelen,
    };
    msg.summary = summarize(msg, typeName);
    out.push(msg);
  }
  return out;
}

module.exports = {
  MSG_TYPE, tableNameFor, safeOpen, tableExists, listTables,
  decodeContent, parseXmlContent, summarize, scanMessageDbs, listMsgTables, readName2Id, readMessages,
};
