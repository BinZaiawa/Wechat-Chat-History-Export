'use strict';
/** 检查依赖引用、硬编码路径、文档一致性 */
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

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

const files = walk(REPO);
const jsFiles = files.filter((f) => f.endsWith('.js'));

console.log('=== 1. 硬编码绝对路径 ===\n');
let hardPaths = [];
for (const f of jsFiles) {
  const rel = path.relative(REPO, f).replace(/\\/g, '/');
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    // 匹配 C:\ 或 D:\ 开头的路径字面量
    const m = line.match(/['"`]([CD]:\\\\[^'"`]+)['"`]/);
    if (m) {
      hardPaths.push({ file: rel, line: i + 1, path: m[1], text: line.trim() });
    }
  });
}

if (!hardPaths.length) {
  console.log('  ✅ 无硬编码绝对路径');
} else {
  const byFile = {};
  for (const h of hardPaths) {
    if (!byFile[h.file]) byFile[h.file] = [];
    byFile[h.file].push(h);
  }
  for (const [f, list] of Object.entries(byFile)) {
    console.log(`  ${f}: ${list.length} 处`);
    for (const h of list.slice(0, 4)) {
      console.log(`    L${h.line}: ${h.path.slice(0, 70)}`);
    }
  }
}

console.log('');
console.log('=== 2. 相对 require 解析 ===\n');
let bad = 0;
for (const f of jsFiles) {
  const txt = fs.readFileSync(f, 'utf8');
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const target = path.resolve(path.dirname(f), m[1]);
    const ok =
      fs.existsSync(target) ||
      fs.existsSync(target + '.js') ||
      fs.existsSync(path.join(target, 'index.js'));
    if (!ok) {
      console.log(`  ❌ ${path.relative(REPO, f)} -> ${m[1]}`);
      bad++;
    }
  }
}
console.log(bad ? `  共 ${bad} 处缺失` : '  ✅ 全部可解析');

console.log('');
console.log('=== 3. 外部依赖（非 node: 前缀）===\n');
const externals = new Set();
for (const f of jsFiles) {
  const txt = fs.readFileSync(f, 'utf8');
  const re = /require\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const mod = m[1];
    if (mod.startsWith('node:')) continue;
    externals.add(mod.split('/')[0]);
  }
}
const builtins = new Set(require('module').builtinModules);
const realExternal = [...externals].filter((m) => !builtins.has(m));
console.log('  外部依赖:', realExternal.length ? realExternal.join(', ') : '无（全部是内置模块）');

console.log('');
console.log('=== 4. package.json 声明一致性 ===\n');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
]);
for (const m of realExternal) {
  console.log(`  ${m}: ${declared.has(m) ? '✅ 已声明' : '❌ 未声明'}`);
}
if (!realExternal.length) console.log('  ✅ 无需声明');

console.log('');
console.log('=== 5. README 提到的文件是否存在 ===\n');
const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
// 找 ```bat 代码块里的命令
const cmds = readme.match(/```bat\n([\s\S]*?)```/g) || [];
let checked = 0;
let missing = 0;
for (const block of cmds) {
  const lines = block.split('\n').slice(1, -1);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    // 提取文件路径
    const fm = t.match(/(?:node\s+)?([\w\\/.]+\.(?:js|bat))/);
    if (fm) {
      const p = path.join(REPO, fm[1]);
      checked++;
      if (!fs.existsSync(p)) {
        console.log(`  ❌ ${fm[1]} 不存在`);
        missing++;
      }
    }
  }
}
console.log(missing ? `  ${missing}/${checked} 处缺失` : `  ✅ ${checked} 个引用都存在`);

console.log('');
console.log('=== 6. 文件清单 vs README 结构描述 ===\n');
const libDir = path.join(REPO, 'wxextract', 'lib');
const libFiles = fs.readdirSync(libDir).filter((f) => f.endsWith('.js'));
let docMissing = 0;
for (const f of libFiles) {
  if (!readme.includes(f)) {
    console.log(`  ⚠ ${f} 未在 README 中提及`);
    docMissing++;
  }
}
console.log(docMissing ? `  ${docMissing} 个文件未文档化` : '  ✅ 全部已文档化');

console.log('');
console.log('='.repeat(60));
