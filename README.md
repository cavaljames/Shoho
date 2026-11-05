# 小喝 · Shoho

<img src="assets/icon.png" alt="Shoho 图标" width="128">

喝一小口，休息片刻。基于 **Tauri 2 + TypeScript + Rust** 的 macOS / Windows 喝水提醒应用。

## 开发

需要 Node.js 22.12+（推荐 24）、Rust stable（最低 1.90）以及系统编译工具：macOS 使用 Xcode Command Line Tools，Windows 使用 Microsoft C++ Build Tools 与 WebView2。

```sh
npm ci
npm start
```

如果系统已有 Cargo，会直接使用系统工具链。本次开发准备的独立工具链放在 `.toolchain/`，启动脚本会在系统找不到 Cargo 时自动使用它，不修改 shell 配置；该目录已加入 Git 忽略。其他开发机器按 [Tauri 官方前置要求](https://v2.tauri.app/start/prerequisites/) 安装 Rust 即可。

`npm run dev` 只启动界面开发服务器；桌面功能需要 `npm start`。普通浏览器没有原生 Tauri 通信接口。

## 架构

- `src/*.ts`：类型明确的界面与 IPC 桥接，使用 Vite 构建，无额外 UI 框架。
- `src-tauri/src/model.rs`：输入校验、本地日期、提醒时段、暂停、目标达成和调度规则。
- `src-tauri/src/storage.rs`：事务式内存更新、原子文件替换、错误恢复和旧版数据导入。
- `src-tauri/src/main.rs`：托盘、原生窗口、后台调度、系统通知、开机启动和单实例管理。

关闭主窗口会销毁 WebView，释放界面资源，Rust 核心和托盘继续运行。托盘左键重新打开主窗口，右键显示快捷菜单。后台调度使用条件变量等待，平时最多每 30 秒检查一次墙钟与时段，并在目标提醒时间唤醒；界面计时器不负责真正的提醒。休眠、时钟回拨和跨天不会补发积压提醒。提醒浮窗不会主动请求焦点，可直接记录水量或推迟 10 分钟。

## 功能

- 今日进度、一键记录、自定义水量、撤销、七天统计与历史记录。
- 自定义每日目标、杯量、间隔和提醒时段，支持跨午夜。
- 提醒浮窗、10 分钟后提醒、暂停一小时和手动恢复。
- 当日目标达成后停止提醒；暂停状态与水量记录可跨重启保存。
- 托盘常驻、单实例、开机启动（安装版）与可选系统通知。
- 数据只保存在本机，无需账号，无服务器或埋点。

默认目标 1800 ml、每杯 200 ml、每隔 45 分钟在 09:00–22:00 提醒。这些只是可编辑的初始值，可按自己的需求调整。

## 验证

```sh
npm test
npm run test:ui
```

`npm test` 执行 TypeScript 严格类型检查、前端构建和 Rust 单元测试。Rust 测试覆盖跨日、跨午夜、暂停和重启、休眠和时钟变化、目标达成、非法输入、旧版导入、损坏文件备份，以及写入失败时不改变内存数据。

`npm run test:ui` 使用本机 Chrome 与模拟 Tauri IPC，验证记录、自定义水量、撤销、统计、设置、暂停恢复、最小宽度和重载。这个测试仅验证界面，不能替代原生窗口、托盘及系统功能的实机验证。截图输出在 `test-artifacts/`。

## 打包

```sh
# 在 macOS 构建当前架构的 .app 和 .dmg
npm run dist:mac

# 在 Windows 构建当前架构的 NSIS 安装程序
npm run dist:win
```

产物位于 `src-tauri/target/release/bundle/`。需在对应操作系统上构建；GitHub Actions 已配置 macOS Apple Silicon、macOS Intel 和 Windows x64 构建，可手动或通过 `v*` 标签触发。工作流只保存构建产物，不自动发布。

本地开发包未配置开发者证书。公开分发前需要配置 macOS 签名、公证和 Windows 签名。原生通知还取决于系统通知授权，默认的提醒浮窗可以独立使用。

## 数据兼容

Tauri 版数据位置：

- macOS：`~/Library/Application Support/app.shoho.desktop/shoho.json`
- Windows：`%APPDATA%/app.shoho.desktop/shoho.json`

第一次启动时，如果还没有 Tauri 数据文件，会从旧版 `Shoho/shoho.json` 导入记录与设置。导入会复制数据，不修改旧文件；之后两版数据独立。读取失败会明确报错；无法解析的 JSON 会先保留带时间戳的备份，再使用默认值。每次记录先写临时文件、同步磁盘，再原子替换；保存失败不会显示记录成功。

本机迁移时，原 Electron 源码备份保留在 `migration-backup/`，旧安装包保留在 `release/`；这两个本地目录均不提交到 Git，也不会打入新安装包。

参考：[Tauri 进程模型](https://v2.tauri.app/concept/process-model/)、[Tauri 权限](https://v2.tauri.app/security/capabilities/)。

## 视觉标识

图标采用低饱和灰玉绿、磨砂玻璃和轻微立体光影；水滴下缘的弧形切口呼应「小喝一口」。应用图标与界面共用 `assets/icon.png`，菜单栏使用可自动适应深浅主题的单色模板 `assets/trayTemplate.png`。生成提示与素材说明见 [assets/BRAND.md](assets/BRAND.md)。
