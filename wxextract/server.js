'use strict';
/**
 * 启动入口
 * 用法: node wxextract/server.js  [--port 8848] [--no-open]
 */
const path = require('path');
const { execFile } = require('child_process');
const config = require('./lib/config');
const { createServer } = require('./lib/server');

const args = process.argv.slice(2);
function argOf(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const noOpen = args.includes('--no-open');

// Windows 控制台默认代码页可能导致中文乱码，尝试切到 UTF-8
// spawn 失败会同步抛 EPERM，必须包住，不能影响服务启动
if (process.platform === 'win32') {
  try {
    execFile('cmd.exe', ['/c', 'chcp 65001'], { windowsHide: true }, () => {});
  } catch (_) {}
}

const cfg = config.load();
const port = +argOf('--port', cfg.port || 8848);
const host = cfg.host || '127.0.0.1';

const server = createServer();

// 全局兜底：任何未捕获异常都不允许静默杀死服务
process.on('uncaughtException', (e) => {
  console.error('[未捕获异常]', e && e.message ? e.message : e);
});
process.on('unhandledRejection', (e) => {
  console.error('[未处理 Promise]', e && e.message ? e.message : e);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[错误] 端口 ${port} 已被占用。`);
    console.error(`请换一个端口启动：node wxextract/server.js --port 8849\n`);
    process.exit(1);
  }
  console.error('[错误]', e.message);
  process.exit(1);
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}/`;
  console.log('');
  console.log('  微信聊天记录导出工具');
  console.log('  ─────────────────────────────');
  console.log(`  服务地址: ${url}`);
  console.log(`  配置文件: ${config.CONFIG_PATH}`);
  console.log(`  导出目录: ${cfg.exportDir}`);
  console.log('  ─────────────────────────────');
  console.log('  按 Ctrl+C 停止服务');
  console.log('');

  if (!noOpen) {
    // 延迟一点再开浏览器，确保端口已监听。
    // 注意：spawn 失败会同步抛 EPERM，必须 try/catch，否则整个服务进程会崩。
    setTimeout(() => {
      try {
        execFile('cmd.exe', ['/c', 'start', '', url], { windowsHide: true }, (err) => {
          if (err) console.log('  （未能自动打开浏览器，请手动访问上面的地址）');
        });
      } catch (e) {
        console.log('  （未能自动打开浏览器，请手动访问上面的地址）');
      }
    }, 400);
  }
});

process.on('SIGINT', () => {
  console.log('\n正在停止服务…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
});
