'use strict';
/**
 * HTTP 服务 + REST API
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const core = require('./core');
const exporter = require('./exporter');
const keysMod = require('./keys');

const PUBLIC = path.join(__dirname, '..', 'public');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer() {
  return http.createServer(async (req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(parsed.pathname);
    const cfg = config.load();

    try {
      /* ---------- 静态 ---------- */
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        return serveStatic(req, res, pathname);
      }

      /* ---------- API ---------- */
      if (pathname === '/api/status' && req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          busy: core.state.busy,
          task: core.state.task,
          progress: core.state.progress,
          log: core.state.log.slice(-200),
          configPath: config.CONFIG_PATH,
          config: { wechatRoot: cfg.wechatRoot, exportDir: cfg.exportDir, workDir: cfg.workDir, port: cfg.port },
          keyCount: Object.keys(cfg.keys || {}).length,
        });
      }

      if (pathname === '/api/accounts' && req.method === 'GET') {
        const accounts = core.getAccounts(cfg);
        // 附加解密状态 + 密钥覆盖情况
        for (const a of accounts) {
          const wd = core.workDirOf(cfg, a.name);
          a.decrypted = fs.existsSync(wd);
          a.keyCount = Object.keys(cfg.keys || {}).length;

          // 统计该账号下有多少库、多少有密钥
          try {
            const dbs = keysMod.collectDbs(a.dbStorage);
            a.dbTotal = dbs.length;
            const missing = dbs.filter((d) => !(cfg.keys || {})[d.rel]);
            a.dbMissing = missing.length;
            a.missingList = missing.map((d) => d.rel);
            // 只把有内容的库算进去（0 字节空库忽略）
            a.missingReal = missing.filter((d) => d.sizeMB > 0.01).map((d) => d.rel);
          } catch (_) {
            a.dbTotal = 0;
            a.dbMissing = 0;
            a.missingList = [];
            a.missingReal = [];
          }
        }
        return sendJson(res, 200, { ok: true, accounts });
      }

      if (pathname === '/api/procs' && req.method === 'GET') {
        const pids = keysMod.findWeChatPids();
        return sendJson(res, 200, { ok: true, pids });
      }

      /* 扫描密钥 */
      if (pathname === '/api/scan-keys' && req.method === 'POST') {
        const body = await readBody(req);
        const accountPath = body.accountPath;
        if (!accountPath) return sendJson(res, 400, { ok: false, err: '缺少 accountPath' });
        core.state.busy = true;
        core.setProgress(0, '扫描密钥中');
        try {
          const r = core.scanKeys(cfg, accountPath);
          return sendJson(res, 200, r);
        } finally {
          core.state.busy = false;
          core.setProgress(100, '');
        }
      }

      /* 用 passphrase 派生 */
      if (pathname === '/api/derive-keys' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.accountPath || !body.passphrase) return sendJson(res, 400, { ok: false, err: '缺少参数' });
        core.state.busy = true;
        try {
          const r = core.deriveKeysFromPassphrase(cfg, body.accountPath, body.passphrase);
          return sendJson(res, 200, r);
        } catch (e) {
          return sendJson(res, 200, { ok: false, err: e.message });
        } finally {
          core.state.busy = false;
        }
      }

      /* 手动设置密钥 */
      if (pathname === '/api/set-key' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.dbRel || !body.encKey) return sendJson(res, 400, { ok: false, err: '缺少参数' });
        const cfg2 = config.load();
        cfg2.keys = cfg2.keys || {};
        cfg2.keys[body.dbRel] = { encKey: body.encKey.replace(/\s/g, ''), by: 'manual' };
        config.save(cfg2);
        return sendJson(res, 200, { ok: true });
      }

      /* 解密 */
      if (pathname === '/api/decrypt' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.accountPath) return sendJson(res, 400, { ok: false, err: '缺少 accountPath' });
        core.state.busy = true;
        core.setProgress(0, '解密中');
        if (!core.acquire('解密中')) {
          return sendJson(res, 200, { ok: false, err: '有任务正在执行，请稍候' });
        }
        try {
          const r = core.decryptAccount(cfg, body.accountPath);
          return sendJson(res, 200, {
            ok: true,
            decrypted: r.decrypted.length,
            failed: r.failed.length,
            failedList: r.failed.slice(0, 50),
            missingKeys: r.missingKeys || [],
            realFailures: r.realFailures || [],
            outRoot: r.outRoot,
          });
        } catch (e) {
          return sendJson(res, 200, { ok: false, err: e.message });
        } finally {
          core.release();
        }
      }

      /* 会话列表 */
      if (pathname === '/api/chats' && req.method === 'GET') {
        const account = parsed.searchParams.get('account');
        if (!account) return sendJson(res, 400, { ok: false, err: '缺少 account' });
        const r = core.listChats(cfg, account);
        return sendJson(res, 200, r);
      }

      /* 头像图片 */
      if (pathname === '/api/avatar' && req.method === 'GET') {
        const account = parsed.searchParams.get('account');
        const username = parsed.searchParams.get('username');
        if (!account || !username) {
          res.writeHead(400);
          return res.end('missing params');
        }
        const buf = core.getAvatar(cfg, account, username);
        if (!buf) {
          // 无头像：返回 1x1 透明 PNG
          const px = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
            'base64'
          );
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Content-Length': px.length,
            'Cache-Control': 'public, max-age=3600',
          });
          return res.end(px);
        }
        const isPng = buf[0] === 0x89 && buf[1] === 0x50;
        const isGif = buf[0] === 0x47 && buf[1] === 0x49;
        const mime = isPng ? 'image/png' : isGif ? 'image/gif' : 'image/jpeg';
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=3600',
        });
        return res.end(buf);
      }

      /* 读取会话消息（预览，供气泡渲染） */
      if (pathname === '/api/messages' && req.method === 'POST') {
        const body = await readBody(req);
        const { account, chat, limit } = body;
        if (!account || !chat) return sendJson(res, 400, { ok: false, err: '缺少参数' });
        const r = core.readChat(cfg, account, chat, {});
        const selfWxid = guessSelf(account, r.messages);
        const total = r.messages.length;
        const lim = limit || 500;
        const slice = total > lim ? r.messages.slice(-lim) : r.messages;

        return sendJson(res, 200, {
          ok: true,
          total,
          count: slice.length,
          selfWxid,
          messages: slice.map((m, i) => {
            const isSelf = !!selfWxid && m.sender === selfWxid;
            const contact = r.contacts.get(m.sender);
            let senderName = isSelf ? '我' : '';
            if (!senderName) {
              if (contact) senderName = contact.remark || contact.nickName || m.sender;
              else senderName = m.sender || chat.name;
            }
            return {
              id: `${m.createTime}_${m.localId}`,
              localId: m.localId,
              time: exporter.fmtTime(m.createTime),
              timeShort: exporter.fmtTime(m.createTime, 'time'),
              date: exporter.fmtTime(m.createTime, 'date'),
              sender: m.sender,
              senderName,
              isSelf,
              type: m.type,
              typeName: m.typeName,
              content: m.content,
              summary: m.summary,
              voicelen: m.voicelen || '',
              xml: m.xml || null,
            };
          }),
        });
      }

      /* 导出 */
      if (pathname === '/api/export' && req.method === 'POST') {
        const body = await readBody(req);
        const { account, chat, format, since, until, outDir, selectedIds } = body;
        if (!account || !chat) return sendJson(res, 400, { ok: false, err: '缺少参数' });

        core.state.busy = true;
        core.setProgress(0, '导出中');
        try {
          const r = core.readChat(cfg, account, chat, {});
          let msgs = r.messages;

          // 优先：按勾选的 ID 过滤
          const sel = Array.isArray(selectedIds) ? new Set(selectedIds) : null;
          if (sel) {
            if (sel.size === 0) {
              return sendJson(res, 200, { ok: false, err: '没有勾选任何消息' });
            }
            msgs = msgs.filter((m) => sel.has(`${m.createTime}_${m.localId}`));
          } else {
            if (since) msgs = msgs.filter((m) => m.createTime >= since);
            if (until) msgs = msgs.filter((m) => m.createTime <= until);
          }

          if (!msgs.length) return sendJson(res, 200, { ok: false, err: '没有可导出的消息' });

          const contacts = r.contacts;
          const selfWxid = body.selfWxid || guessSelf(account, r.messages);

          // 标题：优先用传入的会话名，其次联系人，最后 username
          let title = chat.name || '';
          if (!title && chat.username) {
            const c = contacts.get(chat.username);
            title = (c && (c.remark || c.nickName)) || chat.username;
          }
          if (!title) title = chat.table || 'chat';

          const ctx = {
            title,
            selfWxid,
            selfName: '我',
            peerWxid: chat.username,
            peerName: title,
            contacts,
          };

          const targetDir = outDir || cfg.exportDir;
          const out = exporter.exportTo(msgs, ctx, format || 'html', targetDir);
          return sendJson(res, 200, {
            ok: true,
            file: out.file,
            size: out.size,
            count: msgs.length,
            format: out.format,
            selected: !!sel,
          });
        } catch (e) {
          return sendJson(res, 200, { ok: false, err: e.message });
        } finally {
          core.state.busy = false;
          core.setProgress(100, '');
        }
      }

      /* 打开导出目录 */
      if (pathname === '/api/open-dir' && req.method === 'POST') {
        const body = await readBody(req);
        const dir = body.dir || cfg.exportDir;
        const { execFile } = require('child_process');
        execFile('explorer.exe', [dir], () => {});
        return sendJson(res, 200, { ok: true, dir });
      }

      /* 保存配置 */
      if (pathname === '/api/config' && req.method === 'POST') {
        const body = await readBody(req);
        const cfg2 = config.load();
        for (const k of ['wechatRoot', 'exportDir', 'workDir', 'port']) {
          if (body[k] !== undefined) cfg2[k] = body[k];
        }
        const p = config.save(cfg2);
        return sendJson(res, 200, { ok: true, path: p });
      }

      return sendJson(res, 404, { ok: false, err: '未知接口: ' + pathname });
    } catch (e) {
      console.error(e);
      return sendJson(res, 500, { ok: false, err: e.message });
    }
  });
}

/** 粗略推断本人 wxid */
function guessSelf(accountName, messages) {
  // 账号目录名形如 wxid_xxxx_abcd
  const m = accountName.match(/^(wxid_[a-z0-9]+)/i);
  if (m) return m[1];
  return '';
}

module.exports = { createServer };
