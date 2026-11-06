'use strict';
/**
 * 配置管理
 * 所有配置落在 <项目根>/data/config.json
 * 修改前自动备份（带日期），可回滚。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  // 微信数据根目录（xwechat_files），留空则自动探测
  wechatRoot: '',
  // 指定账号目录名；留空表示全部账号
  account: '',
  // 密钥存储
  keys: {},          // { dbRelativePath: { encKeyHex, saltHex, sizeMb } }
  passphrase: '',    // 32字节主密码 hex（可选，用于 PBKDF2 派生）
  // 导出
  exportDir: path.join(ROOT, 'exports'),
  // 服务
  port: 8848,
  host: '127.0.0.1',
  // 解密临时目录
  workDir: path.join(DATA_DIR, 'decrypted'),
};

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function load() {
  ensureDir(DATA_DIR);
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = { ...DEFAULTS };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    return cfg;
  }
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    // 容错：去掉可能的 BOM
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const cfg = JSON.parse(raw);
    return { ...DEFAULTS, ...cfg };
  } catch (e) {
    // 配置损坏：备份后重建，不静默丢数据
    const bak = CONFIG_PATH + '.corrupt-' + stamp();
    try { fs.copyFileSync(CONFIG_PATH, bak); } catch (_) {}
    const cfg = { ...DEFAULTS };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    console.error(`[config] 配置文件损坏，已备份到 ${bak} 并重建默认配置`);
    return cfg;
  }
}

function save(cfg) {
  ensureDir(DATA_DIR);
  // 覆盖前备份（保留最近 20 份）
  if (fs.existsSync(CONFIG_PATH)) {
    const bak = CONFIG_PATH + '.bak-' + stamp();
    try { fs.copyFileSync(CONFIG_PATH, bak); } catch (_) {}
    pruneBackups();
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
  return CONFIG_PATH;
}

function pruneBackups() {
  try {
    const files = fs.readdirSync(DATA_DIR)
      .filter((f) => f.startsWith('config.json.bak-'))
      .sort();
    while (files.length > 20) {
      const f = files.shift();
      try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch (_) {}
    }
  } catch (_) {}
}

function backupDir() {
  return DATA_DIR;
}

module.exports = { load, save, DEFAULTS, ROOT, DATA_DIR, CONFIG_PATH, ensureDir, stamp, backupDir };
