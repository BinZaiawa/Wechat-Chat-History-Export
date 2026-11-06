'use strict';
/**
 * 微信 4.x 密钥提取（纯 Node，koffi 调用 Win32 API）
 *
 * 移植自 extract_key_v6.py，去掉 Python 依赖。
 *
 * 原理：
 *   微信把每个库的 raw key + salt 以 XOR 混淆的 x'<96hex>' 字符串
 *   存放在内存中。XOR mask 首两字节 d2 c7 使 'x' 变为 0xaa、"'" 变为 0xe0，
 *   因此搜索字节对 aa e0 即可定位所有密钥 blob。
 *
 * 用法：
 *   node wxextract/tools/extract_key.js            提取（attach 到运行中的微信）
 *   node wxextract/tools/extract_key.js --restart  重启微信后抓取
 *   node wxextract/tools/extract_key.js --max-mb 2000
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PAGE_SZ = 4096;
const KEY_SZ = 32;
const SALT_SZ = 16;

const XOR_MASK = Buffer.from(
  'd2c7442458020000004889442450488b' +
  '450048844c2448488944254048584c24',
  'hex'
);

const SIG_XOR = Buffer.from([0x78 ^ XOR_MASK[0], 0x27 ^ XOR_MASK[1]]); // 'x' ^ d2 = aa, "'" ^ c7 = e0
const SIG_PLAIN = Buffer.from("x'", 'latin1');
const LITERAL_RE = /[xX]'([0-9a-fA-F]{64,1024})'/g;

const MAX_USER_ADDR = 0x0000800000000000n;
const MEM_COMMIT = 0x1000;
const PAGE_READABLE = new Set([0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80]);
const PAGE_GUARD = 0x100;

const PROCESS_QUERY_INFORMATION = 0x0400;
const PROCESS_VM_READ = 0x0010;

/* ================= koffi 加载 ================= */

/**
 * 按优先级查找 koffi：
 *   1. 正常 require（npm install 或 vendor 目录）
 *   2. 程序目录下的 vendor/koffi（便携版）
 *   3. 常见 Electron 应用的 node_modules（兜底，不硬编码具体机器）
 */
function findKoffiPaths() {
  const paths = [
    path.join(__dirname, '..', '..', 'vendor', 'koffi'),
    path.join(__dirname, '..', 'vendor', 'koffi'),
    path.join(process.cwd(), 'vendor', 'koffi'),
  ];

  // 兜底：扫描常见的应用安装目录（用户可自行设置 KOFFI_PATH）
  if (process.env.KOFFI_PATH) {
    paths.unshift(process.env.KOFFI_PATH);
  }

  return paths;
}

function loadKoffi() {
  // 1. 正常 require
  try {
    return require('koffi');
  } catch (_) {}

  // 2. 候选路径
  for (const p of findKoffiPaths()) {
    try {
      if (fs.existsSync(p)) return require(p);
    } catch (_) {}
  }

  return null;
}

const koffi = loadKoffi();
if (!koffi) {
  console.error('[错误] 找不到 koffi 模块\n');
  console.error('安装方法（任选其一）：');
  console.error('  1. npm install koffi');
  console.error('  2. 把 koffi 目录放到 vendor/koffi/');
  console.error('  3. 设置环境变量 KOFFI_PATH 指向 koffi 目录\n');
  console.error('已尝试的路径：');
  for (const p of findKoffiPaths()) {
    console.error('  ' + p + (fs.existsSync(p) ? '  [存在]' : ''));
  }
  process.exit(1);
}

/* ================= Win32 绑定 ================= */

const kernel32 = koffi.load('kernel32.dll');

const OpenProcess = kernel32.func(
  'void* __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)'
);
const ReadProcessMemory = kernel32.func(
  'bool __stdcall ReadProcessMemory(void* h, void* addr, _Out_ uint8_t* buf, size_t size, _Out_ size_t* read)'
);
const VirtualQueryEx = kernel32.func(
  'size_t __stdcall VirtualQueryEx(void* h, void* addr, _Out_ uint8_t* mbi, size_t len)'
);
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void* h)');
const GetModuleHandleW = kernel32.func('void* __stdcall GetModuleHandleW(str16 name)');

/* ================= 进程枚举（纯 Win32，不依赖 tasklist） ================= */

const psapi = koffi.load('psapi.dll');

const EnumProcesses = psapi.func(
  'bool __stdcall EnumProcesses(_Out_ uint32_t* pProcessIds, uint32 cb, _Out_ uint32_t* pBytesReturned)'
);
const GetModuleBaseNameW = psapi.func(
  'uint32 __stdcall GetModuleBaseNameW(void* hProcess, void* hModule, _Out_ uint16_t* lpBaseName, uint32 nSize)'
);

const PROCESS_ENUM_ACCESS = 0x0410;   // QUERY_INFORMATION | VM_READ，取模块名必需

function listWeixinPids() {
  const MAX = 4096;
  const arr = Buffer.alloc(MAX * 4);
  const needed = [0];

  let ok;
  try {
    ok = EnumProcesses(arr, MAX * 4, needed);
  } catch (_) {
    return [];
  }
  if (!ok) return [];

  const count = Math.floor(needed[0] / 4);
  const out = [];
  const nameBuf = Buffer.alloc(512);

  for (let i = 0; i < count; i++) {
    const pid = arr.readUInt32LE(i * 4);
    if (pid === 0) continue;

    let h;
    try {
      h = OpenProcess(PROCESS_ENUM_ACCESS, false, pid);
    } catch (_) {
      continue;
    }
    if (!h) continue;

    try {
      const len = GetModuleBaseNameW(h, null, nameBuf, 256);
      if (len > 0) {
        const name = nameBuf.subarray(0, len * 2).toString('utf16le');
        const low = name.toLowerCase();
        if (low === 'weixin.exe' || low === 'wechat.exe') {
          out.push({ pid, name });
        }
      }
    } catch (_) {
    } finally {
      try {
        CloseHandle(h);
      } catch (_) {}
    }
  }
  return out;
}

/* ================= 内存读取 ================= */

class MemReader {
  constructor(pid) {
    this.pid = pid;
    this.handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
    if (!this.handle) {
      throw new Error(
        `OpenProcess 失败 (PID=${pid})。请以管理员身份运行。`
      );
    }
  }

  read(addr, size) {
    if (size <= 0) return null;
    const buf = Buffer.alloc(size);
    const readSize = [0];
    let ok;
    try {
      ok = ReadProcessMemory(this.handle, addr, buf, size, readSize);
    } catch (e) {
      return null;
    }
    if (!ok || readSize[0] === 0) return null;
    return readSize[0] === size ? buf : buf.subarray(0, readSize[0]);
  }

  /** 枚举可读内存区（含只读标记） */
  regions() {
    const out = [];
    // MEMORY_BASIC_INFORMATION64 = 48 字节
    const MBI_SIZE = 48;
    const mbi = Buffer.alloc(MBI_SIZE);
    let addr = 0n;

    while (addr < MAX_USER_ADDR) {
      mbi.fill(0);
      const n = VirtualQueryEx(this.handle, addr, mbi, MBI_SIZE);
      if (n === 0) break;

      const base = mbi.readBigUInt64LE(0);
      const regionSize = mbi.readBigUInt64LE(24);
      const state = mbi.readUInt32LE(32);
      const protect = mbi.readUInt32LE(36);

      if (regionSize === 0n) break;

      const prot = protect & 0xff;
      if (
        state === MEM_COMMIT &&
        PAGE_READABLE.has(prot) &&
        !(protect & PAGE_GUARD) &&
        regionSize > 0n &&
        regionSize <= 256n * 1024n * 1024n
      ) {
        out.push({
          base,
          size: Number(regionSize),
          isReadOnly: prot === 0x02,
        });
      }

      addr = base + regionSize;
      if (addr <= base) break;
    }
    return out;
  }

  close() {
    if (this.handle) {
      CloseHandle(this.handle);
      this.handle = null;
    }
  }
}

/* ================= 数据库 ================= */

function collectDbs() {
  const home = process.env.USERPROFILE || '';
  const root = path.join(home, 'Documents', 'xwechat_files');
  const out = [];
  if (!fs.existsSync(root)) return out;

  for (const name of fs.readdirSync(root).sort()) {
    const ds = path.join(root, name, 'db_storage');
    if (!fs.existsSync(ds)) continue;
    for (const sub of fs.readdirSync(ds).sort()) {
      const p = path.join(ds, sub);
      let st;
      try {
        st = fs.statSync(p);
      } catch (_) {
        continue;
      }
      if (!st.isDirectory()) continue;
      for (const fn of fs.readdirSync(p).sort()) {
        if (!fn.endsWith('.db')) continue;
        const fp = path.join(p, fn);
        let page1;
        try {
          const fd = fs.openSync(fp, 'r');
          page1 = Buffer.alloc(PAGE_SZ);
          fs.readSync(fd, page1, 0, PAGE_SZ, 0);
          fs.closeSync(fd);
        } catch (_) {
          continue;
        }
        if (page1.length < PAGE_SZ) continue;
        if (page1.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'latin1'))) continue;
        out.push({
          rel: sub + '/' + fn,
          salt: page1.subarray(0, SALT_SZ),
          page1,
        });
      }
    }
  }
  return out;
}

/* ================= 验证 ================= */

function makeVerifier(dbs) {
  const pgno = Buffer.alloc(4);
  pgno.writeUInt32LE(1, 0);

  const prepared = dbs.map((d) => {
    const macSalt = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) macSalt[i] = d.salt[i] ^ 0x3a;
    return {
      rel: d.rel,
      macSalt,
      data: d.page1.subarray(SALT_SZ, PAGE_SZ - 80 + 16),
      hmac: d.page1.subarray(PAGE_SZ - 64, PAGE_SZ),
    };
  });

  return function verify(encKey) {
    const hits = [];
    for (const p of prepared) {
      const macKey = crypto.pbkdf2Sync(encKey, p.macSalt, 2, 32, 'sha512');
      const h = crypto.createHmac('sha512', macKey);
      h.update(p.data);
      h.update(pgno);
      if (h.digest().equals(p.hmac)) hits.push(p.rel);
    }
    return hits;
  };
}

/* ================= 候选提取 ================= */

function xorRepeat(data, shift = 0) {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data[i] ^ XOR_MASK[(i + shift) % XOR_MASK.length];
  }
  return out;
}

function parseLiterals(buf) {
  const out = [];
  LITERAL_RE.lastIndex = 0;
  const text = buf.toString('latin1');
  let m;
  while ((m = LITERAL_RE.exec(text)) !== null) {
    const run = m[1].toLowerCase();
    const starts = [0];
    if (run.length > 96) {
      for (let s = 0; s <= run.length - 64; s += 32) starts.push(s);
      starts.push(run.length - 64);
    }
    for (const start of new Set(starts)) {
      if (start < 0 || start + 64 > run.length) continue;
      const hex = run.slice(start, start + 64);
      let key;
      try {
        key = Buffer.from(hex, 'hex');
      } catch (_) {
        continue;
      }
      if (key.length !== KEY_SZ) continue;
      if (new Set(key).size < 15) continue;
      out.push({ hex, key });
    }
  }
  return out;
}

/* ================= 扫描 ================= */

async function scan(pid, opts) {
  const dbs = collectDbs();
  if (!dbs.length) {
    console.log('[错误] 未找到加密数据库');
    return null;
  }
  console.log(`[*] 数据库 ${dbs.length} 个`);
  const verify = makeVerifier(dbs);

  let reader;
  try {
    reader = new MemReader(pid);
  } catch (e) {
    console.log('[错误] ' + e.message);
    return null;
  }

  try {
    const regions = reader.regions();
    const totalMB = regions.reduce((s, r) => s + r.size, 0) / 1024 / 1024;
    const roMB = regions.filter((r) => r.isReadOnly).reduce((s, r) => s + r.size, 0) / 1024 / 1024;
    console.log(`[*] 内存区 ${regions.length} 个 / ${totalMB.toFixed(0)} MB（只读段 ${roMB.toFixed(0)} MB）`);

    const limit = Math.min(opts.maxMB * 1024 * 1024, Math.floor(totalMB * 1024 * 1024));
    console.log(`[*] 扫描上限 ${(limit / 1024 / 1024).toFixed(0)} MB\n`);

    const CH = 2 * 1024 * 1024;
    let scanned = 0;
    let hitPlain = 0;
    let hitXor = 0;
    const seen = new Set();
    const verified = {};   // rel -> keyHex
    const wanted = new Set(dbs.map((d) => d.rel));

    for (const r of regions) {
      if (scanned >= limit) break;
      if (verified.size >= wanted.size) break;

      let off = 0;
      while (off < r.size) {
        if (scanned >= limit) break;
        const remain = limit - scanned;
        const n = Math.min(CH, r.size - off, remain);
        if (n <= 0) break;

        const addr = r.base + BigInt(off);
        const chunk = reader.read(addr, n);
        if (!chunk) {
          off += n;
          continue;
        }
        scanned += n;

        // A. 明文 x'
        let p = chunk.indexOf(SIG_PLAIN);
        while (p >= 0) {
          hitPlain++;
          const s = Math.max(0, p - 64);
          const w = reader.read(addr + BigInt(s), Math.min(768, chunk.length - s));
          if (w) {
            for (const c of parseLiterals(w)) {
              if (seen.has(c.hex)) continue;
              seen.add(c.hex);
              const hits = verify(c.key);
              for (const rel of hits) {
                if (!verified[rel]) {
                  verified[rel] = c.hex;
                  console.log(`  ✅ ${rel}`);
                  console.log(`     key = ${c.hex}`);
                }
              }
            }
          }
          p = chunk.indexOf(SIG_PLAIN, p + 1);
        }

        // B. XOR aa e0
        p = chunk.indexOf(SIG_XOR);
        while (p >= 0) {
          hitXor++;
          const s = Math.max(0, p - 64);
          const w = reader.read(addr + BigInt(s), Math.min(768, chunk.length - s));
          if (w) {
            for (let shift = 0; shift < 4; shift++) {
              const dec = xorRepeat(w, shift);
              for (const c of parseLiterals(dec)) {
                if (seen.has(c.hex)) continue;
                seen.add(c.hex);
                const hits = verify(c.key);
                for (const rel of hits) {
                  if (!verified[rel]) {
                    verified[rel] = c.hex;
                    console.log(`  ✅ ${rel}`);
                    console.log(`     key = ${c.hex}`);
                  }
                }
              }
            }
          }
          p = chunk.indexOf(SIG_XOR, p + 1);
        }

        off += n;
      }

      if (scanned % (200 * 1024 * 1024) < CH) {
        console.log(
          `  [进度] ${(scanned / 1024 / 1024).toFixed(0)} MB, ` +
          `明文 ${hitPlain}, XOR ${hitXor}, ` +
          `已解开 ${Object.keys(verified).length}/${wanted.size}`
        );
      }
    }

    console.log('');
    console.log('='.repeat(60));
    console.log(`扫描 ${(scanned / 1024 / 1024).toFixed(0)} MB`);
    console.log(`明文命中 ${hitPlain} / XOR 命中 ${hitXor}`);
    console.log(`已解开 ${Object.keys(verified).length}/${wanted.size}`);

    if (Object.keys(verified).length === 0) {
      console.log('');
      console.log('❌ 未提取到密钥');
      console.log('可能原因：');
      console.log('  - 微信未登录（密钥未加载）');
      console.log('  - 密钥已从内存清除，需用 --restart 在启动瞬间抓取');
      return null;
    }

    // 组装结果：每个库映射到对应密钥
    const result = {};
    for (const d of dbs) {
      if (verified[d.rel]) {
        result[d.rel] = {
          enc_key: verified[d.rel],
          salt: d.salt.toString('hex'),
          by: 'node_scan',
        };
      }
    }
    console.log('');
    console.log(`✅ 成功 ${Object.keys(result).length} 个库`);
    return result;
  } finally {
    reader.close();
  }
}

/* ================= 重启抓取 ================= */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function restartAndScan(opts) {
  const WEIXIN = opts.exe;
  console.log('[*] 关闭微信…');
  await new Promise((resolve) => {
    execFile('taskkill', ['/IM', 'Weixin.exe', '/F'],
      { windowsHide: true, timeout: 15000 }, () => resolve());
  });
  await sleep(2000);

  console.log(`[*] 启动: ${WEIXIN}`);
  const { spawn } = require('child_process');
  try {
    spawn(WEIXIN, [], {
      cwd: path.dirname(WEIXIN),
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch (e) {
    console.log('[错误] 启动失败: ' + e.message);
    return null;
  }

  console.log('[*] 等待进程出现…');
  let pid = null;
  for (let i = 0; i < 150; i++) {
    const ps = listWeixinPids();
    if (ps.length) {
      pid = ps[0].pid;
      console.log(`[+] PID=${pid} (${(ps[0].memKB / 1024).toFixed(0)} MB)`);
      break;
    }
    await sleep(200);
  }
  if (!pid) {
    console.log('[错误] 微信未能启动');
    return null;
  }

  console.log('');
  console.log('='.repeat(60));
  console.log('  请在微信窗口扫码登录');
  console.log('  登录后脚本会自动开始扫描');
  console.log('='.repeat(60));

  // 等内存涨到 200MB 以上（表示已登录）
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const ps = listWeixinPids();
    if (ps.length && ps[0].memKB > 200 * 1024) {
      console.log(`[+] 内存 ${(ps[0].memKB / 1024).toFixed(0)} MB，开始扫描`);
      break;
    }
    await sleep(1000);
  }

  // 多轮扫描
  const all = {};
  const deadline = Date.now() + (opts.duration || 120) * 1000;
  let round = 0;
  while (Date.now() < deadline) {
    round++;
    const ps = listWeixinPids();
    if (!ps.length) {
      await sleep(1000);
      continue;
    }
    console.log(`\n[*] 第 ${round} 轮 (PID=${ps[0].pid})`);
    const r = await scan(ps[0].pid, opts);
    if (r) {
      Object.assign(all, r);
      if (Object.keys(all).length >= 20) break;
    }
    await sleep(2000);
  }
  return all;
}

/* ================= 微信安装路径 ================= */

/**
 * 自动查找 Weixin.exe：
 *   1. 注册表 HKCU\SOFTWARE\Tencent\Weixin\InstallPath
 *   2. 常见安装位置
 *   3. 已运行进程的路径
 */
function findWeixinExe() {
  const candidates = [];

  // 1. 注册表
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\SOFTWARE\\Tencent\\Weixin', '/v', 'InstallPath'],
      { encoding: 'utf8', timeout: 5000, windowsHide: true }
    );
    const m = out.match(/InstallPath\s+REG_SZ\s+(.+)/i);
    if (m) {
      const dir = m[1].trim();
      candidates.push(path.join(dir, 'Weixin.exe'));
      candidates.push(path.join(dir, 'WeChat.exe'));
    }
  } catch (_) {}

  // 2. 常见位置（环境变量优先，硬编码仅作兜底默认值）
  //    这些是 Windows 标准安装目录，不是本机特有路径
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env['LOCALAPPDATA'] || '';
  for (const base of [pf, pf86, local]) {
    if (!base) continue;
    for (const sub of ['Tencent\\Weixin', 'Tencent\\WeChat']) {
      candidates.push(path.join(base, sub, 'Weixin.exe'));
      candidates.push(path.join(base, sub, 'WeChat.exe'));
    }
  }

  // 3. 已运行进程
  try {
    const procs = listWeixinPids();
    if (procs.length) {
      const koffiTmp = koffi;
      // 通过 GetModuleFileNameEx 拿路径（简化：跳过，用 tasklist 兜底）
    }
  } catch (_) {}

  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/* ================= 主入口 ================= */

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };

  const exeArg = getArg('--exe', null);
  let exe = exeArg;
  if (!exe) {
    exe = findWeixinExe();
    if (!exe) {
      console.log('[错误] 找不到 Weixin.exe');
      console.log('请用 --exe 指定，例如：');
      console.log('  node extract_key.js --exe "<微信安装目录>\\Weixin.exe"');
      process.exit(1);
    }
    console.log(`[*] 自动找到微信: ${exe}`);
  }

  const opts = {
    restart: args.includes('--restart'),
    maxMB: parseInt(getArg('--max-mb', '2000'), 10),
    duration: parseInt(getArg('--duration', '120'), 10),
    exe,
    out: getArg('--out', 'all_keys.json'),
  };

  console.log('=== 微信密钥提取（Node）===\n');

  let result;
  if (opts.restart) {
    result = await restartAndScan(opts);
  } else {
    const ps = listWeixinPids();
    if (!ps.length) {
      console.log('[错误] Weixin.exe 未运行');
      console.log('提示：加 --restart 让它自动重启并抓取');
      process.exit(1);
    }
    const pid = ps[0].pid;
    console.log(`[*] Weixin.exe PID=${pid} (${(ps[0].memKB / 1024).toFixed(0)} MB)`);
    result = await scan(pid, opts);
  }

  if (result && Object.keys(result).length) {
    // 合并到已有文件
    const rootDir = path.resolve(__dirname, '..', '..');
    const kf = path.join(rootDir, opts.out);
    let existing = {};
    if (fs.existsSync(kf)) {
      try {
        existing = JSON.parse(fs.readFileSync(kf, 'utf8'));
      } catch (_) {}
    }
    Object.assign(existing, result);
    fs.writeFileSync(kf, JSON.stringify(existing, null, 2), 'utf8');
    console.log('');
    console.log(`已合并到 ${kf}（共 ${Object.keys(existing).length} 个）`);
    console.log('');
    console.log('下一步: node wxextract/tools/apply_keys.js');
    process.exit(0);
  }

  process.exit(1);
}

main().catch((e) => {
  console.error('[异常]', e.message);
  process.exit(1);
});
