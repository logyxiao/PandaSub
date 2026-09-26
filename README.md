# 熊猫投稿

[English](README_EN.md)

熊猫投稿（NovelSub）是一款面向小说作者的本地桌面投稿工具。它将发件邮箱、编辑资料、作品信息、投稿计划、发送记录和编辑回复集中到一个工作台中，帮助作者批量但有节奏地完成投稿。

**完全开源免费**，仓库地址：[https://github.com/logyxiao/PandaSub](https://github.com/logyxiao/PandaSub)。数据默认保存在本机 SQLite 数据库中，投稿任务由 Tauri 后台执行。

<p align="center">
  <img src="docs/preview.png" alt="熊猫投稿应用预览" width="880" />
  <br />
  <em>熊猫投稿</em>
</p>

## 主要功能

- **投稿邮箱管理**：支持 QQ、163 及其他 SMTP 邮箱，可设置授权码、笔名和每日发送上限。
- **编辑资料库**：直接在表格中修改邮箱、收稿类型和备注；标签支持搜索多选、明确排除、任意匹配或全部满足；收稿与拒收类型可点选、新增和批量粘贴，并支持 Excel/CSV 导入导出。
- **独立编辑组**：管理常投名单，支持跨页选择编辑并批量加入多个组。
- **熊猫黑白界面**：默认窗口 1280×900，白色侧栏、浅灰工作区和深色主按钮；工作台集中展示投递进度、需要关注的记录、近 7／30 天趋势和最新回复，采用紧凑布局。
- **投稿计划**：集中编辑作品资料、邮件主题、正文、收件人和发送方式。
- **邮箱选择**：每个投稿计划可以单独勾选参与发送的邮箱，不会默认使用所有邮箱。
- **自定义随机节奏**：每个投稿计划可自行设置最短和最长等待秒数，每封邮件按区间随机等待。
- **定时与循环**：支持立即发送、定时发送和循环投稿。
- **发送保护**：支持账号额度、限流冻结、失败重试、暂停、继续和停止。
- **发送记录**：记录每封邮件的发送结果，可按计划和结果筛选并导出 Excel。
- **回复检查**：通过 IMAP 检查收件箱，区分人工回复、自动回复和退信；在左右分栏中阅读来信，可折叠引用的原邮件。
- **本地运行**：关闭主窗口后可继续在系统托盘运行任务。

## 自动投稿节奏

每封邮件发送完成后，系统会在计划设置的区间内随机等待再发下一封。新计划默认使用 **100–240 秒**，也可以按需要填写任意最短和最长秒数。

任务串行发送邮件；账号仍受每小时、每日额度和限流冻结策略保护。

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

## 界面回归检查

以下检查使用模拟 Tauri 接口，只在浏览器内保存测试数据，不读写真实数据库、不发送邮件。需要 Python Playwright 和 Chromium：

```bash
python3 -m pip install playwright
python3 -m playwright install chromium
npm run dev -- --host 127.0.0.1 --port 5179
```

保持开发服务运行，在另一个终端执行：

```bash
python3 scripts/test-workflow-ui.py
python3 scripts/test-panda-ui.py
```

覆盖原有投稿流程、历史记录分页，以及编辑资料快速保存、多选标签、未保存提醒、跨页加入编辑组和最小窗口布局。测试完成后会输出截图目录。macOS 桌面渲染也可用 WebKit 检查：

```bash
python3 -m playwright install webkit
NOVELSUB_TEST_BROWSER=webkit python3 scripts/test-panda-ui.py
```

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

## 一键发布

推荐在本机 Mac 编译 macOS 通用版和 Windows x64，服务器只接收安装包。
首次准备（当前开发机已配置）：

```bash
brew install llvm lld nsis minisign
cargo install cargo-xwin --locked
rustup target add aarch64-apple-darwin x86_64-apple-darwin x86_64-pc-windows-msvc
npm ci
gh auth login
ssh tx true
```

在 `main` 分支发布，当前未提交的修改会一起纳入版本：

```bash
npm run release:local -- 0.2.7 "更新说明一；更新说明二"
# 长更新说明可以放进 UTF-8 文件，每行一项：
npm run release:local -- 0.2.7 --notes-file docs/releases/0.2.7.txt
```

脚本会提交版本、推送标签、本机构建两端安装包、签名、校验并部署至
`pandasub.zhudot.com`，最后发布 GitHub Release。本地发布提交带 `[skip ci]`，
避免标签再次触发云端全量编译。请在发布前运行项目回归检查。

未在本机设置 `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PATH` 时，
GitHub 仅负责签名，使用仓库已有的 `TAURI_SIGNING_PRIVATE_KEY` 和
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` Secrets，不导出私钥，也不重新生成密钥。
本机会用应用原公钥验证 Windows 和 macOS 更新包，服务器再次检查 SHA-256，
安装包上传完整后才原子替换更新清单；旧版本文件保留。

中断后使用相同命令续跑。产物缓存在 `src-tauri/target/local-release/v版本号`，
仅复用来源提交和 SHA-256 一致的文件。已打标签的源码不能变更，正式发布的安装包
不能覆盖；修复应用请递增版本号。云端完整构建仍可使用：

```bash
npm run release:publish -- 0.2.8 "更新说明"
```

客户端启动后及每隔四小时检查更新，后台下载并验证签名，完成后轻提示。
点击“更新并重启”先检查未保存内容和发送任务；Windows 使用静默安装模式。
关闭应用前未安装的下载包不会持久化，下一次启动会重新下载。
旧客户端首次升级仍沿用其已有的提示方式，安装此版本后才使用新流程。
Windows 包在 Mac 上交叉编译，应在 Windows 机器上补充安装与升级验收。

## 项目结构

```text
NovelSub/
├── src/                    # React 前端
│   ├── components/         # 通用界面组件
│   ├── views/              # 工作台、邮箱、编辑、计划、记录、回复、设置、关于
│   ├── assets/donate/      # 支持作者收款码（wechat.png / alipay.jpeg）
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

## 支持作者

本项目完全开源免费，所有功能均可免费使用。如果熊猫投稿帮到了你，欢迎自愿请作者喝杯咖啡；赞助不绑定任何功能。

<p align="center">
  <img src="docs/donate/wechat.png" alt="微信收款码" width="220" />
  &nbsp;&nbsp;&nbsp;
  <img src="docs/donate/alipay.jpeg" alt="支付宝收款码" width="220" />
</p>

<p align="center">微信 · 支付宝</p>

项目地址：[https://github.com/logyxiao/PandaSub](https://github.com/logyxiao/PandaSub)

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
