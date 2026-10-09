# 熊猫投稿

[English](README_EN.md)

熊猫投稿（NovelSub）是一款面向小说作者的本地桌面投稿工具。它将发件邮箱、编辑资料、作品信息、投稿计划、发送记录、编辑回复和过稿收益集中到一个工作台中，帮助作者批量但有节奏地完成投稿。

**完全开源免费**，仓库地址：[https://github.com/logyxiao/PandaSub](https://github.com/logyxiao/PandaSub)。数据默认保存在本机 SQLite 数据库中，投稿任务由 Tauri 后台执行。

<p align="center">
  <img src="docs/preview.png" alt="熊猫投稿应用预览" width="880" />
  <br />
  <em>当前工作台 · 截图中的作品、邮箱、回复和金额均为虚构展示数据</em>
</p>

## 主要功能

| 页面 | 功能 |
| --- | --- |
| 工作台 | 查看发送进度、待关注记录、近 7／30 天投递与人工回复趋势，直接进入最新来信。 |
| 邮箱管理 | 管理多个 SMTP/IMAP 邮箱、笔名、备注和发送额度；提供 QQ、163、126、Yeah 等服务参数，支持连通性测试和批量添加。 |
| 编辑库与编辑组 | 按收稿／拒收类型、平台、收藏、启用状态和拉黑关系筛选；直接编辑资料、查看平均人工回复时间与样本数；支持 Excel/CSV 导入导出、跨页选择及编辑组导入导出。 |
| 投稿计划 | 分步填写作品与邮件、选择收件人和发件邮箱、设置发送时间；支持文稿附件、计划复制、草稿与投递详情。内置多套通用邮件模板，可固定或随机选用，修改后自动保存为新计划默认模板。 |
| 发送记录 | 按计划、发送结果和邮箱检索记录，查看失败原因并导出 Excel；支持暂停、继续、停止及失败重试。 |
| 收件箱 | 汇总多个账号的普通来信和投稿回复，区分人工、自动回复及退信；左右分栏阅读，支持 HTML／纯文本、引用折叠、附件保存、搜索与已读同步。可将当前筛选结果全部标为已读。 |
| 过稿统计 | 从待核对邮件进入原文核验，记录过初审、最终过稿、未过终审或未过稿；支持误判处理、外部文章、原稿查看与导出、买断／保底分成／平台月结、千字计价及成绩图片导出。 |
| 投稿统计 | 按日期范围及日／周／月查看投递、人工回复、过稿回复和发送失败的趋势与明细。 |
| 设置 | 切换熊猫黑白／竹叶青主题，设置回复检查、开机自启和关闭到托盘，创建备份、查看空间用量及手动清理缓存，检查应用更新。 |

收件箱还支持筛选“暂停收稿”来信，跨页勾选后批量暂停、启用或删除关联编辑；**暂停会阻止后续投递，删除编辑资料不会撤销已有计划的收件人**。编辑平均回复时间只统计成功投递后的首封有效人工回复，并展示有效样本数。

过稿邮件识别用于提示核对，最终结果以人工核实为准；“过初审”不会计为最终过稿。过稿统计中的金额来自已录入的成交价格和已结算分成，并非自动到账记录。

## 界面预览

以下图片由当前前端页面生成，全部使用独立的虚构数据，不读取个人数据库，也不包含真实投稿、回复、邮箱或稿酬。

### 投稿计划

![投稿计划：状态筛选、作品资料、发件邮箱和发送进度](docs/screenshots/plans.png)

### 编辑库

![编辑库：收稿类型、平均回复时间、收藏与编辑资料](docs/screenshots/editors.png)

### 收件箱

![收件箱：虚构来信列表与右侧邮件预览](docs/screenshots/inbox.png)

### 过稿统计

![过稿统计：结果核对、渠道成绩与稿酬记录](docs/screenshots/accepted.png)

## 开始使用

1. 从 [GitHub Releases](https://github.com/logyxiao/PandaSub/releases) 下载安装包，或按下方步骤从源码运行。
2. 在“邮箱管理”添加邮箱与 SMTP/IMAP 授权码，测试连接。
3. 在“编辑库”维护收稿资料，按需要建立常投编辑组。
4. 新建投稿计划，填写作品与邮件模板，选择收件人、发件邮箱、发送间隔和开始时间。
5. 在工作台与发送记录跟进投递，在收件箱阅读反馈，再到过稿统计核对结果、记录稿酬。

## 发送节奏与预约

- 每封邮件发送完成后，按计划设置的最短／最长秒数随机等待。首次默认 **100–240 秒**；成功保存计划或草稿后，会记住本次间隔供下次新建使用，已有计划保留自己的设置。
- 新计划支持立即发送、指定本地时间开始，以及在另一个计划实际结束后延迟发送（30／60／120 分钟或自定义分钟数）。暂停前序计划不会触发后续预约；已有循环计划需停止后才开始计时。
- 定时任务约每 15 秒检查一次。**应用需保持运行、电脑唤醒且联网**；退出或休眠期间错过的预约会在恢复运行后开始。关闭窗口时可按设置继续在系统托盘运行。
- 邮件按顺序发送，仍受邮箱额度、限流冻结和失败重试策略约束。明确识别到收件人拉黑发件邮箱时，系统记录这对邮箱关系，并在符合条件时寻找同平台替代编辑。

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

- Node.js 20.19+ 或 22.12+（建议使用满足要求的 LTS 版本）
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
│   ├── views/              # 工作台、计划、收件箱、过稿／投稿统计等页面
│   ├── assets/donate/      # 支持作者收款码（wechat.png / alipay.jpeg）
│   ├── api.ts              # Tauri 命令封装
│   └── types.ts            # 前端类型
├── src-tauri/              # Rust/Tauri 后端
│   ├── src/commands/       # 按领域划分的 Tauri 命令
│   ├── src/scheduler.rs    # 投稿调度器
│   ├── src/smtp.rs         # SMTP 发送
│   ├── src/imap.rs         # IMAP 收信
│   ├── src/db.rs           # SQLite 结构与迁移
│   └── tauri.conf.json     # 桌面应用配置
├── scripts/                # 回归检查、隐私安全截图与发布工具
├── docs/                   # 页面截图与测试说明
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
- 投递记录、回复及邮件缓存
- 过稿核对、文稿副本、成交价格和月结记录
- 应用设置

可在“设置 → 备份与空间”中创建备份、查看数据库／邮件缓存／备份用量，并手动清理缓存和旧备份。数据库备份、文稿副本与邮箱配置都属于私人数据，请勿提交到公开仓库。

## 邮箱安全说明

- QQ 和 163 邮箱应使用 SMTP/IMAP 授权码，不要填写网页登录密码。
- 授权码保存在本机数据库，仅供本机后台发送和检查回复使用。
- 请合理设置每日发送上限，并遵守邮箱服务商的使用规则。
- 批量投稿前建议先使用“测试发送”验证邮箱配置和邮件内容。

---
