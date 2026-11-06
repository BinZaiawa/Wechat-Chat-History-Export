'use strict';
/**
 * Cross-validation (pure Node)
 *
 * Verify SQLCipher4 correctness with two independent implementations:
 *   A: implementation inside this script
 *   B: lib/sqlcipher.js (production engine)
 *
 * Page layout (SQLCipher4, reserve fixed at 80):
 *   [0:16]      salt (page 1 only)
 *   [16:4016)   ciphertext
 *   [4016:4032) IV
 *   [4032:4096) HMAC-SHA512
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const sc = require('../lib/sqlcipher');

const PAGE = 4096;
const SALT = 16;
const RESERVE = 80;
const IV_OFF = PAGE - RESERVE;   // 4016
const HMAC_OFF = PAGE - 64;      // 4032

/* ---------- Implementation A ---------- */
const A = {
  enc(key, iv, data) {
    const c = crypto.createCipheriv('aes-256-cbc', key, iv);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
  },
  dec(key, iv, data) {
    const d = crypto.createDecipheriv('aes-256-cbc', key, iv);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(data), d.final()]);
  },
  macKey(encKey, salt) {
    const ms = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) ms[i] = salt[i] ^ 0x3a;
    return crypto.pbkdf2Sync(encKey, ms, 2, 32, 'sha512');
  },
  encryptDb(raw, encKey) {
    const pages = Math.ceil(raw.length / PAGE);
    const salt = crypto.randomBytes(SALT);
    const mk = A.macKey(encKey, salt);
    const out = [];
    for (let pg = 1; pg <= pages; pg++) {
      const plain = Buffer.alloc(PAGE);
      raw.copy(plain, 0, (pg - 1) * PAGE, Math.min(pg * PAGE, raw.length));
      const iv = crypto.randomBytes(16);
      const page = Buffer.alloc(PAGE);
      if (pg === 1) {
        salt.copy(page, 0);
        A.enc(encKey, iv, plain.subarray(16, IV_OFF)).copy(page, 16);
      } else {
        A.enc(encKey, iv, plain.subarray(0, IV_OFF)).copy(page, 0);
      }
      iv.copy(page, IV_OFF);
      const h = crypto.createHmac('sha512', mk);
      h.update(page.subarray(16, HMAC_OFF));
      const pb = Buffer.alloc(4); pb.writeUInt32LE(pg, 0); h.update(pb);
      h.digest().copy(page, HMAC_OFF);
      out.push(page);
    }
    return Buffer.concat(out);
  },
  decryptDb(buf, encKey) {
    const pages = Math.ceil(buf.length / PAGE);
    const salt = buf.subarray(0, SALT);
    const mk = A.macKey(encKey, salt);
    const out = [];
    for (let pg = 1; pg <= pages; pg++) {
      const page = buf.subarray((pg - 1) * PAGE, pg * PAGE);
      const h = crypto.createHmac('sha512', mk);
      h.update(page.subarray(16, HMAC_OFF));
      const pb = Buffer.alloc(4); pb.writeUInt32LE(pg, 0); h.update(pb);
      if (!crypto.timingSafeEqual(h.digest(), page.subarray(HMAC_OFF, PAGE))) {
        throw new Error('A HMAC verify failed @page ' + pg);
      }
      const iv = page.subarray(IV_OFF, IV_OFF + 16);
      if (pg === 1) {
        const head = Buffer.from('SQLite format 3\0', 'latin1');
        const body = A.dec(encKey, iv, page.subarray(16, IV_OFF));
        out.push(Buffer.concat([head, body, Buffer.alloc(RESERVE)]));
      } else {
        out.push(Buffer.concat([A.dec(encKey, iv, page.subarray(0, IV_OFF)), Buffer.alloc(RESERVE)]));
      }
    }
    return Buffer.concat(out);
  },
};

/* ---------- helpers ---------- */
function makePlainDb(file) {
  try { fs.unlinkSync(file); } catch (_) {}
  const db = new DatabaseSync(file);
  db.exec('PRAGMA page_size=4096');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, val TEXT)');
  const ins = db.prepare('INSERT INTO t(name,val) VALUES(?,?)');
  for (let i = 0; i < 300; i++) {
    ins.run('name' + i, 'val-' + i + '-chinese-test-' + 'x'.repeat(40));
  }
  db.exec('CREATE TABLE u(a TEXT)');
  db.prepare('INSERT INTO u VALUES(?)').run('hello world');
  db.close();
}

function readAll(file, sql) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

/* ---------- main ---------- */
function main() {
  const dir = path.join(process.cwd(), '_xcheck');
  fs.mkdirSync(dir, { recursive: true });
  const plain = path.join(dir, 'plain.db');
  const encA = path.join(dir, 'encA.db');
  const decB = path.join(dir, 'decB.db');
  const decA = path.join(dir, 'decA.db');
  let ok = false;

  try {
    console.log('== 1. build plain db');
    makePlainDb(plain);
    const plainRows = readAll(plain, 'SELECT COUNT(*) c FROM t')[0].c;
    console.log('   size:', fs.statSync(plain).size, '| rows:', plainRows);

    const key = crypto.randomBytes(32);

    console.log('== 2. A encrypt -> B decrypt');
    const rawPlain = fs.readFileSync(plain);
    const encBuf = A.encryptDb(rawPlain, key);
    fs.writeFileSync(encA, encBuf);
    console.log('   header not plaintext:', !encBuf.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'latin1')));
    sc.decryptDatabase(encA, decB, key, { verify: true, reserve: RESERVE });
    const decBBuf = fs.readFileSync(decB);

    console.log('== 3. A decrypt same ciphertext');
    const decABuf = A.decryptDb(encBuf, key);
    fs.writeFileSync(decA, decABuf);

    console.log('== 4. byte-compare: A vs B output, and vs original plain');
    const identical = decBBuf.equals(decABuf);
    console.log('   A/B identical:', identical);

    // 与原始明文比对：除每页末 80 字节（reserve 区）外必须完全一致
    const pages = Math.ceil(rawPlain.length / PAGE);
    let bodyMismatch = 0;
    let tailNonZero = 0;
    for (let pg = 1; pg <= pages; pg++) {
      const base = (pg - 1) * PAGE;
      // 正文区 [0,4016)
      for (let i = 0; i < IV_OFF; i++) {
        if (decBBuf[base + i] !== rawPlain[base + i]) bodyMismatch++;
      }
      // 保留区 [4016,4096) 应全 0
      for (let i = IV_OFF; i < PAGE; i++) {
        if (decBBuf[base + i] !== 0) tailNonZero++;
      }
    }
    console.log('   body mismatched bytes:', bodyMismatch, '| tail non-zero bytes:', tailNonZero);

    console.log('== 5. wrong key must be rejected');
    let rejected = false;
    try {
      sc.decryptDatabase(encA, path.join(dir, 'bad.db'), crypto.randomBytes(32), { verify: true, reserve: RESERVE });
    } catch (e) {
      rejected = true;
      console.log('   OK rejected:', e.message);
    }

    console.log('== 6. page1 header sanity');
    const p1 = decBBuf.subarray(0, 24);
    console.log('   magic:', p1.subarray(0, 16).toString('latin1') === 'SQLite format 3\0');
    console.log('   page_size:', p1.readUInt16BE(16), '| pagecount:', decBBuf.readUInt32BE(28));

    ok = identical && bodyMismatch === 0 && tailNonZero === 0 && rejected
      && decBBuf.subarray(0, 16).toString('latin1') === 'SQLite format 3\0';
  } catch (e) {
    console.log('FAIL:', e.message);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('');
  console.log(ok
    ? 'PASS: two independent implementations agree byte-for-byte'
    : 'FAIL: cross-validation did not pass');
  process.exit(ok ? 0 : 1);
}

main();
