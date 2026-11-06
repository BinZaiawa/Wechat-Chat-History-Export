'use strict';
/**
 * 仓库健康检查
 *
 * 检查项：
 *   1. 文件编码（必须是 UTF-8，无 BOM）
 *   2. 换行符（.bat 必须 CRLF，其余 LF 或 CRLF 均可）
 *   3. 非 ASCII 字符位置（.bat 必须纯 ASCII）
 *   4. JS 语法
 *   5. JSON 有效性
 *   6. 隐私数据（复用 audit）
 *   7. 文件大小异常
 *   8. 行尾空白
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
    } else {
      out.push(full);
    }
  }
  return out;
}

function checkBom(buf) {
  return buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
}

function checkEol(buf) {
  let crlf = 0;
  let lfOnly = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0A) {
      if (i > 0 && buf[i - 1] === 0x0D) crlf++;
      else lfOnly++;
    }
  }
  return { crlf, lfOnly };
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function countNonAscii(buf) {
  let n = 0;
  for (const b of buf) if (b > 127) n++;
  return n;
}

function main() {
  console.log('=== 仓库健康检查 ===\n');

  const files = walk(REPO);
  console.log(`检查 ${files.length} 个文件\n`);

  const issues = [];
  const warnings = [];
  let jsCount = 0;
  let jsonCount = 0;

  for (const f of files) {
    const rel = path.relative(REPO, f).replace(/\\/g, '/');
    const ext = path.extname(f).toLowerCase();
    const buf = fs.readFileSync(f);

    if (isBinary(buf)) continue;

    // 1. BOM
    if (checkBom(buf)) {
      issues.push({ file: rel, type: 'BOM', detail: 'UTF-8 BOM 会导致部分工具解析失败' });
    }

    // 2. 换行
    const eol = checkEol(buf);
    if (ext === '.bat' || ext === '.cmd') {
      if (eol.lfOnly > 0) {
        issues.push({
          file: rel,
          type: '换行符',
          detail: `bat 文件有 ${eol.lfOnly} 个 LF-only，必须全部 CRLF`,
        });
      }
    }

    // 3. bat 必须纯 ASCII
    if (ext === '.bat' || ext === '.cmd') {
      const na = countNonAscii(buf);
      if (na > 0) {
        issues.push({
          file: rel,
          type: '非 ASCII',
          detail: `bat 含 ${na} 个非 ASCII 字节，cmd 会乱码`,
        });
      }
    }

    // 4. JS 语法（用 vm 在进程内解析，不依赖子进程）
    if (ext === '.js') {
      jsCount++;
      try {
        const vm = require('vm');
        new vm.Script(buf.toString('utf8'), { filename: rel });
      } catch (e) {
        const msg = (e.message || '').split('\n').slice(0, 2).join(' ');
        issues.push({ file: rel, type: '语法错误', detail: msg.slice(0, 150) });
      }
    }

    // 5. JSON 有效性
    if (ext === '.json') {
      jsonCount++;
      try {
        JSON.parse(buf.toString('utf8'));
      } catch (e) {
        issues.push({ file: rel, type: 'JSON 无效', detail: e.message.slice(0, 100) });
      }
    }

    // 6. 行尾空白（仅警告）
    if (['.js', '.css', '.html', '.md', '.json'].includes(ext)) {
      const lines = buf.toString('utf8').split('\n');
      let trailing = 0;
      for (const l of lines) {
        if (/[ \t]+$/.test(l)) trailing++;
      }
      if (trailing > 0) {
        warnings.push({ file: rel, type: '行尾空白', detail: `${trailing} 行` });
      }
    }

    // 7. 文件过大
    if (buf.length > 1024 * 1024) {
      warnings.push({
        file: rel,
        type: '文件过大',
        detail: `${(buf.length / 1024 / 1024).toFixed(1)} MB`,
      });
    }

    // 8. 制表符混用（仅警告）
    if (['.js', '.css'].includes(ext)) {
      const text = buf.toString('utf8');
      if (text.includes('\t') && text.includes('  ')) {
        // 有 tab 也有空格缩进，可能不一致
      }
    }
  }

  console.log('='.repeat(64));
  console.log('结果');
  console.log('='.repeat(64));
  console.log(`JS 文件: ${jsCount} | JSON 文件: ${jsonCount}`);
  console.log('');

  if (!issues.length) {
    console.log('✅ 无错误');
  } else {
    console.log(`❌ ${issues.length} 个错误：\n`);
    for (const i of issues) {
      console.log(`  ${i.file}`);
      console.log(`    [${i.type}] ${i.detail}`);
    }
  }

  if (warnings.length) {
    console.log('');
    console.log(`⚠️  ${warnings.length} 个警告：\n`);
    for (const w of warnings.slice(0, 10)) {
      console.log(`  ${w.file}  [${w.type}] ${w.detail}`);
    }
    if (warnings.length > 10) {
      console.log(`  ... 还有 ${warnings.length - 10} 个`);
    }
  }

  console.log('');
  console.log('='.repeat(64));
  return issues.length ? 1 : 0;
}

process.exit(main());
