'use strict';
/**
 * 导出模块
 * 支持：TXT / Markdown / JSON / HTML / CSV
 * 输出统一 UTF-8（TXT 带 BOM 便于 Windows 记事本识别）
 */
const fs = require('fs');
const path = require('path');

function pad(n) { return String(n).padStart(2, '0'); }

function fmtTime(ts, fmt = 'full') {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const y = d.getFullYear(), mo = pad(d.getMonth() + 1), da = pad(d.getDate());
  const h = pad(d.getHours()), mi = pad(d.getMinutes()), se = pad(d.getSeconds());
  if (fmt === 'date') return `${y}-${mo}-${da}`;
  if (fmt === 'time') return `${h}:${mi}:${se}`;
  if (fmt === 'compact') return `${y}${mo}${da}-${h}${mi}${se}`;
  return `${y}-${mo}-${da} ${h}:${mi}:${se}`;
}

function weekday(ts) {
  const w = ['日', '一', '二', '三', '四', '五', '六'];
  return '星期' + w[new Date(ts * 1000).getDay()];
}

/** 把消息按「同一天」分组 */
function groupByDay(messages) {
  const groups = [];
  let cur = null;
  for (const m of messages) {
    const day = fmtTime(m.createTime, 'date');
    if (!cur || cur.day !== day) {
      cur = { day, weekday: weekday(m.createTime), items: [] };
      groups.push(cur);
    }
    cur.items.push(m);
  }
  return groups;
}

/** 判断是否是自己发的 */
function isSelf(msg, selfWxid) {
  if (!selfWxid) return false;
  return msg.sender === selfWxid;
}

function senderLabel(msg, ctx) {
  if (isSelf(msg, ctx.selfWxid)) return ctx.selfName || '我';
  if (msg.sender) {
    const c = ctx.contacts && ctx.contacts.get(msg.sender);
    return (c && (c.remark || c.nickName)) || msg.sender;
  }
  return ctx.peerName || '对方';
}

/* ---------------- TXT ---------------- */
function exportTxt(messages, ctx) {
  const L = [];
  L.push('='.repeat(70));
  L.push(`聊天记录导出：${ctx.title}`);
  L.push(`账号：${ctx.selfWxid || '-'}   对象：${ctx.peerWxid || '-'}`);
  L.push(`消息条数：${messages.length}`);
  if (messages.length) {
    L.push(`时间范围：${fmtTime(messages[0].createTime)} ~ ${fmtTime(messages[messages.length - 1].createTime)}`);
  }
  L.push(`导出时间：${fmtTime(Math.floor(Date.now() / 1000))}`);
  L.push('='.repeat(70));
  L.push('');

  for (const g of groupByDay(messages)) {
    L.push('');
    L.push(`---------- ${g.day} ${g.weekday} ----------`);
    L.push('');
    for (const m of messages_filter(g.items)) {
      const who = senderLabel(m, ctx);
      const t = fmtTime(m.createTime, 'time');
      const body = renderBody(m);
      const lines = body.split('\n');
      L.push(`[${t}] ${who}: ${lines[0]}`);
      for (let i = 1; i < lines.length; i++) L.push(`    ${lines[i]}`);
    }
  }
  L.push('');
  L.push('='.repeat(70));
  L.push('导出结束');
  return '\ufeff' + L.join('\r\n');
}

function messages_filter(items) { return items; }

/** 渲染消息正文（含附件信息） */
function renderBody(m) {
  const x = m.xml || {};
  switch (m.type) {
    case 1: return m.content || '';
    case 3: return '[图片]';
    case 34: return `[语音] ${m.voicelen || ''}${m.voicelen ? '秒' : ''}`.trim();
    case 43: return '[视频]';
    case 47: return '[表情]';
    case 42: return `[名片] ${x.nickname || ''}`.trim();
    case 48: return `[位置] ${x.label || x.title || ''}`.trim();
    case 50: return '[通话]';
    case 10000:
    case 10002: return `[系统] ${m.content || ''}`.trim();
    case 49: {
      if (x.special === 'transfer') return `[转账] ${x.title || ''}`.trim();
      if (x.special === 'redpacket') return `[红包] ${x.title || ''}`.trim();
      if (x.type === '6' || x.filename) return `[文件] ${x.title || x.filename || ''}${x.filesize ? ` (${formatSize(+x.filesize)})` : ''}`.trim();
      if (x.type === '57') return `[引用] ${x.title || ''}`.trim();
      if (x.type === '5') return `[链接] ${x.title || ''}${x.url ? '\n  ' + x.url : ''}`.trim();
      if (x.type === '19') return `[合并转发] ${x.title || ''}`.trim();
      if (x.type === '36') return `[小程序] ${x.title || ''}`.trim();
      if (x.type === '3') return `[音乐] ${x.title || ''}`.trim();
      if (x.type === '33' || x.type === '36') return `[小程序] ${x.title || ''}`.trim();
      return `[富媒体] ${x.title || x.des || ''}`.trim();
    }
    default:
      return m.content ? `[${m.typeName}] ${m.content}` : `[${m.typeName}]`;
  }
}

function formatSize(n) {
  if (!n || n < 0) return '';
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + 'MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + 'GB';
}

/* ---------------- Markdown ---------------- */
function exportMarkdown(messages, ctx) {
  const L = [];
  L.push(`# 聊天记录：${ctx.title}`);
  L.push('');
  L.push('| 项目 | 内容 |');
  L.push('| --- | --- |');
  L.push(`| 账号 | ${ctx.selfWxid || '-'} |`);
  L.push(`| 对象 | ${ctx.peerWxid || '-'} |`);
  L.push(`| 消息条数 | ${messages.length} |`);
  if (messages.length) {
    L.push(`| 时间范围 | ${fmtTime(messages[0].createTime)} ~ ${fmtTime(messages[messages.length - 1].createTime)} |`);
  }
  L.push(`| 导出时间 | ${fmtTime(Math.floor(Date.now() / 1000))} |`);
  L.push('');

  for (const g of groupByDay(messages)) {
    L.push(`## ${g.day} ${g.weekday}`);
    L.push('');
    for (const m of g.items) {
      const who = senderLabel(m, ctx);
      const t = fmtTime(m.createTime, 'time');
      const body = renderBody(m).replace(/\n/g, '  \n');
      L.push(`**${who}** \`${t}\`：${body}`);
      L.push('');
    }
  }
  return L.join('\n');
}

/* ---------------- JSON ---------------- */
function exportJson(messages, ctx) {
  const data = {
    meta: {
      title: ctx.title,
      selfWxid: ctx.selfWxid || '',
      peerWxid: ctx.peerWxid || '',
      messageCount: messages.length,
      exportedAt: fmtTime(Math.floor(Date.now() / 1000)),
      timeRange: messages.length
        ? { from: fmtTime(messages[0].createTime), to: fmtTime(messages[messages.length - 1].createTime) }
        : null,
    },
    messages: messages.map((m) => ({
      localId: m.localId,
      serverId: m.serverId,
      type: m.type,
      typeName: m.typeName,
      sender: m.sender,
      senderName: senderLabel(m, ctx),
      isSelf: isSelf(m, ctx.selfWxid),
      time: fmtTime(m.createTime),
      timestamp: m.createTime,
      content: m.content,
      summary: m.summary,
      xml: m.xml || undefined,
      voicelen: m.voicelen || undefined,
    })),
  };
  return JSON.stringify(data, null, 2);
}

/* ---------------- HTML ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function exportHtml(messages, ctx) {
  const rows = [];
  for (const g of groupByDay(messages)) {
    rows.push(`<div class="daysep">${esc(g.day)} ${esc(g.weekday)}</div>`);
    for (const m of g.items) {
      const self = isSelf(m, ctx.selfWxid);
      const who = senderLabel(m, ctx);
      const t = fmtTime(m.createTime, 'time');
      const body = esc(renderBody(m)).replace(/\n/g, '<br>');
      rows.push(
        `<div class="msg ${self ? 'self' : 'peer'}">` +
        `<div class="meta"><span class="who">${esc(who)}</span><span class="time">${t}</span>` +
        `<span class="type">${esc(m.typeName)}</span></div>` +
        `<div class="body">${body}</div></div>`
      );
    }
  }
  const range = messages.length
    ? `${fmtTime(messages[0].createTime)} ~ ${fmtTime(messages[messages.length - 1].createTime)}`
    : '-';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>聊天记录 - ${esc(ctx.title)}</title>
<style>
:root{color-scheme:light dark}
body{font-family:"Microsoft YaHei","PingFang SC",system-ui,sans-serif;max-width:900px;margin:0 auto;padding:24px;background:#f5f5f5;color:#222}
h1{font-size:20px;margin:0 0 8px}
.meta-top{color:#666;font-size:13px;margin-bottom:20px;line-height:1.7}
.daysep{text-align:center;color:#888;font-size:12px;margin:24px 0 16px;position:relative}
.daysep:before,.daysep:after{content:"";position:absolute;top:50%;width:38%;height:1px;background:#ddd}
.daysep:before{left:0}.daysep:after{right:0}
.msg{margin:10px 0;max-width:78%;clear:both}
.msg.peer{float:left}
.msg.self{float:right;text-align:right}
.msg .meta{font-size:11px;color:#999;margin-bottom:4px}
.msg .meta .who{font-weight:600;color:#576b95;margin-right:6px}
.msg .meta .type{background:#e8e8e8;border-radius:3px;padding:0 4px;margin-left:6px}
.msg .body{background:#fff;border-radius:6px;padding:9px 12px;display:inline-block;text-align:left;white-space:pre-wrap;word-break:break-word;box-shadow:0 1px 2px rgba(0,0,0,.06);line-height:1.55}
.msg.self .body{background:#95ec69}
.msg .body .sys{color:#999;font-style:italic}
@media print{.msg{page-break-inside:avoid}body{background:#fff}}
</style></head><body>
<h1>聊天记录：${esc(ctx.title)}</h1>
<div class="meta-top">
账号：${esc(ctx.selfWxid || '-')}<br>
对象：${esc(ctx.peerWxid || '-')}<br>
消息条数：${messages.length}<br>
时间范围：${esc(range)}<br>
导出时间：${fmtTime(Math.floor(Date.now() / 1000))}
</div>
${rows.join('\n')}
<div style="clear:both"></div>
</body></html>`;
}

/* ---------------- CSV ---------------- */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function exportCsv(messages, ctx) {
  const L = [];
  L.push(['时间', '时间戳', '发送者', '发送者wxid', '是否本人', '类型码', '类型', '内容', '摘要'].map(csvCell).join(','));
  for (const m of messages) {
    L.push([
      fmtTime(m.createTime),
      m.createTime,
      senderLabel(m, ctx),
      m.sender || '',
      isSelf(m, ctx.selfWxid) ? '是' : '否',
      m.type,
      m.typeName,
      m.content || '',
      m.summary || '',
    ].map(csvCell).join(','));
  }
  return '\ufeff' + L.join('\r\n');
}

const FORMATS = {
  txt: { ext: 'txt', fn: exportTxt, label: '纯文本' },
  md: { ext: 'md', fn: exportMarkdown, label: 'Markdown' },
  json: { ext: 'json', fn: exportJson, label: 'JSON' },
  html: { ext: 'html', fn: exportHtml, label: 'HTML（可直接看）' },
  csv: { ext: 'csv', fn: exportCsv, label: 'CSV（Excel）' },
};

function safeName(s) {
  return String(s || 'chat').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'chat';
}

function exportTo(messages, ctx, format, outDir) {
  const f = FORMATS[format];
  if (!f) throw new Error('不支持的格式: ' + format);
  fs.mkdirSync(outDir, { recursive: true });
  const base = `${safeName(ctx.title)}_${fmtTime(Math.floor(Date.now() / 1000), 'compact')}`;
  const file = path.join(outDir, `${base}.${f.ext}`);
  const content = f.fn(messages, ctx);
  fs.writeFileSync(file, content, 'utf8');
  return { file, size: Buffer.byteLength(content, 'utf8'), format };
}

module.exports = { exportTo, FORMATS, fmtTime, groupByDay, isSelf, senderLabel, renderBody, formatSize };
