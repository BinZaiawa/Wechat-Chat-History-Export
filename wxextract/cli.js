'use strict';
/**
 * 命令行密钥工具（图形界面之外的备用入口）
 *
 * 用法：
 *   node wxextract/cli.js scan           扫描内存提取密钥
 *   node wxextract/cli.js pass <hex>     用 32 字节 passphrase 派生密钥
 *   node wxextract/cli.js list           列出数据库与密钥状态
 *   node wxextract/cli.js decrypt <账号目录>
 *   node wxextract/cli.js export <账号名> <会话名或wxid> [格式]
 */
const path = require('path');
const fs = require('fs');
const config = require('./lib/config');
const core = require('./lib/core');
const exporter = require('./lib/exporter');

const args = process.argv.slice(2);
const cmd = args[0];

function findAccount(cfg, nameOrPath) {
  const accounts = core.getAccounts(cfg);
  if (!accounts.length) throw new Error('未发现任何微信账号目录');
  if (!nameOrPath) return accounts[0];
  const hit = accounts.find((a) => a.name === nameOrPath || a.path === nameOrPath);
  if (hit) return hit;
  const fuzzy = accounts.find((a) => a.name.includes(nameOrPath));
  if (fuzzy) return fuzzy;
  throw new Error('找不到账号: ' + nameOrPath + '\n可用: ' + accounts.map((a) => a.name).join(', '));
}

function main() {
  const cfg = config.load();

  if (!cmd || cmd === 'help') {
    console.log(`微信聊天记录导出工具 - 命令行

用法:
  node wxextract/cli.js list                     列出账号与数据库
  node wxextract/cli.js scan [账号]              扫描微信进程内存提取密钥
  node wxextract/cli.js pass <64位hex> [账号]    用 passphrase 派生密钥
  node wxextract/cli.js decrypt [账号]           解密数据库
  node wxextract/cli.js chats [账号]             列出会话
  node wxextract/cli.js export [账号] <会话> [格式]
                                                 导出会话（txt/md/json/html/csv）

配置文件: ${config.CONFIG_PATH}
`);
    return;
  }

  if (cmd === 'list') {
    const accounts = core.getAccounts(cfg);
    if (!accounts.length) {
      console.log('未发现微信数据目录');
      return;
    }
    for (const a of accounts) {
      console.log(`账号: ${a.name}`);
      console.log(`  路径: ${a.path}`);
      console.log(`  库: ${a.dbCount} 个 / ${a.sizeMB} MB`);
      const dbs = require('./lib/keys').collectDbs(a.dbStorage);
      for (const d of dbs) {
        const k = (cfg.keys || {})[d.rel];
        console.log(`    ${k && k.encKey ? '[有密钥]' : '[无密钥]'} ${d.rel}  ${d.sizeMB}MB`);
      }
    }
    return;
  }

  if (cmd === 'scan') {
    const acc = findAccount(cfg, args[1]);
    const r = core.scanKeys(cfg, acc.path);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (cmd === 'pass') {
    const hex = args[1];
    if (!hex) throw new Error('需要 32 字节 passphrase（64 个 hex 字符）');
    const acc = findAccount(cfg, args[2]);
    const r = core.deriveKeysFromPassphrase(cfg, acc.path, hex);
    console.log(`匹配 ${r.matched}/${r.total} 个库`);
    return;
  }

  if (cmd === 'decrypt') {
    const acc = findAccount(cfg, args[1]);
    const r = core.decryptAccount(cfg, acc.path);
    console.log(`成功 ${r.decrypted.length} 个，失败 ${r.failed.length} 个`);
    console.log('输出目录:', r.outRoot);
    if (r.failed.length) {
      for (const f of r.failed.slice(0, 20)) console.log('  失败:', f.rel, '-', f.reason);
    }
    return;
  }

  if (cmd === 'chats') {
    const acc = findAccount(cfg, args[1]);
    const r = core.listChats(cfg, acc.name);
    if (!r.ok) throw new Error(r.err);
    r.chats.slice(0, 100).forEach((c, i) => {
      console.log(`${String(i + 1).padStart(3)}. ${c.name}  [${c.timeText}]  ${c.hasMessages ? '' : '(无消息)'}`);
    });
    return;
  }

  if (cmd === 'export') {
    const acc = findAccount(cfg, args[1]);
    const target = args[2];
    if (!target) throw new Error('需要指定会话名或 wxid');
    const format = args[3] || 'html';
    const r = core.listChats(cfg, acc.name);
    if (!r.ok) throw new Error(r.err);
    const chat = r.chats.find((c) => c.name === target || c.username === target)
      || r.chats.find((c) => c.name.includes(target));
    if (!chat) throw new Error('找不到会话: ' + target);
    const data = core.readChat(cfg, acc.name, chat, {});
    if (!data.messages.length) throw new Error('该会话无消息');
    const ctx = {
      title: chat.name,
      selfWxid: (acc.name.match(/^(wxid_[a-z0-9]+)/i) || [])[1] || '',
      selfName: '我',
      peerWxid: chat.username,
      peerName: chat.name,
      contacts: data.contacts,
    };
    const out = exporter.exportTo(data.messages, ctx, format, cfg.exportDir);
    console.log(`导出 ${data.messages.length} 条消息 -> ${out.file}`);
    return;
  }

  console.log('未知命令:', cmd, '\n运行 node wxextract/cli.js help 查看用法');
}

try {
  main();
} catch (e) {
  console.error('错误:', e.message);
  process.exit(1);
}
