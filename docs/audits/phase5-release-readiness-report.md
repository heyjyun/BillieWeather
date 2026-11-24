# BillieWeather / FinRx Phase 5 发布就绪报告

2026-11-24 · `autonomous-development` · macOS 27.2.1（26B131），Apple Silicon

## 1. 执行摘要

**生产发布建议为 NO-GO。** Apple Silicon 可继续隔离 QA。原生收据与扫描 PDF 的完整验收仍受阻，Apple Vision 在同一系统上间歇性停滞。原生 SQLite 的上游公告也有待处置。Web 的本地构建和回归通过，Render 的构建和启动阶段仍分别包含数据库写入，生产运行时配置未得到核验。Windows、Intel macOS、iOS、Android 均缺少可发布的验收证据。

进入 Phase 5 前，独立工作树 `billieweather-roadmap` 处于干净状态，基线为 `963f075`。核对了 Phase 1b `5ec26c2`、Phase 2 `aad3c7d`、Phase 3 `dee1fea` 和 Phase 4 `8015c9f`。原工作树 `billieweather` 的分支为 `phase-1a-modular-shell`，有用户未提交改动。历史验收见 [自主开发进度](autonomous-development-progress.md)。

本轮使用合成账户、合成财务文件和独立存储。Rails 与 identity-api 在启动前验证 PostgreSQL 的数据库名、角色、Unix socket 和实际数据目录，服务只绑定 `127.0.0.1`。注入指向 `production.invalid` 的模拟 `DATABASE_URL`、`DATABASE_URL_UNPOOLED`、`PGHOST` 和 `PGSERVICE` 后，两项服务探针仍报告专用 socket、`billie_isolated_development` 和角色 `billie_isolated`。旧开发服务使用生产目标的风险见第 8 节。

## 2. 原生 macOS E2E 证据

| 检查 | 状态 | 观察 |
| --- | --- | --- |
| 独立 Tauri 应用启动 | PASS | 本地 arm64 debug `.app`，Bundle ID 为 `com.billieweather.roadmap.phase5`，版本 `0.1.0`，最低 macOS `11.0`，ad hoc 签名。URL scheme 为 `billieweather-roadmap-phase5`。 |
| 本地账户与数据库 | PASS | 在真实 WKWebView 登录合成账户，命名并创建 `Phase 5 Synthetic Ledger`，进入 Add & Sync。Rails API 与 identity-api 的本地健康检查均返回 200。 |
| 文件选择与无障碍控制 | BLOCKED | Tauri 上传和 WKWebView 文件输入均打开 macOS Open 面板。合成 PNG 高亮后，`OKButton` 仍为 disabled。键盘确认、完整路径和可读临时目录复试均未提交文件。坐标操作返回 `noWindowsAvailable`，之后连接超时，干净重启后仍返回 `cgWindowNotFound`。采样时应用主线程正在 AppKit 事件循环等待。重新打包并明确 ad hoc 签名后，窗口控制恢复，PDF 选择器仍发生同一问题。 |
| 本地主题、语言、界面模式、功能库 | PASS | 原生界面实测英语与简体中文、浅色与深色、Default 与 Manual 切换。关闭后台模块同步的 QA 构建启用报表后，退出和重启仍显示报表及简体中文。深色页面中退出登录按钮肉眼对比度偏低，未测量对比度。 |
| 本地化修复后的原生确认 | BLOCKED | 最终签名包启动并出现标准窗口，读取 WebView 内容时连接超时，按 Bundle ID 重连仍超时。成功和失败消息的中文回归均通过。 |
| SQLite 完整性 | PASS | 对专用 Bundle ID 的数据库执行只读检查。`integrity_check` 返回 `ok`，外键违规 0，交易 0，账单 0。 |

原生 E2E 的可核证证据是会话中的无障碍树、选中文件后 Open 灰显的截图、进程采样和上述数据库检查。文件交付失败的原因尚未定位到应用、Open 面板或自动化环境中的某一层。成功登录、打开面板及取消得到实测。原生收据 8 项中 2 项 BLOCKED、6 项 NOT TESTED。原生扫描 PDF 8 项中 1 项 BLOCKED、6 项 NOT TESTED、1 项仅通过文件选择器取消和重选复试。

## 3. 收据验收

| 验收项 | 原生 GUI | 独立验证 |
| --- | --- | --- |
| 图片选择 | BLOCKED | Tauri 和 WKWebView 均打开系统选择器并高亮 PNG，Open 灰显。 |
| OCR | NOT TESTED | 禁止联网的真实 Apple Vision CLI 成功识别合成收据。 |
| 商家、日期、金额和币种 | NOT TESTED | 实际 Vision 输出通过应用识别结果解析和收据字段提取，得到 `QA SYNTHETIC MARKET`、`2026-11-20`、`10.25`、`USD`，均符合真值。 |
| 匹配已有交易 | NOT TESTED | Universal 回归覆盖保留现有交易和人工确认不同采购。Rails 回归覆盖匹配规则。 |
| 歧义匹配 | NOT TESTED | Universal 组件与存储回归覆盖候选选择，确认前保持原交易数。 |
| 重复收据 | NOT TESTED | Universal 回归覆盖再次扫描已入账收据、重复确认保护和同一笔写入。 |
| 新交易预览与确认 | NOT TESTED | Universal 回归覆盖显式保存前零写入和确认后仅入账一次。 |
| 错误与恢复 | BLOCKED | 系统面板取消及重新打开 PASS。损坏图片通过原生页面后的提示、重试未到达。真实引擎测试验证损坏输入返回 `decode_failed`。 |

对歧义收据和新交易，零静默写入的结论限于自动化覆盖及已观察到的原生取消路径。原生页面识别后须复核 SQLite 数量和交易内容。见 [收据工作流测试](../../clients/universal/test/receiptCapture.test.tsx)。

## 4. 扫描 PDF 验收

| 验收项 | 原生 GUI | 独立验证 |
| --- | --- | --- |
| 文件选择 | BLOCKED | 在 ad hoc 签名包内打开系统文件面板并高亮合成扫描 PDF。Open 保持灰显，Return 与重复选择均未传入应用。 |
| 加载及渲染 | NOT TESTED | 纯扫描合成 PDF 为两页，文本层字符数为 0。Poppler 渲染两页并目检通过。真实 Chromium 运行应用的 pdf.js 渲染路径。 |
| Apple Vision OCR | NOT TESTED | 两张渲染图通过禁网的真实 Vision CLI，均返回相应页的识别结果。 |
| 提取与标准化 | NOT TESTED | Apple Vision 和 Chromium/Tesseract 的导入管线各提取 8 行。8 行日期和带符号金额均正确，7 行可确认，1 行待审核，0 行错误标为可确认。 |
| 导入预览与去重 | NOT TESTED | Universal PDF 导入和预览套件覆盖重复文件、重复行及复核决策。 |
| 用户确认 | NOT TESTED | 导入计划在待审核行未处理时返回 `committable=false`。自动化覆盖明确确认。 |
| 成功持久化 | NOT TESTED | Universal 存储测试通过。此原生 QA 账本仍为 0 笔交易、0 份账单。 |
| 取消和重试 | PASS（文件面板） | Escape 后回到导入页，可再次打开选择器。组件覆盖取消和失败处理。预览后的原生取消、重试与确认待验收。 |

扫描 PDF 样本与验证入口见 [双页合成账单](../../clients/universal/test/ocr-fixtures/scanned-statement.pdf)、[离线 Chromium OCR 测试](../../clients/universal/test/ocr/browser.real.test.ts) 和 [PDF 预览测试](../../clients/universal/test/pdfReviewPage.test.tsx)。

## 5. Apple Vision FFI 调查

- **FAIL（初始复现）**。以同一 Swift 源编译独立 CLI，使用同一张合成账单图，分别直接执行和在禁网沙箱执行。两个进程都超过 12 秒识别限额，采样后分别于 14.40 秒和 14.64 秒终止，均未输出 JSON。两份栈都进入 `VNImageRequestHandler.perform`、`VNRecognizeTextRequest`、`TextRecognition` 和 `_ANEDaemonConnection compileModel`，随后等待 Mach 回复。
- **PASS（重试）**。同一主机和源代码，在未重启系统、未修改 Swift 或 Rust OCR 生产代码的情况下，真实 Swift suite 12/12、Rust FFI 专项 1/1、完整 Rust suite 20/20。又交叉运行直接 Swift、禁网 Swift 和 FFI 各 3 次，9/9 通过，单次 0.43–0.67 秒。随后在最终依赖组合中，FFI 有四次超时，其中两次采样显示相同的 ANE 编译等待。较早的通过记录仅表明故障可间歇恢复。中文、旋转、模糊和多页均在引擎套件中实测。倾斜 3° 样本的 8 行均未提取，未出现错误可确认项。
- **BLOCKED（稳定性根因）**。可定位的停滞点为 Apple Vision 识别时等待 ANE 编译服务。独立 CLI 在主线程、无 Rust FFI 与 Tauri、网络允许或禁止时均复现，排除了这些组件作为复现的必要条件。另用同一 Swift 源在主线程和全局后台队列各执行一次，两次独立探针均在 15 秒到期。采样无法证明框架内部死锁、系统资源争用或权限故障的确切触发条件。前一阶段报告的 CPU 阶段尝试仍等待，本轮没有更改识别后端或系统权限。真实引擎通过记录与偶发超时同时成立。见 [历史采样记录](autonomous-development-progress.md)、[Apple Vision 计算设备说明](https://developer.apple.com/videos/play/wwdc2024/10163/)。
- **PASS（测试防卡死）**。真实引擎子进程设置 25 秒 deadline 并使用 SIGKILL 终止超时进程。超时仍导致用例失败。探测和编译也加了进程限额，识别、精度和离线断言保持原样。
- **BLOCKED（原生回退验收）**。应用现有 20 秒 UI deadline、取消和端上 Tesseract 回退有自动化覆盖。仍需在 WKWebView 实测回退、重新导入和多次运行后的资源情况。JS 停等本身无法终止已进入系统调用的 Rust blocking worker。参见 [桌面 OCR 实现](../../clients/universal/src/services/ocr/nativeEngines.ts) 和 [真实 Apple Vision 测试](../../clients/universal/test/ocr/appleVision.real.test.ts)。

## 6. 跨平台构建矩阵

所有客户端以 Tauri、Cargo 和 npm 的 `0.1.0` 为基线，Tauri 发布标识为 `com.billieweather.client`，发布 deep-link 为 `billieweather`。核对了主窗口的 Tauri capabilities、SQLite、按选择授权文件读取、CSP 和平台 OCR。签名材料、商店资料或实际生成的移动端权限仍需按平台复核。见 [Tauri 配置](../../clients/universal/src-tauri/tauri.conf.json)、[打包入口](../../clients/universal/scripts/tauri.mjs)、[Capabilities](../../clients/universal/src-tauri/capabilities/default.json) 和 [CI 构建定义](../../.github/workflows/universal-client.yml)。

| 平台 | 构建或集成结果 | 权限、打包与分发 | 发布建议 |
| --- | --- | --- | --- |
| macOS Apple Silicon | PASS，隔离 arm64 debug 和 optimized `.app` 构建，GUI 登录、SQLite 创建和实引擎有通过记录。原生导入与实引擎稳定性为 BLOCKED。 | 最初默认 bundle 的严格签名验证失败，显式 ad hoc 签名后 `codesign --verify --strict` 通过。直发需 Developer ID、notarization、stapling 和实际 `.dmg` 安装验收。最低 macOS 11 未实机验证。 | NO-GO |
| macOS Intel | BLOCKED，`cargo check --target x86_64-apple-darwin` 返回 E0463，缺少目标标准库。当前 CI 无独立 Intel job 或 Universal 合并目标。 | 若承诺 Intel 支持，需 Intel 或 Universal 包及在 Intel 上验证 Vision、Keychain、SQLite、升级和签名。 | NO-GO |
| Windows | BLOCKED，当前宿主无 Windows/MSVC 环境。CI 定义 NSIS/MSI 构建，本轮未执行。 | 需实际 WebView2、Credential Manager、文件授权、SQLite、离线 Tesseract 日常测试，核准安装器签名和版本升级。 | NO-GO |
| iOS | BLOCKED，Command Line Tools 缺少 iphoneos 和 iphonesimulator SDK。CI 定义实验性 arm64 模拟器。 | 完整 Xcode、生成工程最终 Bundle ID、签名团队/描述文件、Keychain/相机/照片权限及实际 Info.plist 待验。插件定义共享 Apple Vision，App Intents 集成需在生成工程确认。 | NO-GO |
| Android | BLOCKED，本机无 JDK、SDK/NDK 或模拟器。CI 中补齐 OCR 插件所需 API 36，YAML 静态校验 PASS。 | 检查生成工程的 applicationId、versionCode、权限、合并清单、ML Kit 离线能力及遥测行为。签名 AAB 和真实设备验收待完成。 | NO-GO |
| Web | PASS，Rails production-mode 资源预编译、Universal typecheck/Vite 构建、真实 Chromium 离线 OCR、本地 Rails 集成及回归。 | Rails 与 identity-api 部署设置和备份待批准核验。Rails 扫描件服务与 Universal 浏览器离线 OCR 是两条路径，Rails 文本 PDF 已回归，服务端 OCR 取决于部署时显式配置的本机命令。 | NO-GO |

发布打包应走注入明确 HTTPS Rails 与 identity origins 并更新 CSP 的构建入口。现有桌面 CI 调用裸 `tauri build`，作为 unsigned 工件，无法证明已带入发布目标。签名与打包参考 [macOS 签名](https://v2.tauri.app/distribute/sign/macos/)、[Windows Installer](https://v2.tauri.app/distribute/windows-installer/)、[App Store](https://v2.tauri.app/distribute/app-store/) 和 [Google Play](https://v2.tauri.app/distribute/google-play/)。

## 7. 本地数据库迁移验证

**PASS（PostgreSQL 14.24）**。启动一次性集群并在空开发库执行历史迁移至 `20261124000100`，Rails 测试库从提交中的 schema 加载。升级增加可空 UUID `updated_by_device_id` 和按用户与 mutation UUID 唯一的重放记录表。新表外键级联对应用户删除。另以专用开发库中的可回滚事务完成以下验证。

- 走旧 schema 的 Web 偏好写入，再迁移 up。旧偏好的用户、模块、选择、修订号和时间戳完全相等，新设备字段为空。旧 Web 写入在新 schema 中成功并正常递增修订号。
- 同一账号与 UUID 的重复写入命中唯一约束。回滚 savepoint 后已写重放记录仍在，事务可继续。完整回归覆盖首次同步确认、部分冲突、离线重启、请求重放、跨账号隔离和丢弃迟到响应。
- down/up 逐字段保留旧偏好，合成交易金额和其余行内容完整保留。down 移除设备标记与重放记录表，重新 up 后该表为空。外层事务回滚后不含探针数据，迁移标记仍是 up，未验证约束和无效索引均为 0。重复 `db:migrate` 无待执行迁移。
- 本地 `pg_dump -Fc` 和空库 `pg_restore --single-transaction` 通过。源库与恢复库都返回 1 个合成用户、0 笔已持久化交易、0 条偏好、162 条 Rails 迁移、2 条 identity 迁移，索引和约束异常均为 0。带交易的保护由上一项事务探针验证。
- Rails 与 identity-api 的独立探针分别实连同一个本地库并确认走 socket。identity 的两项 additive schema migration 已执行并通过兼容检查。identity 的完整跨栈测试在另外一个仅有合成记录的测试库运行。

见 [迁移源码](../../db/migrate/20261124000100_add_module_preference_sync.rb)、[同步实现](../../app/services/finance/module_preference_sync.rb) 和 [隔离启动器](../../bin/billie-local)。

## 8. Neon 环境状态

| 检查 | 状态 | 结果 |
| --- | --- | --- |
| Phase 5 Rails 与 identity-api 数据库目标 | PASS | 同一专用 PostgreSQL Unix socket 和本地数据库，经实际连接确认。 |
| 旧开发服务的生产隔离 | FAIL | 原 Rails `:3000` 的 pooled URL 与 direct URL、原 identity-api `:8100` 的 pooled URL 属于同一 Neon endpoint 家族和同一数据库。读取控制平面分支及 endpoint 元数据后确认配置映射到默认 `production` 分支。原服务未经 QA 调用。 |
| 现有 Neon 分支调查 | PASS | 只读元数据显示 `production` 及其子分支 `migrate-test-nickname`。未见该子分支用于此次 QA 的批准、synthetic-only 或 schema-only 证明。 |
| Neon 上迁移、回滚及运行时验证 | BLOCKED | 无已批准且确认隔离的测试分支。本轮只查询控制平面元数据。 |
| Render Rails 与 identity-api 实例的实际数据库目标 | BLOCKED | 蓝图依赖 Dashboard 注入。需要通过拥有只读访问权限的 Render 管理入口核对服务、分支和数据库，以及 pooled/direct 对应关系。 |

发布前应冻结所有旧开发服务的生产接入，并移除开发环境中的生产 DDL 凭据。批准的 Neon 验收应采用隔离分支和合成数据。常规访问用 pooled URL，授权 DDL 和备份用同一分支的 direct URL。见 [Neon 连接方式](https://neon.com/docs/connect/choose-connection)。

## 9. Render 部署审计

**FAIL（当前仓库的自动数据库写入门禁）**。采用只读审计范围。未执行 Render 命令，未修改蓝图或实际设置。

| 项目 | 状态 | 核验结果 |
| --- | --- | --- |
| Rails build | FAIL | 蓝图执行 `RUN_MIGRATIONS=1 ./bin/render-build.sh`。脚本在 Corepack/Yarn、Bundler 和资源预编译后运行 `rails db:migrate` 与 `db:seed`。Shell 实测变量未设置时跳过，设成 `0` 仍执行。根蓝图未声明关闭自动部署。 |
| identity-api build 与 start | FAIL | 构建以 uv 冻结依赖。每次 start 先执行 `identity_api.schema migrate`，再起 Uvicorn。服务的 `autoDeploy: false` 无法阻止人工部署和启动触发 schema 写入。 |
| 数据库与运行身份 | BLOCKED | 两服务均依赖手工注入的 `DATABASE_URL`。Rails schema task 在提供 `DATABASE_URL_UNPOOLED` 时使用直连，该变量未在根蓝图声明。实际目标、角色 DDL 权限和备份恢复窗口均未获证。 |
| Rails 依赖与健康 | PASS（定义和本地） | Puma，Redis Key Value 来源为蓝图内部服务，生产 Active Job 最终配置为 inline。应用 `/up` 本地 200，属于进程启动检查，根蓝图未配置 HTTP health path。发布应另验证 DB/Redis 和带鉴权的 smoke。 |
| identity-api 依赖与健康 | PASS（定义和本地） | Uvicorn `$PORT`，蓝图 `/health`，本地返回 `status=ok` 与空问题列表。启动检查覆盖 Rails 和 identity schema。 |
| 运行密钥与外部依赖 | BLOCKED | Rails 需核对 `SECRET_KEY_BASE`、凭据解密配置（如需 `RAILS_MASTER_KEY`）、DB/Redis、对外 URL、邮件和可选 Google OAuth。identity 需核对 `TOKEN_HMAC_KEY`、HTTPS `PUBLIC_URL`、Postmark token 与 `MAIL_FROM`、CORS、代理及可选 Google OAuth。Rails Redis initializer 和 Sidekiq TLS 设有 `VERIFY_NONE`，若实际使用 TLS，需验证证书策略及连接路径。 |

发布门禁应让普通 build/start 仅编译或启动，应用运行角色无 DDL 权限，受批准的数据库步骤使用独立身份。Render 的付费 pre-deploy 能力不是此次上线的前置授权。采用 free plan 时，可通过受控的独立迁移步骤实施相同门禁。Render 回滚会复用旧 artifact、启动命令和部分环境配置，旧 identity 启动命令可能重新运行迁移，需在批准回退前核对。见 [Rails 蓝图](../../render.yaml)、[构建脚本](../../bin/render-build.sh)、[identity 蓝图](../../services/identity-api/render.yaml)、[Render 部署](https://render.com/docs/deploys) 和 [Render 回滚](https://render.com/docs/rollbacks)。

## 10. 回归与安全结果

| 命令或测试组 | PASS | FAIL | SKIP | TIMEOUT | NOT RUN | 结果 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Rails 全套 | 819 | 0 | 2 | 0 | 0 | 821 项、31,050 断言、0 error、行覆盖率 92.44%。 |
| Universal 最终全套 | 928 | 0 | 0 | 0 | 0 | 73 个测试文件。包含真实 Chromium、Node Tesseract、12 项真实 Swift Vision 和 2 项新本地化回归。 |
| Apple Vision Swift 专项先前运行 | 12 | 0 | 0 | 0 | 0 | 该组也在最终 Universal 全套中执行。 |
| Rust arm64 更新前全套 | 20 | 0 | 0 | 0 | 0 | 包括真实 Swift FFI、SQLite 原子性、外键和升级前快照。 |
| Rust arm64 最后一次更新后全套 | 19 | 0 | 0 | 1 | 0 | 唯一超时为苹果 FFI。另一次全套结果相同，两个独立 FFI 探针也分别超时。 |
| identity-api 全套 | 126 | 0 | 0 | 0 | 0 | 启用真实 Rails 兼容探针。1 个 Starlette 弃用警告。 |
| 早期诊断 CLI，联网和禁网 | 0 | 0 | 0 | 2 | 0 | 各超过 12 秒并采样后终止，未计入 suite。 |
| Vision 稳定性复试 | 9 | 0 | 0 | 0 | 0 | Swift 直跑、禁网和 Rust FFI 各三次。 |
| Swift 主线程与后台线程诊断 | 0 | 0 | 0 | 2 | 0 | 同一识别源，主线程和全局后台队列各超过 15 秒。 |
| 独立收据/PDF 识别及下游解析 | 2 | 0 | 0 | 0 | 0 | 真实 Apple Vision、合成图片和双页扫描 PDF。 |

表中以最终完整运行计数。首轮未指定 Chromium channel 时，Universal 为 901 通过、13 跳过，随后以本机 Chrome 重跑，13 项全部通过。早期 Rust 排除阻塞风险时为 19 通过、1 过滤，随后专项和全量各有通过记录。最终依赖组合的两次完整重试均停在 FFI。identity 的初次 socket URL 有 94 个 fixture setup error，修正后一次整套运行只剩 1 个 Rails 子进程失败。两处修正后，最终全套 126 通过。Rails 的 2 个既有跳过保留。未执行的平台 build、原生业务路径和生产 smoke 不计入自动测试总数，见第 2–6 节。

会计口径、退款/转账、导入幂等、并发事务回滚、本机 SQLite、Postgres 约束、跨设备模块偏好冲突和账号切换、鉴权及租户隔离通过相应回归。Default / Manual、Feature Library 和中英文通过 Rails/Universal 测试。本轮也在签名 QA 包中复核原生语言、主题、界面模式以及功能库重启持久化。跨设备冲突的原生验收记录来自 Phase 1b，本轮使用隔离服务完成相关自动化回归。见 [进度与历史验收](autonomous-development-progress.md)。

### 依赖项审计

- **PASS**，Ruby Advisory DB 对原锁文件报告 8 项。更新 Doorkeeper、Puma 和 Rack Protection 后，复扫为 0 项。Universal `npm audit --omit=dev` 报告 0 项。基于 identity-api 冻结生产依赖的 `pip-audit` 扫描 32 个包，0 项公告，0 跳过。见 [Ruby Advisory DB](https://github.com/rubysec/ruby-advisory-db)。
- **FAIL（Rails 前端构建依赖扫描）**，Yarn 报告 3 项中等安全公告及 1 条图标包 deprecation。命中的 `glob`、`minimatch` 和 `postcss-selector-parser` 位于构建链。需要在维护依赖的变更中复核升级和资源构建。见 [glob 公告](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)、[minimatch 公告](https://github.com/advisories/GHSA-g3hv-75wg-m249) 和 [PostCSS 公告](https://github.com/advisories/GHSA-rj75-hqrm-r3gf)。
- **FAIL**，RustSec 初扫报告 4 项漏洞。更新 `cookie` 和 `url` 后复扫仍有 2 项。当前 Apple Silicon 依赖树中 `rsa` 未启用，其他目标留待核对。`libsqlite3-sys 0.30.1` 在启用的 SQLite 依赖树内，捆绑 SQLite 3.46.0。dry-run 确认 SQLx 0.8.6 要求 `^0.30.1`，与修复版 `0.39.0` 不兼容。Tauri SQL 2.6.0 和专用 SQLite 事务接口共用 SQLx 0.8，升级需兼容的 Tauri SQL、SQLx 及全部原生平台验证。未改动恢复格式或替换底层 SQLite 驱动。另保留 5 项 unmaintained 和 1 项 unsound 警告作为后续依赖审查输入。见 [SQLite 公告](https://rustsec.org/advisories/RUSTSEC-2026-0459.html)、[RSA 公告](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)、[cookie 公告](https://rustsec.org/advisories/RUSTSEC-2026-0594.html) 和 [URL 公告](https://rustsec.org/advisories/RUSTSEC-2026-0592.html)。

## 11. 修复与本地提交

| 提交 | 修复和验证 |
| --- | --- |
| `3f99016` | Apple Vision 实引擎测试的同步子进程此前可越过 Vitest timer 一直等待。为探测、编译和识别增加实际子进程 deadline。identity QA 兼容正确的 Unix socket URL，按 libpq 生效字段拒绝远程 host、hostaddr 和 service，新增 9 个守卫回归。Rails 互操作改用 `mise which ruby` 选出的可执行文件，规避 macOS 系统 Ruby。最终 Swift 12/12、identity 126/126。 |
| `e655b2d` | Android CI 显式安装 OCR 插件的 API 36 compile SDK，保留原 API 34。解析 YAML 并核对 Gradle `compileSdk` 与 CI 包清单。实际 Android build 仍为 BLOCKED。 |
| `7e58874` | 修复切换语言后账户保存回执显示旧语言。异步写入保存结果状态，由当前语言渲染成功及失败消息。两条针对性用例先复现后通过，功能库和个性化定向套件 37/37，最终 Universal 928/928。最终原生截图复验因无障碍连接超时受阻。 |
| `182041e` | Doorkeeper `5.9.10`、Puma `8.1.2`、Rack Protection `4.2.2`、Rust `cookie 0.18.3` 和 `url 2.5.9`。Rails 定向 41/41、全套 819 通过和 2 跳过、identity 126/126。Rust 非 FFI 19/19，FFI 稳定性仍受系统等待阻塞。 |

## 12. 剩余阻塞项

1. **BLOCKED**，Apple Silicon 原生 receipt/PDF 验收未完成。需可操作的本地桌面会话，完成文件交付、交易确认、SQLite 检查、重复导入、错误恢复、取消重试及本机 OCR 回退。
2. **BLOCKED**，Apple Vision 间歇性等待仍存在。需在发布候选包上观察重启后的首个识别、多页、断网和连续重试，并明确处理标准和可证明的回退。
3. **FAIL**，Render 蓝图仍在常规 build/start 引发 DDL，Rails 还执行 seed。需要已批准的独立数据库发布门禁、运行角色和回退演练。
4. **BLOCKED**，Neon 隔离分支和 Render 实际 targets、运行角色、备份点未确认。旧开发服务的 DB 目标映射到 `production`。
5. **BLOCKED**，Intel、Windows、iOS、Android 平台构建、签名、真实运行及权限没有通过证据。macOS 正式签名和发布通道也待验证。
6. **FAIL**，原生包仍携带 RustSec SQLite 公告对应的依赖。发布前需要兼容的修复版本，或由负责人审查实际可达路径并书面接受风险。

## 13. 发布检查清单

- [x] 固定本地基线和独立工作树，验证两项 QA 服务实际连接到专用 PostgreSQL。
- [x] 本地迁移、向后兼容、回滚、重放失败恢复、备份恢复和回归。
- [x] 记录原生 GUI、真实 OCR 引擎、SQLite 及平台构建的证据边界。
- [ ] 每个支持平台完成带核准端点和权限的发布候选包测试，验证安装、更新及签名。
- [ ] 在可用的 macOS 桌面会话中完成收据和扫描 PDF 的原生预览、取消、重试、明确确认及持久化检查。
- [ ] 完成原生 SQLite 公告处置和跨平台数据库备份、恢复与升级回归。
- [ ] 核准专用 Neon 验收分支及数据范围，演练直接连接的迁移、重放和恢复。核对生产数据库及分支映射。
- [ ] 验证 Render 运行角色无 DDL 权限，普通 build/start 无迁移与 seed，核对两个服务实际命令、Auto-Deploy 和健康检查。
- [ ] 核实恢复点、恢复窗口、恢复责任人和回退 artifact，再单独审批生产数据库变更与部署。

## 14. 回滚与恢复计划

- 优先通过 `BILLIE_MODULE_SYNC=0` 关闭服务端同步。下一次客户端构建可用 `VITE_BILLIE_MODULE_SYNC=0` 禁止后台同步。保留新列、重放记录和现存偏好，等队列排清与一致性检查通过，再处理结构回退。
- Render 回到上个健康版本前，核对旧 start command、artifact、环境组和凭据。对 Rails 做 `/up` 及 DB/Redis smoke，对 identity 做 `/health` 和合成登录链路。旧启动命令含迁移时，应先确保运行角色无 DDL 权限。
- DB 变更前记录批准的 Neon 项目和分支、备份时间、可恢复时间窗、受控直连角色及恢复演练结果。按合规要求验证备份可读及跨服务兼容，而后才批准迁移。异常时保留交易、导入记录和审计数据。仅在明确批准并确认重放影响后评估结构 down 或恢复。见 [Neon Instant Restore](https://neon.com/docs/postgres/backup-restore/branch-restore)。
- 客户端回退前保留 SQLite 与原备份，验证旧版本的兼容路径和恢复读取。原生事故中保留用户已确认的记录，按交易和导入 ID 对账，避免重复或遗漏。

## 15. 发布建议

| 平台或环境 | 建议 | 提升条件 |
| --- | --- | --- |
| Apple Silicon 隔离 QA | CONDITIONAL GO | 可继续合成数据和包级验收。Apple Vision 波动及原生导入完整路径仍需确认。 |
| macOS Apple Silicon 生产 | NO-GO | 补齐两条原生 E2E、故障回退、SQLite 公告处置、正式签名与实际安装。 |
| macOS Intel 生产 | NO-GO | 明确支持范围并通过目标构建、签名和实机验收。 |
| Windows 生产 | NO-GO | WebView2、安装器、文件权限、端上 OCR、存储和升级验收。 |
| iOS / Android 生产 | NO-GO | 完整工具链、生成项目与权限检查、真机端上 OCR、签名和商店准备。 |
| Web / 后端生产 | NO-GO | 关闭 Render 自动 schema 写入，核对真实发布配置和受批准的 Neon 验收与恢复。 |

生产环境未部署，未执行生产 DB SQL，未创建云资源，未推送或合并。原工作树、已安装应用和用户备份未被覆盖。Phase 5 临时服务已关闭，合成数据和诊断记录留在本地用于复核。
