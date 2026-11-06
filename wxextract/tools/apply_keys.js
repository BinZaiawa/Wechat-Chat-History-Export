'use strict';
/**
 * 把提取到的密钥写入 data/config.json
 *
 * 用法：
 *   node wxextract/tools/apply_keys.js
 *   node wxextract/tools/apply_keys.js all_keys.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG = path.join(ROOT, 'data', 'config.json');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  let src = process.argv[2];
  if (!src) {
    const cands = [
      path.join(ROOT, 'all_keys.json'),
      path.join(process.cwd(), 'all_keys.json'),
      path.join(__dirname, 'all_keys.json'),
    ];
    src = cands.find((p) => fs.existsSync(p));
  }

  if (!src || !fs.existsSync(src)) {
    console.error('[错误] 找不到 all_keys.json');
    console.error('请先运行: node wxextract/tools/extract_key.js');
    process.exit(1);
  }

  console.log(`[*] 读取 ${src}`);
  let keys;
  try {
    keys = JSON.parse(fs.readFileSync(src, 'utf8'));
  } catch (e) {
    console.error('[错误] 解析失败: ' + e.message);
    process.exit(1);
  }

  if (!keys || typeof keys !== 'object' || !Object.keys(keys).length) {
    console.error('[错误] 密钥文件为空或格式不对');
    process.exit(1);
  }

  // 备份配置
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  if (fs.existsSync(CONFIG)) {
    const bak = CONFIG + '.bak-' + stamp();
    fs.copyFileSync(CONFIG, bak);
    console.log(`[*] 配置已备份: ${bak}`);
  }

  let cfg = {};
  if (fs.existsSync(CONFIG)) {
    try {
      let raw = fs.readFileSync(CONFIG, 'utf8');
      if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
      cfg = JSON.parse(raw);
    } catch (_) {
      cfg = {};
    }
  }

  if (!cfg.keys) cfg.keys = {};

  let count = 0;
  for (const [rel, v] of Object.entries(keys)) {
    if (v && typeof v === 'object' && v.enc_key) {
      cfg.keys[rel] = {
        encKey: v.enc_key,
        salt: v.salt || '',
        by: v.by || 'node_scan',
      };
      count++;
    } else if (typeof v === 'string') {
      cfg.keys[rel] = { encKey: v, by: 'manual' };
      count++;
    }
  }

  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8');

  console.log(`[+] 已写入 ${count} 个库的密钥`);
  console.log(`    配置: ${CONFIG}`);
  console.log(`    总计: ${Object.keys(cfg.keys).length} 个库`);
  console.log('');
  console.log('下一步：双击 启动.bat → 点「解密数据库」');
}

main();
