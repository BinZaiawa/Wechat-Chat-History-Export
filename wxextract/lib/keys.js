'use strict';
/**
 * 密钥提取模块
 *
 * 三条路径：
 *  A. 内存扫描 x'<64hex_key><32hex_salt>'   —— 适用于微信 4.0.x ~ 4.1.9.x
 *  B. passphrase + PBKDF2 派生              —— 适用于 4.1.10+（需先用 Frida 拿到 passphrase）
 *  C. 手动粘贴密钥                          —— 通用兜底
 *
 * 本模块只做只读扫描，不修改微信进程。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { deriveEncKey, verifyPage1, readPage1, getSalt, SALT_LEN } = require('./sqlcipher');

const PS_SCAN = String.raw`
$ErrorActionPreference = 'Stop'
$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WXMem {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool VirtualQueryEx(IntPtr h, IntPtr addr, ref MBI mbi, IntPtr len);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)]
  public struct MBI {
    public IntPtr BaseAddress;
    public IntPtr AllocationBase;
    public uint AllocationProtect;
    public uint _pad1;
    public IntPtr RegionSize;
    public uint State;
    public uint Protect;
    public uint Type;
    public uint _pad2;
  }
  public static List<object[]> Regions(IntPtr h) {
    var list = new List<object[]>();
    long addr = 0;
    var mbi = new MBI();
    int sz = Marshal.SizeOf(typeof(MBI));
    while (addr < 0x7FFFFFFFFFFF) {
      if (!VirtualQueryEx(h, (IntPtr)addr, ref mbi, (IntPtr)sz)) break;
      long rs = (long)mbi.RegionSize;
      uint st = mbi.State, pr = mbi.Protect;
      bool readable = (pr & 0x02)!=0 || (pr & 0x04)!=0 || (pr & 0x08)!=0 || (pr & 0x10)!=0 || (pr & 0x20)!=0 || (pr & 0x40)!=0 || (pr & 0x80)!=0;
      if (st == 0x1000 && readable && rs > 0 && rs < 500L*1024*1024) {
        list.Add(new object[] { (long)mbi.BaseAddress, rs });
      }
      long next = (long)mbi.BaseAddress + rs;
      if (next <= addr) break;
      addr = next;
    }
    return list;
  }
}
'@
Add-Type -TypeDefinition $code -ErrorAction Stop

$pat = [regex]::new("x'([0-9a-fA-F]{64,192})'")
$targetPid = [int]$env:WX_TARGET_PID
$outFile = $env:WX_OUT_FILE
$s = New-Object System.IO.StreamWriter($outFile, $false, [Text.Encoding]::UTF8)

$h = [WXMem]::OpenProcess(0x0410, $false, $targetPid)
if ($h -eq [IntPtr]::Zero) { $s.WriteLine("ERR:OpenProcess failed"); $s.Close(); exit 2 }

$regions = [WXMem]::Regions($h)
$s.WriteLine("REGIONS:" + $regions.Count)
$total = 0L
foreach ($r in $regions) { $total += [long]$r[1] }
$s.WriteLine("TOTALMB:" + [int]($total/1MB))

$found = 0
foreach ($r in $regions) {
  $base = [long]$r[0]; $size = [long]$r[1]
  if ($size -gt 64MB) { continue }
  $buf = New-Object byte[] $size
  $n = [IntPtr]::Zero
  if (-not [WXMem]::ReadProcessMemory($h, [IntPtr]$base, $buf, [IntPtr]$size, [ref]$n)) { continue }
  $read = [int]$n
  if ($read -le 0) { continue }
  $text = [Text.Encoding]::Latin1.GetString($buf, 0, $read)
  foreach ($m in $pat.Matches($text)) {
    $hex = $m.Groups[1].Value
    $addr = $base + $m.Index
    $s.WriteLine("HEX:" + $hex + "|" + ("0x" + $addr.ToString("X")))
    $found++
  }
}
$s.WriteLine("DONE:" + $found)
$s.Close()
[WXMem]::CloseHandle($h) | Out-Null
`;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 找出微信主进程 PID（Weixin.exe / WeChat.exe） */
function findWeChatPids() {
  const names = ['Weixin', 'WeChat'];
  const result = [];
  let procs = [];
  try {
    procs = require('child_process')
      .execFileSync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        "Get-Process | Where-Object {$_.ProcessName -in @('Weixin','WeChat')} | ForEach-Object { \"$($_.Id)|$($_.ProcessName)|$([int]($_.WorkingSet64/1MB))\" }",
      ], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (_) {
    procs = [];
  }
  for (const line of procs) {
    const [pid, name, mb] = line.split('|');
    if (pid) result.push({ pid: +pid, name, memMB: +mb || 0 });
  }
  return result.sort((a, b) => b.memMB - a.memMB);
}

/**
 * 扫描指定进程内存，返回 hex 候选列表
 * @returns {{ok:boolean, regions:number, totalMB:number, candidates:Array<{hex:string,addr:string}>, err?:string}}
 */
function scanProcessMemory(pid, opts = {}) {
  const tmp = path.join(require('os').tmpdir(), `wxscan-${stamp()}-${Math.random().toString(36).slice(2, 8)}.txt`);
  const psFile = path.join(require('os').tmpdir(), `wxscan-${Date.now()}.ps1`);
  fs.writeFileSync(psFile, '\ufeff' + PS_SCAN, 'utf8'); // 带 BOM，避免中文乱码

  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: opts.timeout || 300000,
      env: { ...process.env, WX_TARGET_PID: String(pid), WX_OUT_FILE: tmp },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    // 非 0 退出也要尝试读结果
    if (!fs.existsSync(tmp)) {
      return { ok: false, regions: 0, totalMB: 0, candidates: [], err: '内存扫描失败: ' + e.message };
    }
  }

  let text = '';
  try {
    text = fs.readFileSync(tmp, 'utf8');
  } catch (e) {
    return { ok: false, regions: 0, totalMB: 0, candidates: [], err: '无法读取扫描结果: ' + e.message };
  } finally {
    try { fs.unlinkSync(psFile); } catch (_) {}
  }

  const candidates = [];
  let regions = 0;
  let totalMB = 0;
  let err = '';
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('REGIONS:')) regions = +line.slice(8);
    else if (line.startsWith('TOTALMB:')) totalMB = +line.slice(8);
    else if (line.startsWith('HEX:')) {
      const [hex, addr] = line.slice(4).split('|');
      if (hex) candidates.push({ hex, addr });
    } else if (line.startsWith('ERR:')) err = line.slice(4);
  }
  try { fs.unlinkSync(tmp); } catch (_) {}

  return { ok: !err, regions, totalMB, candidates, err };
}

/**
 * 用候选 hex 匹配所有数据库
 * 支持两种形态：
 *   96 hex = encKey(64) + salt(32)
 *   64 hex = encKey(64)，需逐库 HMAC 验证
 * @param {Array<{hex,addr}>} candidates
 * @param {Array<{rel,path,page1,saltHex}>} dbs
 */
function matchKeys(candidates, dbs) {
  const saltMap = new Map();
  for (const db of dbs) {
    if (!saltMap.has(db.saltHex)) saltMap.set(db.saltHex, []);
    saltMap.get(db.saltHex).push(db);
  }
  const found = new Map(); // saltHex -> {encKeyHex, addr, by}

  for (const c of candidates) {
    const hex = c.hex;
    if (hex.length === 96) {
      const encKeyHex = hex.slice(0, 64);
      const saltHex = hex.slice(64);
      if (!saltMap.has(saltHex) || found.has(saltHex)) continue;
      const encKey = Buffer.from(encKeyHex, 'hex');
      const dbsForSalt = saltMap.get(saltHex);
      if (verifyPage1(encKey, dbsForSalt[0].page1)) {
        found.set(saltHex, { encKeyHex, addr: c.addr, by: 'pair' });
      }
    } else if (hex.length === 64) {
      const encKey = Buffer.from(hex, 'hex');
      for (const [saltHex, list] of saltMap) {
        if (found.has(saltHex)) continue;
        if (verifyPage1(encKey, list[0].page1)) {
          found.set(saltHex, { encKeyHex: hex, addr: c.addr, by: 'brute' });
          break;
        }
      }
    } else if (hex.length > 96 && hex.length % 2 === 0) {
      const encKeyHex = hex.slice(0, 64);
      const saltHex = hex.slice(-32);
      if (!saltMap.has(saltHex) || found.has(saltHex)) continue;
      const encKey = Buffer.from(encKeyHex, 'hex');
      if (verifyPage1(encKey, saltMap.get(saltHex)[0].page1)) {
        found.set(saltHex, { encKeyHex, addr: c.addr, by: 'long' });
      }
    }
  }

  // 输出：每个 db 的密钥
  const result = {};
  for (const db of dbs) {
    const hit = found.get(db.saltHex);
    if (hit) {
      result[db.rel] = { encKey: hit.encKeyHex, salt: db.saltHex, addr: hit.addr, by: hit.by };
    }
  }
  return { result, matchedSalts: found.size, totalSalts: saltMap.size };
}

/** 收集目录下所有 .db 的 salt 与 page1 */
function collectDbs(dbStorageDir) {
  const out = [];
  const stack = [dbStorageDir];
  let guard = 0;
  while (stack.length && guard < 50000) {
    guard++;
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.isFile()) continue;
      if (!e.name.endsWith('.db')) continue;
      if (e.name.endsWith('-wal') || e.name.endsWith('-shm')) continue;
      let page1;
      try { page1 = readPage1(full); } catch (_) { continue; }
      if (!page1) continue;
      out.push({
        rel: path.relative(dbStorageDir, full).split(path.sep).join('/'),
        path: full,
        page1,
        saltHex: page1.subarray(0, SALT_LEN).toString('hex'),
        sizeMB: +(fs.statSync(full).size / 1024 / 1024).toFixed(1),
      });
    }
  }
  out.sort((a, b) => a.rel.localeCompare(b.rel));
  return out;
}

/**
 * 从 passphrase 派生所有库的 encKey 并验证
 */
function keysFromPassphrase(passphraseHex, dbs) {
  const pass = Buffer.from(passphraseHex.replace(/\s/g, ''), 'hex');
  if (pass.length !== 32) throw new Error('passphrase 必须是 32 字节（64 个 hex 字符）');
  const result = {};
  for (const db of dbs) {
    const salt = db.page1.subarray(0, SALT_LEN);
    const encKey = deriveEncKey(pass, salt);
    if (verifyPage1(encKey, db.page1)) {
      result[db.rel] = { encKey: encKey.toString('hex'), salt: db.saltHex, by: 'pbkdf2' };
    }
  }
  return result;
}

module.exports = { findWeChatPids, scanProcessMemory, matchKeys, collectDbs, keysFromPassphrase };
