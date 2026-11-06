# 微信聊天记录导出工具

Windows 本地工具，把微信 4.x 的聊天记录解密、浏览、导出成有格式的文本。

**只读访问，全程离线，不修改微信任何文件。**

---

## 特性

- **仿微信界面** — 三栏布局、聊天气泡、真实头像、深浅色主题
- **勾选导出** — 每条消息带复选框，可只导出选中部分
- **五种格式** — HTML / Markdown / TXT / JSON / CSV
- **零第三方依赖** — 纯 Node.js 内置模块（`node:sqlite`、`node:crypto`、`node:zlib`）
- **便携版** — 自带 `node.exe`，拷走即用，不需要装任何东西

---

## 环境要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Windows 10/11 64 位 |
| Node.js | ≥ 22（需 `node:sqlite` 和 `zstdDecompress`） |
| 微信 | 4.x（xwechat） |
| Python | 不需要 |

---

## 快速开始

### 1. 安装依赖

密钥提取需要 `koffi`（调用 Win32 API 读进程内存）：

```bat
npm install koffi
```

> 只用界面和解密功能的话，可以跳过这步 —— 解密引擎是纯 Node 内置模块。

### 2. 提取密钥

微信保持登录，**以管理员身份**运行：

```bat
node wxextract\tools\extract_key.js --restart
node wxextract\tools\apply_keys.js
```

首次会重启微信，请扫码登录。登录后自动抓取密钥。

> 微信 4.1.10+ 不再在内存常驻密钥，必须在**启动瞬间**抓取。
> `--restart` 会自动重启微信并在登录窗口期扫描。
>
> 如果自动找不到微信安装路径，用 `--exe` 指定：
> `node wxextract\tools\extract_key.js --restart --exe "D:\Weixin\Weixin.exe"`

### 3. 启动界面

```bat
start.bat
```

或手动：

```bat
node wxextract\server.js
```

浏览器自动打开 `http://127.0.0.1:8848/`，点「解密数据库」。

### 4. 浏览与导出

- 左侧选会话
- 勾选要导出的消息（或全选）
- 底部选格式，点「导出」

---

## 原理

### 加密参数（SQLCipher 4）

| 参数 | 值 |
| --- | --- |
| 加密 | AES-256-CBC |
| 认证 | HMAC-SHA512 |
| 密钥派生 | PBKDF2-HMAC-SHA512, 256,000 轮 |
| 页大小 | 4096 |
| 保留区 | 80（IV 16 + HMAC 64） |

页布局：

```
[0:16]      salt（仅第 1 页）
[16:4016)   密文
[4016:4032) IV
[4032:4096) HMAC-SHA512
```

HMAC 覆盖 `[16, 4032)` + 页号（小端 4 字节）。

### 密钥提取

微信把每个库的 raw key + salt 以 **XOR 混淆**的 `x'<64hex key><32hex salt>'`
字符串存在进程内存中。

XOR mask（实测于 4.1.15.56）：

```
d2c7442458020000004889442450488b450048844c2448488944254048584c24
```

首两字节 `d2 c7` 使 `x'`（`78 27`）变成 `aa e0`，所以搜这个字节对即可
定位所有密钥 blob。

流程：

1. 用 `koffi` 调 `ReadProcessMemory` 扫 `Weixin.exe` 内存
2. 搜特征字节 `aa e0`
3. 读命中点前后 64 字节，XOR 解密
4. 正则提 `x'<key><salt>'`
5. 用该库 page1 做 HMAC 验证，通过才算数

### 数据结构

**会话**（`session.db` / `SessionTable`）：

```sql
username, type, unread_count, summary, draft, status,
last_timestamp, sort_timestamp, last_msg_locald_id,
last_msg_type, last_msg_sender, last_sender_display_name
```

**消息**（`message_N.db` / `Msg_<md5(username)>`）：

```sql
local_id, server_id, local_type, sort_seq, real_sender_id,
create_time, status, message_content, compress_content,
WCDB_CT_message_content, packed_info_data
```

要点：

- 表名 = `Msg_` + `MD5(wxid)`
- `real_sender_id` → 本库 `Name2Id.rowid` → `user_name`
- `server_id` 是 64 位整数，超出 JS 安全范围，必须 `CAST AS TEXT`
- `message_content` 常为 zstd 压缩 BLOB，用魔数 `28 B5 2F FD` 判定

**头像**（`head_image.db`）：

```sql
username, md5, image_buffer, update_time
```

`image_buffer` 直接是 JPEG 数据。

---

## 项目结构

```
wxextract/
├── server.js             HTTP 服务入口
├── cli.js                命令行入口
├── lib/
│   ├── sqlcipher.js      SQLCipher4 解密引擎
│   ├── keys.js           密钥管理
│   ├── msgdb.js          消息库解析
│   ├── contacts.js       联系人与会话
│   ├── exporter.js       五种导出格式
│   ├── discover.js       账号目录发现
│   ├── core.js           业务编排
│   ├── server.js         REST API
│   └── config.js         配置管理
├── public/               前端（原生 JS，无框架）
└── tools/
    ├── extract_key.js    密钥提取（koffi + Win32 API）
    ├── apply_keys.js     密钥写入配置
    ├── crosscheck.js     密码学交叉验证
    └── selftest.js       自检
```

---

## 验证

```bat
node wxextract\tools\crosscheck.js
```

输出 `PASS` 表示两套独立实现的密码学结果逐字节一致。

### 仓库自检

上传前建议跑一次：

```bat
node tools\audit.js       :: 隐私数据审计
node tools\lint.js        :: 编码 / 换行 / 语法检查
node tools\check_deps.js  :: 依赖与文档一致性
```

---

## 安全说明

- 全程**只读**微信文件
- **没有任何网络请求**
- 密钥保存在 `data/config.json`，**该文件等同于聊天记录的钥匙**
- 仅用于导出**自己的**微信数据

---

## 已知限制

- 图片/语音/视频只导出占位符（`[图片]`、`[语音]`），媒体文件本体在 `msg\` 目录，
  需要额外解密 `.dat` 才能关联
- 会话列表最多显示最近 500 条消息
- 仅支持 Windows

---

## License

**GNU Affero General Public License v3.0 or later** (AGPL-3.0-or-later)

```
This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

完整协议文本见 [LICENSE](LICENSE)。

### AGPL 意味着什么

- ✅ 可以自由使用、修改、分发
- ⚠️ **修改后分发必须开源**，且保持 AGPL
- ⚠️ **网络服务化也要开源** —— 如果有人把这套代码部署成在线服务，
  必须向用户提供源码（这是 AGPL 区别于 GPL 的核心条款）
- ⚠️ 衍生作品必须同样采用 AGPL
