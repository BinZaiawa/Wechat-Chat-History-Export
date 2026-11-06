'use strict';
/**
 * 微信数据目录自动发现
 * 支持 4.x (xwechat_files) 与 3.x (WeChat Files)
 *
 * 说明：
 *  - 4.x 账号目录形如 wxid_xxxx_abcd
 *  - 3.x 账号目录形如 wxid_xxxx
 *  - 只做只读枚举，不修改任何微信文件
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

/** 常见候选根目录 */
function candidateRoots() {
  const home = os.homedir();
  const out = [
    path.join(home, 'Documents', 'xwechat_files'),
    path.join(home, 'Documents', 'WeChat Files'),
    path.join(home, 'xwechat_files'),
  ];
  // 读取微信配置 ini 中的自定义存储路径（4.x）
  try {
    const cfgDir = path.join(process.env.APPDATA || '', 'Tencent', 'xwechat', 'config');
    if (fs.existsSync(cfgDir)) {
      for (const f of fs.readdirSync(cfgDir)) {
        if (!f.endsWith('.ini')) continue;
        const txt = safeRead(path.join(cfgDir, f), 8192);
        // 匹配形如 MyDocument:D:\xxx 或 FileSavePath:xxx
        const m = txt.match(/(?:MyDocument|FileSavePath|SavePath)\s*[:=]\s*([A-Za-z]:\\[^\r\n\x00]+)/i);
        if (m) {
          const p = m[1].trim();
          const parent = path.dirname(p);
          out.push(p);
          out.push(path.join(parent, 'xwechat_files'));
          out.push(path.join(p, 'xwechat_files'));
        }
      }
    }
  } catch (_) {}
  return [...new Set(out.filter(Boolean))];
}

function safeRead(p, max) {
  try {
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(max || 4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('latin1');
  } catch (_) {
    return '';
  }
}

/** 判断某目录是否是微信数据根（含账号子目录） */
function isRoot(p) {
  try {
    if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) return false;
    const subs = fs.readdirSync(p, { withFileTypes: true });
    return subs.some((d) => d.isDirectory() && (d.name.startsWith('wxid_') || d.name === 'all_users'));
  } catch (_) {
    return false;
  }
}

/** 列出账号 */
function listAccounts(root) {
  const accounts = [];
  let subs = [];
  try {
    subs = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return accounts;
  }
  for (const d of subs) {
    if (!d.isDirectory()) continue;
    if (d.name === 'all_users') continue;
    const full = path.join(root, d.name);
    const dbStorage = path.join(full, 'db_storage');
    const hasDb = fs.existsSync(dbStorage);
    const hasMsg = fs.existsSync(path.join(full, 'msg'));
    if (!hasDb && !hasMsg) continue;

    let sizeBytes = 0;
    let dbCount = 0;
    if (hasDb) {
      const stats = walkStats(dbStorage, (f) => f.endsWith('.db'));
      sizeBytes = stats.bytes;
      dbCount = stats.count;
    }
    accounts.push({
      name: d.name,
      path: full,
      dbStorage: hasDb ? dbStorage : '',
      hasDb,
      dbCount,
      sizeMB: +(sizeBytes / 1024 / 1024).toFixed(1),
      // 4.x 目录名带后缀哈希，wxid 前缀用于展示
      wxidGuess: d.name.startsWith('wxid_') ? d.name.split('_').slice(0, 2).join('_') : d.name,
    });
  }
  accounts.sort((a, b) => b.sizeMB - a.sizeMB);
  return accounts;
}

function walkStats(dir, filter, limit) {
  let bytes = 0;
  let count = 0;
  const stack = [dir];
  let guard = 0;
  while (stack.length && guard < 200000) {
    guard++;
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile()) {
        if (filter && !filter(e.name, full)) continue;
        count++;
        try { bytes += fs.statSync(full).size; } catch (_) {}
      }
    }
  }
  return { bytes, count };
}

/** 找到所有含 db 的数据根 */
function detect() {
  const roots = [];
  for (const c of candidateRoots()) {
    if (isRoot(c)) {
      const accounts = listAccounts(c);
      if (accounts.length) roots.push({ root: c, accounts });
    }
  }
  return roots;
}

module.exports = { detect, listAccounts, candidateRoots, isRoot, walkStats };
