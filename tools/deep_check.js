'use strict';
/**
 * 深度检查：运行时行为、边界、安全隐患
 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      walk(full, out);
    } else out.push(full);
  }
  return out;
}

const files = walk(REPO);
const jsFiles = files.filter((f) => f.endsWith('.js'));

const issues = [];
const warns = [];

console.log('=== 1. 服务器监听地址 ===\n');
{
  const srv = path.join(REPO, 'wxextract', 'lib', 'server.js');
  const cfg = path.join(REPO, 'wxextract', 'lib', 'config.js');
  const cfgTxt = fs.readFileSync(cfg, 'utf8');
  const m = cfgTxt.match(/host:\s*['"]([^'"]+)['"]/);
  const host = m ? m[1] : '?';
  console.log(`  默认 host: ${host}`);
  if (host !== '127.0.0.1' && host !== 'localhost') {
    issues.push({ f: 'config.js', t: '监听地址', d: `host=${host} 会暴露到局域网` });
  } else {
    console.log('  ✅ 仅监听本机，局域网无法访问');
  }
}

console.log('');
console.log('=== 2. 路径穿越风险（静态文件服务）===\n');
{
  const srv = path.join(REPO, 'wxextract', 'lib', 'server.js');
  const txt = fs.readFileSync(srv, 'utf8');
  const hasCheck = txt.includes('startsWith(PUBLIC)') || txt.includes('startsWith(publicDir)');
  const hasNormalize = txt.includes('path.normalize');
  console.log(`  有 path.normalize: ${hasNormalize}`);
  console.log(`  有前缀校验: ${hasCheck}`);
  if (!hasCheck) {
    issues.push({ f: 'lib/server.js', t: '路径穿越', d: '静态服务未校验路径前缀' });
  } else {
    console.log('  ✅ 有校验');
  }
}

console.log('');
console.log('=== 3. 命令注入风险 ===\n');
{
  let found = 0;
  for (const f of jsFiles) {
    const rel = path.relative(REPO, f).replace(/\\/g, '/');
    const txt = fs.readFileSync(f, 'utf8');
    // exec / execSync 带字符串拼接
    const re = /\b(exec|execSync)\s*\(\s*[`'"][^`'"]*\$\{/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
      const line = txt.slice(0, m.index).split('\n').length;
      issues.push({ f: rel, t: '命令注入', d: `L${line} exec 用模板字符串拼接` });
      found++;
    }
  }
  if (!found) console.log('  ✅ 未发现 exec 字符串拼接');
}

console.log('');
console.log('=== 4. open-dir 接口（可执行外部程序）===\n');
{
  const srv = path.join(REPO, 'wxextract', 'lib', 'server.js');
  const txt = fs.readFileSync(srv, 'utf8');
  const m = txt.match(/explorer\.exe[^;]*/);
  if (m) {
    console.log('  使用 explorer.exe');
    // 检查是否校验了目录（statSync / existsSync / isDirectory 任一即可）
    const hasCheck = txt.includes('fs.statSync(dir)')
      || txt.includes('fs.existsSync(dir)')
      || txt.includes('st.isDirectory()');
    if (!hasCheck) {
      warns.push({ f: 'lib/server.js', t: 'open-dir', d: '未校验目录存在性' });
    } else {
      console.log('  ✅ 已校验目录存在性');
    }
  } else {
    console.log('  未使用 explorer');
  }
}

console.log('');
console.log('=== 5. 未捕获异常处理 ===\n');
{
  const srv = path.join(REPO, 'wxextract', 'server.js');
  const txt = fs.readFileSync(srv, 'utf8');
  const hasUncaught = txt.includes('uncaughtException');
  const hasRejection = txt.includes('unhandledRejection');
  console.log(`  uncaughtException: ${hasUncaught}`);
  console.log(`  unhandledRejection: ${hasRejection}`);
  if (!hasUncaught || !hasRejection) {
    warns.push({ f: 'server.js', t: '异常处理', d: '缺少全局异常兜底' });
  } else {
    console.log('  ✅ 有兜底');
  }
}

console.log('');
console.log('=== 6. 内存占用风险 ===\n');
{
  // 检查读全部消息的地方
  const core = path.join(REPO, 'wxextract', 'lib', 'core.js');
  const txt = fs.readFileSync(core, 'utf8');
  if (txt.includes('readMessages(db, table, opts)') && !txt.includes('limit')) {
    warns.push({ f: 'lib/core.js', t: '内存', d: 'readChat 一次读全部消息，超大会话可能占内存' });
  }
  // 检查前端渲染
  const app = path.join(REPO, 'wxextract', 'public', 'app.js');
  const appTxt = fs.readFileSync(app, 'utf8');
  const lm = appTxt.match(/limit:\s*(\d+)/);
  console.log(`  前端请求消息上限: ${lm ? lm[1] : '未设置'}`);
  if (!lm) {
    issues.push({ f: 'public/app.js', t: '内存', d: '未限制消息数量，大群会卡' });
  }
}

console.log('');
console.log('=== 7. 空值/边界处理 ===\n');
{
  const checks = [
    { file: 'wxextract/lib/exporter.js', pattern: 'messages.length', desc: '空消息数组' },
    { file: 'wxextract/lib/msgdb.js', pattern: 'page1.length', desc: '短页处理' },
  ];
  for (const c of checks) {
    const p = path.join(REPO, c.file);
    const txt = fs.readFileSync(p, 'utf8');
    const ok = txt.includes(c.pattern);
    console.log(`  ${c.desc}: ${ok ? '✅ 有处理' : '⚠ 未见'}`);
  }
}

console.log('');
console.log('=== 8. 时间戳溢出（32 位）===\n');
{
  // 微信时间戳到 2038 年后会溢出 32 位
  const exp = path.join(REPO, 'wxextract', 'lib', 'exporter.js');
  const txt = fs.readFileSync(exp, 'utf8');
  const usesInt32 = txt.includes('| 0') || txt.includes('<< 0');
  console.log(`  用 32 位位运算处理时间: ${usesInt32}`);
  console.log(`  用 new Date(ts * 1000): ${txt.includes('ts * 1000')}`);
  if (txt.includes('new Date(ts * 1000)')) {
    console.log('  ✅ 用 64 位浮点，无 2038 问题');
  }
}

console.log('');
console.log('=== 9. 特殊字符文件名 ===\n');
{
  const exp = path.join(REPO, 'wxextract', 'lib', 'exporter.js');
  const txt = fs.readFileSync(exp, 'utf8');
  const m = txt.match(/function safeName[^}]+}/);
  if (m) {
    console.log('  safeName:', m[0].replace(/\s+/g, ' ').slice(0, 100));
    const covers = ['\\\\', ':', '*', '?', '"', '<', '>', '|'];
    const ok = covers.every((c) => m[0].includes(c.replace(/\\\\/, '\\\\')));
    console.log(`  覆盖非法字符: ${ok ? '✅' : '⚠ 可能不全'}`);
  }
}

console.log('');
console.log('=== 10. 并发/竞态 ===\n');
{
  const core = path.join(REPO, 'wxextract', 'lib', 'core.js');
  const txt = fs.readFileSync(core, 'utf8');
  const hasBusy = txt.includes('state.busy');
  console.log(`  有 busy 标志: ${hasBusy}`);
  if (!hasBusy) {
    warns.push({ f: 'lib/core.js', t: '并发', d: '无忙标志，同时点两次解密可能冲突' });
  } else {
    console.log('  ✅ 有忙标志');
  }
}

console.log('');
console.log('='.repeat(64));
console.log('结果');
console.log('='.repeat(64));

if (!issues.length) {
  console.log('✅ 无严重问题');
} else {
  console.log(`❌ ${issues.length} 个问题：`);
  for (const i of issues) {
    console.log(`  ${i.f}  [${i.t}] ${i.d}`);
  }
}

if (warns.length) {
  console.log('');
  console.log(`⚠️  ${warns.length} 个建议：`);
  for (const w of warns) {
    console.log(`  ${w.f}  [${w.t}] ${w.d}`);
  }
}

console.log('');
console.log('='.repeat(64));
