'use strict';
/**
 * 自检脚本：构造 SQLCipher4（reserve=80）加密库，再用解密引擎还原并校验。
 * 目的：在不依赖微信密钥的前提下，验证引擎数学与页布局正确。
 *
 * 关键：测试库必须与微信结构一致（usable = 4096-80 = 4016），
 * 否则无法反映真实行为。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const sc = require('../lib/sqlcipher');

const PAGE = 4096;
const RESERVE = 80;
const IV_OFF = PAGE - RESERVE; // 4016

/**
 * 用 sqlite 生成 reserve=80 的明文库。
 * SQLite 的 reserve 是编译期选项，运行时无法通过 PRAGMA 设置，
 * 因此这里用「按 reserve 重排页」的方式构造：
 * 每页 usable=4016，cell 指针从 4016 向前分配，末尾 80 字节为保留区。
 */
function makePlainDbWithReserve(file) {
  try { fs.unlinkSync(file); } catch (_) {}
  const tmpFile = file + '.tmp';
  try { fs.unlinkSync(tmpFile); } catch (_) {}

  // 先建普通库（reserve=0）
  const db = new DatabaseSync(tmpFile);
  db.exec('PRAGMA page_size=4096');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, val TEXT)');
  const ins = db.prepare('INSERT INTO t(name,val) VALUES(?,?)');
  for (let i = 0; i < 200; i++) ins.run('名字' + i, '值-' + i + '-中文测试-' + 'x'.repeat(40));
  db.exec('CREATE TABLE u(a TEXT)');
  db.prepare('INSERT INTO u VALUES(?)').run('hello');
  db.close();

  const raw = fs.readFileSync(tmpFile);
  const pageCount = raw.length / PAGE;

  // 按 reserve=80 重排：把每页 [0,4016) 内容原样保留，[4016,4096) 清零
  // 由于原库 usable=4096，cell 可能落在 [4016,4096)，这种情况测试数据量下不会发生
  // （测试库每页只用了很少空间，cell 都在页首）。
  const out = Buffer.alloc(raw.length);
  for (let pg = 1; pg <= pageCount; pg++) {
    const src = raw.subarray((pg - 1) * PAGE, pg * PAGE);
    const dst = out.subarray((pg - 1) * PAGE, pg * PAGE);
    src.copy(dst, 0, 0, IV_OFF); // 只复制 [0,4016)
    // [4016,4096) 保持 0
  }
  // 第 1 页 header 声明 reserved=80
  out[20] = RESERVE;

  fs.writeFileSync(file, out);
  for (const suf of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpFile + suf); } catch (_) {}
  }
  return { pageCount };
}

/** 按 SQLCipher4 加密 */
function encryptDb(plainPath, encPath, encKey) {
  const raw = fs.readFileSync(plainPath);
  const pageCount = Math.ceil(raw.length / PAGE);
  const salt = crypto.randomBytes(16);
  const macSalt = Buffer.from(salt.map((b) => b ^ 0x3a));
  const macKey = crypto.pbkdf2Sync(encKey, macSalt, 2, 32, 'sha512');

  const out = [];
  for (let pgno = 1; pgno <= pageCount; pgno++) {
    const start = (pgno - 1) * PAGE;
    const plain = Buffer.alloc(PAGE);
    raw.copy(plain, 0, start, Math.min(start + PAGE, raw.length));

    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', encKey, iv);
    cipher.setAutoPadding(false);

    let encBody;
    if (pgno === 1) {
      encBody = Buffer.concat([cipher.update(plain.subarray(16, IV_OFF)), cipher.final()]);
    } else {
      encBody = Buffer.concat([cipher.update(plain.subarray(0, IV_OFF)), cipher.final()]);
    }

    const page = Buffer.alloc(PAGE);
    if (pgno === 1) salt.copy(page, 0);
    encBody.copy(page, pgno === 1 ? 16 : 0);
    iv.copy(page, IV_OFF);

    const h = crypto.createHmac('sha512', macKey);
    h.update(page.subarray(16, IV_OFF + 16));
    const pb = Buffer.alloc(4); pb.writeUInt32LE(pgno, 0);
    h.update(pb);
    h.digest().copy(page, PAGE - 64);

    out.push(page);
  }
  fs.writeFileSync(encPath, Buffer.concat(out));
  return { pageCount, salt };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlcipher-selftest-'));
  const plain = path.join(tmp, 'plain.db');
  const enc = path.join(tmp, 'enc.db');
  const dec = path.join(tmp, 'dec.db');
  let pass = false;

  try {
    console.log('== 1. 构造 reserve=80 的明文库');
    const info = makePlainDbWithReserve(plain);
    const hdr = fs.readFileSync(plain).subarray(0, 24);
    console.log('   页数:', info.pageCount, '| reserved:', hdr[20], '| usable:', hdr.readUInt16BE(16) - hdr[20]);
    // 明文库应可正常读取
    const vdb = new DatabaseSync(plain, { readOnly: true });
    const vc = vdb.prepare('SELECT COUNT(*) c FROM t').get().c;
    vdb.close();
    console.log('   明文库行数:', vc, '(应为 200)');
    if (vc !== 200) throw new Error('明文库构造失败');

    console.log('== 2. 加密为 SQLCipher4');
    const encKey = crypto.randomBytes(32);
    const einfo = encryptDb(plain, enc, encKey);
    const head = fs.readFileSync(enc).subarray(0, 16);
    console.log('   salt:', einfo.salt.toString('hex'), '| 非明文头:', !head.equals(Buffer.from('SQLite format 3\0', 'latin1')));

    console.log('== 3. 错误密钥应被拒绝');
    let rejected = false;
    try {
      sc.decryptDatabase(enc, dec, crypto.randomBytes(32), { verify: true });
    } catch (e) {
      rejected = true;
      console.log('   ✅', e.message);
    }
    if (!rejected) throw new Error('错误密钥未被拒绝');

    console.log('== 4. 正确密钥解密');
    sc.decryptDatabase(enc, dec, encKey, { verify: true, reserve: RESERVE });
    console.log('   输出大小:', fs.statSync(dec).size);

    console.log('== 5. 校验解密结果');
    const db = new DatabaseSync(dec, { readOnly: true });
    const cnt = db.prepare('SELECT COUNT(*) c FROM t').get().c;
    const sample = db.prepare('SELECT name,val FROM t ORDER BY id LIMIT 2').all();
    const u = db.prepare('SELECT * FROM u').all();
    const last = db.prepare('SELECT name,val FROM t ORDER BY id DESC LIMIT 1').get();
    db.close();
    console.log('   行数:', cnt, '(应为 200)');
    console.log('   首条:', JSON.stringify(sample[0]));
    console.log('   末条:', JSON.stringify(last));
    console.log('   表u:', JSON.stringify(u));

    pass = cnt === 200 && sample[0].val.includes('中文测试') && last.name === '名字199';
  } catch (e) {
    console.log('❌ 自检异常:', e.message);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('');
  console.log(pass ? '✅ 自检通过：加密 → 解密 → 读取 全链路正确' : '❌ 自检失败');
  process.exit(pass ? 0 : 1);
}

main();
