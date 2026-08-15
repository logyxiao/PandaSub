# 熊猫投稿

[English](#english)

熊猫投稿（NovelSub）是一款面向小说作者的本地桌面投稿工具。它将发件邮箱、编辑资料、作品信息、投稿计划、发送记录和编辑回复集中到一个工作台中，帮助作者批量但有节奏地完成投稿。

数据默认保存在本机 SQLite 数据库中，投稿任务由 Tauri 后台执行。

![熊猫投稿应用预览](docs/preview.png)

## 主要功能

- **投稿邮箱管理**：支持 QQ、163 及其他 SMTP 邮箱，可设置授权码、笔名和每日发送上限。
- **编辑资料库**：按平台分组维护编辑邮箱，支持风格、作品类型、启用状态、Excel/CSV 导入和导出。
- **投稿计划**：集中编辑作品资料、邮件主题、正文、收件人和发送方式。
- **邮箱选择**：每个投稿计划可以单独勾选参与发送的邮箱，不会默认使用所有邮箱。
- **自动调速**：根据当前计划的累计发送量自动调整发送间隔，无需手动选择频次。
- **定时与循环**：支持立即发送、定时发送和循环投稿。
- **发送保护**：支持账号额度、限流冻结、失败重试、暂停、继续和停止。
- **发送记录**：记录每封邮件的发送结果，可按计划和结果筛选并导出 Excel。
- **回复检查**：通过 IMAP 检查收件箱，区分人工回复、自动回复和退信。
- **本地运行**：关闭主窗口后可继续在系统托盘运行任务。

## 自动投稿节奏

发送间隔由系统根据当前计划的累计发送量自动切换：

| 累计发送量 | 下一封等待时间 |
| --- | --- |
| 前 11 封 | 3 分钟 |
| 第 12–19 封 | 30 秒 |
| 第 20–51 封 | 1 分钟 |
| 第 52 封起 | 2 分钟 |

任务会串行发送邮件，并等待当前档位时间结束后再发送下一封。账号仍受每小时、每日额度和限流冻结策略保护。

## 技术栈

- [Tauri 2](https://tauri.app/)
- [React 19](https://react.dev/)
- [TypeScript 6](https://www.typescriptlang.org/)
- [Vite 8](https://vite.dev/)
- Rust + Tokio
- SQLite
- Lettre（SMTP）
- IMAP

## 环境要求

- Node.js 20 或更高版本
- npm
- Rust stable
- macOS：Xcode Command Line Tools
- Windows：Microsoft C++ Build Tools 和 WebView2

当前开发环境使用 macOS arm64。

## 开发运行

安装依赖：

```bash
npm install
```

启动完整桌面应用：

```bash
npm run tauri dev
```

只启动前端页面：

```bash
npm run dev
```

只启动前端时无法访问本地数据库、SMTP、IMAP 和 Tauri 系统能力。

## 构建

检查前端类型并构建：

```bash
npm run build
```

检查代码：

```bash
npm run lint
```

检查 Rust 后端：

```bash
cd src-tauri
cargo check
```

构建桌面安装包：

```bash
npm run tauri build
```

支持的 Tauri 构建目标包括 macOS App/DMG 和 Windows NSIS。

## 项目结构

```text
NovelSub/
├── src/                    # React 前端
│   ├── components/         # 通用界面组件
│   ├── views/              # 工作台、邮箱、编辑、计划、记录、回复、设置
│   ├── api.ts              # Tauri 命令封装
│   └── types.ts            # 前端类型
├── src-tauri/              # Rust/Tauri 后端
│   ├── src/commands.rs     # Tauri 命令
│   ├── src/scheduler.rs    # 投稿调度器
│   ├── src/smtp.rs         # SMTP 发送
│   ├── src/imap.rs         # IMAP 收信
│   ├── src/db.rs           # SQLite 结构与迁移
│   └── tauri.conf.json     # 桌面应用配置
└── README.md
```

## 本地数据

macOS 默认数据库位置：

```text
~/Library/Application Support/com.novelsub.desktop/novelsub.sqlite
```

数据库保存以下内容：

- 发件邮箱和 SMTP/IMAP 配置
- 编辑资料
- 作品与投稿计划
- 任务状态
- 投递记录和回复
- 应用设置

可在“设置 → 数据与备份”中创建数据库备份。

## 邮箱安全说明

- QQ 和 163 邮箱应使用 SMTP/IMAP 授权码，不要填写网页登录密码。
- 授权码保存在本机数据库，仅供本机后台发送和检查回复使用。
- 请合理设置每日发送上限，并遵守邮箱服务商的使用规则。
- 批量投稿前建议先使用“测试发送”验证邮箱配置和邮件内容。

---

# English

[中文](#熊猫投稿)

Panda Submission (NovelSub) is a local desktop submission tool for fiction writers. It brings sender accounts, editor contacts, manuscripts, submission plans, delivery logs, and editor replies into one workspace.

Data is stored locally in SQLite, while submission tasks run in the Tauri background process.

![Panda Submission preview](docs/preview.png)

## Features

- **Sender account management**: Configure QQ, 163, and other SMTP accounts with authorization codes, pen names, and daily limits.
- **Editor library**: Manage editor addresses by platform, style, work type, and status; import or export Excel/CSV files.
- **Submission plans**: Edit manuscript metadata, message subject, body, recipients, and schedule in one workflow.
- **Per-plan account selection**: Choose exactly which enabled sender accounts participate in each submission plan.
- **Automatic pacing**: Submission intervals change automatically based on the number of messages already sent by the current plan.
- **Scheduling modes**: Send immediately, at a specified time, or repeatedly.
- **Delivery safeguards**: Hourly and daily account limits, rate-limit cooldowns, retries, pause, resume, and stop controls.
- **Delivery logs**: Track each message, filter by plan or result, and export to Excel.
- **Reply monitoring**: Check inboxes over IMAP and classify human replies, automated replies, and bounces.
- **Background execution**: Tasks can continue from the system tray after the main window is closed.

## Automatic Submission Pace

The application adjusts the delay before the next message according to the current plan's cumulative send count:

| Cumulative messages | Delay before next message |
| --- | --- |
| First 11 | 3 minutes |
| 12–19 | 30 seconds |
| 20–51 | 1 minute |
| 52 and later | 2 minutes |

Messages are sent sequentially. Account-level hourly and daily limits and cooldown rules still apply.

## Tech Stack

- [Tauri 2](https://tauri.app/)
- [React 19](https://react.dev/)
- [TypeScript 6](https://www.typescriptlang.org/)
- [Vite 8](https://vite.dev/)
- Rust + Tokio
- SQLite
- Lettre (SMTP)
- IMAP

## Requirements

- Node.js 20 or later
- npm
- Rust stable
- macOS: Xcode Command Line Tools
- Windows: Microsoft C++ Build Tools and WebView2

## Development

Install dependencies:

```bash
npm install
```

Run the complete desktop application:

```bash
npm run tauri dev
```

Run only the frontend:

```bash
npm run dev
```

The frontend-only mode cannot access SQLite, SMTP, IMAP, or other Tauri APIs.

## Build

Build and type-check the frontend:

```bash
npm run build
```

Run lint checks:

```bash
npm run lint
```

Check the Rust backend:

```bash
cd src-tauri
cargo check
```

Build desktop installers:

```bash
npm run tauri build
```

Configured bundle targets include macOS App/DMG and Windows NSIS.

## Project Structure

```text
NovelSub/
├── src/                    # React frontend
│   ├── components/         # Shared UI components
│   ├── views/              # Dashboard, accounts, editors, plans, logs, replies, settings
│   ├── api.ts              # Tauri command wrappers
│   └── types.ts            # Frontend types
├── src-tauri/              # Rust/Tauri backend
│   ├── src/commands.rs     # Tauri commands
│   ├── src/scheduler.rs    # Submission scheduler
│   ├── src/smtp.rs         # SMTP delivery
│   ├── src/imap.rs         # IMAP inbox scanning
│   ├── src/db.rs           # SQLite schema and migrations
│   └── tauri.conf.json     # Desktop application configuration
└── README.md
```

## Local Data

Default database location on macOS:

```text
~/Library/Application Support/com.novelsub.desktop/novelsub.sqlite
```

The database stores sender accounts, editor contacts, manuscripts, plans, task state, delivery logs, replies, and settings. Backups can be created from **Settings → Data & Backup**.

## Email Security

- Use SMTP/IMAP authorization codes for QQ and 163 accounts instead of web login passwords.
- Authorization codes remain in the local database and are used only for sending mail and checking replies from this device.
- Configure reasonable daily limits and follow the rules of each email provider.
- Use **Test Send** before running a submission plan to verify the account and message content.
