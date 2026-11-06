'use strict';
/**
 * SQLCipher 4 解密引擎（微信 4.x 专用）
 *
 * 参数（已核实，见 README 技术来源）：
 *   - 加密：AES-256-CBC
 *   - 认证：HMAC-SHA512
 *   - KDF：PBKDF2-HMAC-SHA512, 256000 iterations, dklen=32
 *   - page_size = 4096, reserve = 80 (IV 16 + HMAC 64)
 *
 * 每页布局：
 *   [0:16]      salt（仅第 1 页；其余页复用第 1 页 salt）
 *   [16:4016]   密文
 *   [4016:4032] IV
 *   [4032:4096] HMAC-SHA512
 *
 * 密钥两种来源：
 *   1) encKey（32 字节 raw key）—— 直接用于 AES
 *   2) passphrase（32 字节主密码）—— 需 PBKDF2(passphrase, salt, 256000) 派生 encKey
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PAGE = 4096;
const KEY_LEN = 32;
const SALT_LEN = 16;
const IV_OFF = 4016;
const IV_LEN = 16;
const HMAC_OFF = 4032;
const HMAC_LEN = 64;
const RESERVE = 80;
const SQLITE_HDR = Buffer.from('SQLite format 3\0', 'latin1');
const KDF_ITER = 256000;

/** PBKDF2 派生 encKey */
function deriveEncKey(passphrase, salt, iter) {
  return crypto.pbkdf2Sync(passphrase, salt, iter || KDF_ITER, KEY_LEN, 'sha512');
}

/** 派生 HMAC key（SQLCipher 标准：mac_salt = salt ^ 0x3a，迭代 2 次） */
function deriveMacKey(encKey, salt) {
  const macSalt = Buffer.alloc(salt.length);
  for (let i = 0; i < salt.length; i++) macSalt[i] = salt[i] ^ 0x3a;
  return crypto.pbkdf2Sync(encKey, macSalt, 2, KEY_LEN, 'sha512');
}

/** 校验 page1 的 HMAC，验证 encKey 是否正确
 * HMAC 覆盖范围：[16, PAGE - HMAC_LEN) —— 恒定，与 reserve 无关。
 * （reserve=80 时即 [16,4032)；reserve=0 时即 [16,4032) 同样成立，
 *   因为 SQLCipher 的 HMAC 区固定在页末 64 字节）
 */
function verifyPage1(encKey, page1, reserve) {
  if (!page1 || page1.length < PAGE) return false;
  const salt = page1.subarray(0, SALT_LEN);
  const macKey = deriveMacKey(encKey, salt);
  const hmacData = page1.subarray(SALT_LEN, PAGE - HMAC_LEN);
  const stored = page1.subarray(PAGE - HMAC_LEN, PAGE);
  const h = crypto.createHmac('sha512', macKey);
  h.update(hmacData);
  const pgno = Buffer.alloc(4);
  pgno.writeUInt32LE(1, 0);
  h.update(pgno);
  const calc = h.digest();
  return calc.length === stored.length && crypto.timingSafeEqual(calc, stored);
}

/** 解密单页
 * @param {Buffer} encKey 32字节密钥
 * @param {Buffer} pageBuf 4096 加密页
 * @param {number} pgno 页号（1 起）
 * @param {number} reserve 保留区大小（微信=80）
 */
function decryptPage(encKey, pageBuf, pgno, reserve) {
  const RES = reserve === undefined ? RESERVE : reserve;
  const ivOff = PAGE - RES;
  const iv = pageBuf.subarray(ivOff, ivOff + IV_LEN);
  const decipher = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
  decipher.setAutoPadding(false);

  if (pgno === 1) {
    // 第 1 页：[0:16] salt，[16:ivOff) 密文
    const enc = pageBuf.subarray(SALT_LEN, ivOff);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    // 头 16 字节为标准 SQLite magic；[16:ivOff) 原样；末尾补回保留区
    // 注意：reserved bytes 字段（offset 20）已在 dec 内，无需改写
    return Buffer.concat([SQLITE_HDR, dec, Buffer.alloc(RES)]);
  }
  const enc = pageBuf.subarray(0, ivOff);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return Buffer.concat([dec, Buffer.alloc(RES)]);
}

/**
 * 读取数据库第 1 页（共享读，微信运行中也能读）
 */
function readPage1(dbPath) {
  const fd = fs.openSync(dbPath, 'r');
  try {
    const buf = Buffer.alloc(PAGE);
    const n = fs.readSync(fd, buf, 0, PAGE, 0);
    return n === PAGE ? buf : null;
  } finally {
    fs.closeSync(fd);
  }
}

/** 数据库是否已加密（非明文 SQLite） */
function isEncrypted(dbPath) {
  const p1 = readPage1(dbPath);
  if (!p1) return false;
  return !p1.subarray(0, 16).equals(SQLITE_HDR);
}

/** 取数据库 salt */
function getSalt(dbPath) {
  const p1 = readPage1(dbPath);
  return p1 ? p1.subarray(0, SALT_LEN) : null;
}

/**
 * 解密整个数据库
 * @param {string} dbPath 源库
 * @param {string} outPath 输出库
 * @param {Buffer} encKey 32字节密钥
 * @param {object} opts { verify:boolean, onProgress:fn }
 */
function decryptDatabase(dbPath, outPath, encKey, opts = {}) {
  const size = fs.statSync(dbPath).size;
  const totalPages = Math.ceil(size / PAGE);
  if (totalPages < 1) throw new Error('数据库文件为空');
  const reserve = opts.reserve === undefined ? RESERVE : opts.reserve;

  const p1 = readPage1(dbPath);
  if (!p1) throw new Error('无法读取第 1 页');

  if (opts.verify !== false) {
    if (!verifyPage1(encKey, p1, reserve)) {
      throw new Error('密钥校验失败（HMAC 不匹配）：密钥错误或该库不属于此密钥');
    }
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const fdIn = fs.openSync(dbPath, 'r');
  const fdOut = fs.openSync(outPath, 'w');
  try {
    const buf = Buffer.alloc(PAGE);
    for (let pgno = 1; pgno <= totalPages; pgno++) {
      const n = fs.readSync(fdIn, buf, 0, PAGE, (pgno - 1) * PAGE);
      if (n === 0) break;
      let page;
      if (n < PAGE) {
        // 末尾不完整页：补零
        const tail = Buffer.alloc(PAGE);
        buf.copy(tail, 0, 0, n);
        page = tail;
      } else {
        page = buf;
      }
      const dec = decryptPage(encKey, page, pgno, reserve);
      fs.writeSync(fdOut, dec, 0, dec.length);
      if (opts.onProgress && pgno % 2000 === 0) {
        opts.onProgress(pgno, totalPages);
      }
    }
  } finally {
    fs.closeSync(fdIn);
    fs.closeSync(fdOut);
  }
  return outPath;
}

/**
 * 解密 WAL 文件并合并到已解密的库
 * WAL 帧格式：pgno(4,BE) + unk(4,BE) + salt(16) + page(4096)
 * 解密用主库 encKey，IV = 页[4016:4032]，密文范围 [0:4016]
 * 帧 salt 用于密钥轮换检测，与主库 salt 不一致的帧跳过（旧周期残留）
 */
function mergeWal(walPath, decryptedDbPath, encKey, reserve) {
  const RES = reserve === undefined ? RESERVE : reserve;
  if (!fs.existsSync(walPath)) return { frames: 0, applied: 0, skipped: 0 };
  const wal = fs.readFileSync(walPath);
  const FRAME_HDR = 32;
  const FRAME_SZ = FRAME_HDR + PAGE;

  // WAL 头 32 字节
  if (wal.length < 32) return { frames: 0, applied: 0, skipped: 0 };
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) {
    return { frames: 0, applied: 0, skipped: 0, note: '非标准 WAL 头' };
  }
  const walSalt1 = wal.readUInt32BE(16);
  const walSalt2 = wal.readUInt32BE(20);

  const frameCount = Math.floor((wal.length - 32) / FRAME_SZ);
  if (frameCount <= 0) return { frames: 0, applied: 0, skipped: 0 };

  const fd = fs.openSync(decryptedDbPath, 'r+');
  const dbSize = fs.fstatSync(fd).size;
  const totalPages = Math.floor(dbSize / PAGE);
  let applied = 0;
  let skipped = 0;

  try {
    for (let i = 0; i < frameCount; i++) {
      const off = 32 + i * FRAME_SZ;
      const pgno = wal.readUInt32BE(off);
      const salt1 = wal.readUInt32BE(off + 8);
      const salt2 = wal.readUInt32BE(off + 12);
      // 旧周期帧跳过
      if (salt1 !== walSalt1 || salt2 !== walSalt2) { skipped++; continue; }
      if (pgno < 1 || pgno > totalPages) { skipped++; continue; }

      const pageData = wal.subarray(off + FRAME_HDR, off + FRAME_HDR + PAGE);
      let dec;
      try {
        dec = decryptPage(encKey, pageData, pgno, RES);
      } catch (_) {
        skipped++;
        continue;
      }
      fs.writeSync(fd, dec, 0, dec.length, (pgno - 1) * PAGE);
      applied++;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { frames: frameCount, applied, skipped };
}

module.exports = {
  PAGE, KEY_LEN, SALT_LEN, KDF_ITER,
  deriveEncKey, deriveMacKey, verifyPage1, decryptPage,
  readPage1, isEncrypted, getSalt,
  decryptDatabase, mergeWal, SQLITE_HDR,
};
