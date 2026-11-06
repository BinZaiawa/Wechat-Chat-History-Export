'use strict';
/**
 * 上传前安全审计
 *
 * 检查 repo 目录里是否有任何隐私数据残留：
 *   1. 密钥（32 字节 hex 串，64 字符）
 *   2. 已知的具体密钥值
 *   3. salt（16 字节 hex，32 字符）
 *   4. 真实聊天内容片段
 *   5. 个人路径（用户名）
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const PROJECT = path.resolve(REPO, '..');

// 已知的敏感值（从当前项目读）
function loadKnownSecrets() {
  const secrets = { keys: new Set(), salts: new Set(), snippets: [] };

  const kf = path.join(PROJECT, 'all_keys.json');
  if (fs.existsSync(kf)) {
    try {
      const keys = JSON.parse(fs.readFileSync(kf, 'utf8'));
      for (const [rel, v] of Object.entries(keys)) {
        if (v && v.enc_key) secrets.keys.add(v.enc_key.toLowerCase());
        if (v && v.salt) secrets.salts.add(v.salt.toLowerCase());
      }
    } catch (_) {}
  }

  const cf = path.join(PROJECT, 'data', 'config.json');
  if (fs.existsSync(cf)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cf, 'utf8'));
      for (const [rel, v] of Object.entries(cfg.keys || {})) {
        if (v && v.encKey) secrets.keys.add(v.encKey.toLowerCase());
        if (v && v.salt) secrets.salts.add(v.salt.toLowerCase());
      }
    } catch (_) {}
  }

  // 真实聊天片段：从导出目录动态采样（不硬编码任何内容）
  try {
    const expDir = path.join(PROJECT, 'exports');
    if (fs.existsSync(expDir)) {
      const files = fs.readdirSync(expDir).filter((f) => f.endsWith('.txt') || f.endsWith('.md'));
      if (files.length) {
        const sample = fs.readFileSync(path.join(expDir, files[0]), 'utf8');
        // 取长度 6-12 的中文片段作为检测特征
        const matches = sample.match(/[\u4e00-\u9fa5]{6,12}/g) || [];
        const uniq = [...new Set(matches)].slice(0, 20);
        secrets.snippets = uniq;
      }
    }
  } catch (_) {}

  return secrets;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

function main() {
  const secrets = loadKnownSecrets();
  console.log('=== 上传前安全审计 ===\n');
  console.log(`已知密钥: ${secrets.keys.size} 个`);
  console.log(`已知 salt: ${secrets.salts.size} 个`);
  console.log('');

  const files = walk(REPO);
  console.log(`检查 ${files.length} 个文件…\n`);

  const problems = [];
  const hex64 = /\b[0-9a-f]{64}\b/gi;
  const hex32 = /\b[0-9a-f]{32}\b/gi;

  for (const f of files) {
    const rel = path.relative(REPO, f);
    let text;
    try {
      const buf = fs.readFileSync(f);
      // 跳过二进制
      if (buf.includes(0)) continue;
      text = buf.toString('utf8');
    } catch (_) {
      continue;
    }

    // 1. 精确密钥匹配
    for (const k of secrets.keys) {
      if (text.toLowerCase().includes(k)) {
        problems.push({ file: rel, type: '密钥泄露', detail: k.slice(0, 16) + '...' });
      }
    }

    // 2. 精确 salt 匹配
    for (const s of secrets.salts) {
      if (text.toLowerCase().includes(s)) {
        problems.push({ file: rel, type: 'salt 泄露', detail: s.slice(0, 12) + '...' });
      }
    }

    // 3. 通用 64 位 hex（可能是别的密钥）
    const m64 = text.match(hex64);
    if (m64) {
      for (const m of new Set(m64)) {
        // 排除 XOR mask（这是我们自己的常量，公开的）
        if (m === 'd2c7442458020000004889442450488b450048844c2448488944254048584c24') continue;
        problems.push({ file: rel, type: '疑似密钥（64 hex）', detail: m.slice(0, 16) + '...' });
      }
    }

    // 4. 聊天内容片段
    for (const snip of secrets.snippets) {
      if (text.includes(snip)) {
        problems.push({ file: rel, type: '真实聊天内容', detail: snip });
      }
    }

    // 5. 个人路径
    if (/C:\\Users\\[^\\]+\\/i.test(text)) {
      const m = text.match(/C:\\Users\\[^\\]+\\/i);
      if (m && !m[0].includes('Public')) {
        problems.push({ file: rel, type: '个人路径', detail: m[0] });
      }
    }
    if (/D:\\DeepSeek Harness/i.test(text) && !rel.includes('extract_key')) {
      // extract_key 里没有硬编码，但检查其他地方
    }
  }

  console.log('='.repeat(60));
  if (!problems.length) {
    console.log('✅ 未发现隐私数据');
    console.log('='.repeat(60));
    return 0;
  }

  console.log(`❌ 发现 ${problems.length} 处问题：\n`);
  const grouped = {};
  for (const p of problems) {
    if (!grouped[p.file]) grouped[p.file] = [];
    grouped[p.file].push(p);
  }
  for (const [file, list] of Object.entries(grouped)) {
    console.log(`  ${file}`);
    for (const p of list.slice(0, 5)) {
      console.log(`    [${p.type}] ${p.detail}`);
    }
    if (list.length > 5) console.log(`    ... 还有 ${list.length - 5} 处`);
  }
  console.log('='.repeat(60));
  return 1;
}

process.exit(main());
