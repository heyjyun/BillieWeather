# BillieWeather / FinRx Phase 5.1 发布阻塞修复报告

2026-11-24 · `autonomous-development` · macOS 27.2.1（26B131），Apple Silicon

## 1. 执行摘要

**Apple Silicon macOS 生产发布为 NO-GO，隔离合成数据 QA 为 CONDITIONAL GO。Web 与后端生产发布为 NO-GO。** 签名 QA 包内的 SQLite 已升至 3.54.1。Render 的构建和启动路径已与数据库迁移分离，隔离 PostgreSQL 演练通过。原生文件选择仍未完成。Apple Vision 的等待已限制在可终止的子进程内，真实 Rust 识别仍出现过超时，最终复跑通过。Render 和 Neon 线上验收保持 BLOCKED。

工作从干净的 `billieweather-roadmap` 工作树和 `1ca5552` 开始。历史提交与原工作树的分支、未提交改动均已核对。此次工作只使用本地工作树、合成账户、合成文件、独立 PostgreSQL socket 和独立应用 Bundle ID。参见 [Phase 5 报告](phase5-release-readiness-report.md)。

## 2. 各阻塞项根因

| 阻塞项 | 结论 |
| --- | --- |
| SQLite P0 | **PASS（arm64）**。Tauri SQL 和 Rust 事务接口共同使用 SQLx 0.8.6。其绑定锁在 `libsqlite3-sys 0.30.1`，上一期 arm64 QA 二进制确实嵌入 SQLite 3.46.0。 |
| Render / Neon P0 | **PASS（本地）**。旧 Rails 构建以变量是否存在决定迁移和 seed，旧 identity start 显式执行迁移。Rails 的旧 Rake hook 可以替换本地命令的 URL。两服务的新路径独立于迁移，且启动会验证数据库和角色。**BLOCKED（云端）**。 |
| macOS 文件选择 P1 | **BLOCKED**。正常匹配类型的 PNG 在真实 Open 面板中高亮后，Open 仍灰显。界面自动化随后失去窗口。根因仍可能在 AppKit 文件面板生命周期、模态窗口或自动化对独立系统进程的操作之间，现有观察不足以归因。 |
| Apple Vision P1 | **PASS（时限、取消和资源回收）**。**FAIL（真实 Rust FFI 稳定性）**。三个旧路径采样都进入 Vision 的 ANE 模型编译等待。无 Rust 的 Swift 进程也复现，具体系统触发条件尚未确定。 |

## 3. SQLite 安全修复

- 公告 **RUSTSEC-2026-0459 / CVE-2026-119375** 涉及 SQLite 3.54.0 之前的 WAL 页面缓存信息泄露。绑定 0.6.0–0.38.2 的 bundled 引擎受影响，0.39.0 开始包含修复。旧二进制含 SQLite 3.46.0 的 source ID，未链接系统 SQLite。定位到嵌入库和实际使用的 SQLx 依赖链。参见 [RustSec 公告](https://rustsec.org/advisories/RUSTSEC-2026-0459.html)和 [SQLite 3.54.1](https://www.sqlite.org/releaselog/3_54_1.html)。
- SQLx 0.8.6 的约束无法解析到修复版绑定。稳定 Tauri SQL 2.6.0 仍使用 SQLx 0.8，Tauri SQL 3 alpha 也仍用 0.8 并要求 Tauri 3 alpha。系统动态链接会把安装包安全性交给目标机器。本次采用 crates.io 发布的原版 Tauri SQL 2.6.0 作为可追溯的本地补丁，升级两个调用方到 SQLx 0.9.1 和 `libsqlite3-sys 0.40.0`。补丁适配 SQLx 0.9 的 SQL 字符串 API。迁移正文、校验和、数据库路径、Tauri IPC、权限和前端 API 沿用原契约。项目声明的最低 Rust 版本调整为 1.94。参见 [补丁来源与退出条件](../../clients/universal/src-tauri/vendor/tauri-plugin-sql/README.md)。
- 最终优化 arm64 QA 包通过 `codesign --verify --strict`。执行包内二进制的 `--sqlite-version` 返回 **3.54.1**，source ID 为 `2026-10-16 14:45:20 555e07ef33f69a0957d24d8e555b702464a131d6f1607f4c3c1e4551e8e6ca76`。`otool -L` 没有 SQLite 动态依赖，Rust 测试从同一引擎执行 `SELECT sqlite_version()` 与诊断值一致。最终签名二进制 SHA-256 为 `f16c963733d5fb53f2183a6467e089724956728f9360e75a114d548e7a820ac1`。
- 8 个数据库槽从零应用全部 9 项迁移。升级测试使用旧软件记录的第一项 SQLx 校验和及带合成交易的既有结构，应用剩余迁移并重跑。保留原迁移记录和账单关联，合成金额 `-1025` 分保持精确，完整性检查 `ok`，外键违规 0。Rust 事务测试验证原子回滚、精确整数读写和一致快照。全套 Universal 覆盖导入、去重、交易类型和恢复逻辑。参见 [SQLite 槽与升级测试](../../clients/universal/src-tauri/src/lib.rs)和 [原生事务测试](../../clients/universal/src-tauri/src/transaction.rs)。
- RustSec 在最终锁文件报告 **0 项漏洞**。旧 RSA 条目已退出锁文件。保留 5 项 unmaintained 和 1 项 unsound 告警，分别涉及 chrono、proc-macro-error、zbus_names、zvariant、zvariant_derive 和 glib，后续随对应平台复核。

## 4. Render 迁移安全

- 两份 Blueprint 都关闭自动部署，并声明 HTTP 健康检查。Rails 构建使用无凭据的本地占位 URL 预编译资源，旧 `RUN_MIGRATIONS=1` 对构建没有迁移作用。Rails 正常启动先检查目标、权限与待执行迁移，再启动 Puma。identity 的启动只启动 Uvicorn，缺 schema 时健康检查返回 503。Docker 启动和旧 Procfile 自动迁移入口也已调整，开发容器把准备步骤改为单独执行。
- 明确的发布入口为 `bin/billie-release rails` 和 `bin/billie-release identity`。发布过程要求批准引用、direct URL、允许的环境、独立验证的 hostname、database 和服务器侧目标标识。Neon 连接要求 `sslmode=verify-full`。常规运行角色不能拥有应用数据库结构或切换到相关高权限角色。开发和测试拒绝生产 URL、远端 host 及 libpq 路由覆盖。参见 [发布与恢复手册](render-neon-release-runbook.md)、[Rails Blueprint](../../render.yaml)和 [identity Blueprint](../../services/identity-api/render.yaml)。
- **PASS（PostgreSQL 14.24）**。从 Phase 1a 合成备份的 161 项 Rails 历史开始。待执行迁移、缺批准、错误数据库标识及具有 DDL 权限的运行角色均使检查失败。按顺序执行批准命令后，Rails 记录 162 项，identity 记录 2 项。重跑没有应用新迁移，未验证约束和无效索引均为 0。合成交易 `-10.25`、归属、日期和原偏好行逐字段对比迁移前后的备份恢复结果一致。使用 `pg_dump -Fc` 和隔离空库上的 `pg_restore --single-transaction` 验证备份可恢复。
- **PASS（本地启动和 smoke）**。Rails `/up` 为 200，合成会话端点为 201，Redis 返回 PONG。identity 使用冻结锁文件构建生产依赖，其 `/health` 为 200。对缺 identity schema 的恢复库启动同一服务命令时，`/health` 返回 503，查询确认 schema 仍不存在。只含合成记录的 Rails 和 identity 本地部署测试在最终复测中均绑定 `127.0.0.1`。首轮 Puma 使用配置默认的通配监听，发现后即停止，复测使用显式 `PUMA_HOST`。
- **NOT TESTED（容器镜像）**。本机无 Docker CLI，已用 Bash 语法检查和真实 Rails 数据库重现验证开发容器使用的检查命令。待迁移库退出 1，已迁移库退出 0。

## 5. Neon 环境

| 验证 | 状态 | 结果 |
| --- | --- | --- |
| 本机 QA 与发布演练 | PASS | Rails、identity 与发布命令均指向专用 PostgreSQL socket，通过实际数据库名、角色和目标标识检查。 |
| 旧开发服务的生产接入 | FAIL（Phase 5 已确认） | 历史控制平面证据显示旧开发配置指向生产分支。此次使用独立服务与合成数据，旧工作树和服务未修改。 |
| 现有分支的身份和隔离 | BLOCKED | Phase 5 记录生产分支及 `migrate-test-nickname`。本次只读 CLI 未给出可核验的结构化项目结果，现有测试分支也缺少隔离和数据范围批准。 |
| Render 注入值、角色、Neon 恢复点 | BLOCKED | 尚无两服务实际数据库目标、TLS 信任、低权限角色和备份窗口的获批验收。没有执行云端 DB SQL 或创建 Neon 分支。 |

## 6. macOS 文件选择

- **FAIL（复现）**。在独立签名的 Phase 5 QA 包中用合成账号登录，创建独立账本，进入 Add & Sync 和收据页。系统面板把合成 `new.png` 显示为普通 PNG 并高亮，`OKButton` 仍 disabled。同目录中不允许的 CSV 显示为灰色，说明扩展过滤在这次观察中已生效。Escape 成功关闭面板。
- 已复核扩展、文件类型、动态读权限和生命周期。Tauri `open` 的多选、目录和扩展配置符合公开 API。Tauri 对返回的路径授权发生在选择完成之后。QA 签名无 App Sandbox entitlement，现有能力没有目录范围放宽。系统 Open 面板由独立进程绘制。RFD 0.17.2 的 Open 路径使用旧的扩展过滤 API，已检查的 RFD 0.18.0 也沿用该 Open 路径。无法由此证明扩展、UTI 或授权导致灰显。参见 [Tauri Dialog](https://v2.tauri.app/plugin/dialog/)和 [Apple NSOpenPanel](https://developer.apple.com/documentation/appkit/nsopenpanel)。
- **BLOCKED（隔离对照）**。在 Downloads 中放了可读的合成 PNG、损坏图片和扫描 PDF。对临时目录的实际双击操作返回 `noWindowsAvailable`。键盘“前往文件夹”未成功切换面板。使用显式 PNG/PDF UTI 和无过滤选项的签名 AppKit 控制程序，以及 Phase 5.1 QA 包，在应用路径、Bundle ID、重连和重置会话后均未获得可操作窗口。没有足够证据支持更换选择器或扩大权限。Downloads 内的文件交付仍待真实桌面确认。

## 7. Apple Vision 与 Rust FFI

- 旧 Rust 路径 **3/3 在 12 秒截止时仍挂起**，采样后终止。三份采样进入 Vision TextRecognition、Espresso 和 ANE 的 `compileModel` 等待。使用同一 Swift 源，显式 macOS 11 编译目标和默认目标各复跑两次，**4/4 在 12 秒超时**。独立 Swift 过程可以复现，与 Phase 5 的线程及 CPU 设备实验相符。完整 Universal 套件也有实际 Swift 识别通过记录，表明现象会随运行条件变化。参见 [Apple Vision 计算设备 API](https://developer.apple.com/documentation/vision/vnrequest/setcomputedevice%3Aforcomputestage%3A)。
- macOS 由签名应用二进制启动独立 Vision worker。图片经有界管道传递，worker 打开 OCR 请求时无需账本或钥匙串。Rust 最多并发一个 Vision worker，在 18 秒内获取结果。取消、截止和协议失败会终止并回收子进程。WebView 原有 20 秒等待上限仍保留。遇到原生截止时，可把整批交给现有端上 Tesseract。保护不依赖延长超时或无界重试。参见 [进程监督](../../clients/universal/src-tauri/src/ocr/vision_process.rs)与 [客户端回退](../../clients/universal/src/services/ocr/nativeEngines.ts)。
- **PASS（资源与异常输入）**。调度回归验证取消先到、并发请求拒绝、结束后可接收新任务。正常取消和超时强制结束后，均确认实际子进程已退出。签名优化包对损坏输入快速返回 `decode_failed`。**FAIL（真实扫描）**。两次此前的 Rust 全套和 3 次专项复试均发生真实 FFI 超时。签名 debug worker 的断网实测覆盖 3 次英文账单、1 张收据、1 张中文样本和两页 PDF 渲染图，**7/7 超时**。早一版优化包断网实测也超时。最终优化包断网查验 4 次账单均成功，其中首次 14.46 秒，随后 0.43–0.51 秒。最终 Rust FFI 在损坏输入后成功识别账单，13.72 秒。最终成功记录表明引擎可恢复，稳定性仍为 FAIL。WKWebView 回退仍待验。

## 8. 原生收据与 PDF 端到端

| 验收 | 收据 | 扫描 PDF |
| --- | --- | --- |
| 选择并确认真实文件 | BLOCKED，PNG 选中后 Open 灰显 | BLOCKED，本轮未成功交付 PDF，有 Phase 5 灰显复现 |
| Tauri 授权读取与页面处理 | NOT TESTED | NOT TESTED |
| 原生 OCR、回退、字段核对 | BLOCKED（GUI），最终签名 worker 通过独立抽取 | BLOCKED（GUI），最终签名 worker 通过两页独立抽取 |
| 导入前审阅、明确保存、重试、重复导入 | NOT TESTED（文件面板 Escape PASS） | NOT TESTED |
| 原生 SQLite 持久化 | NOT TESTED | NOT TESTED |

最终签名优化包在断网沙箱中实际识别收据和两页 PDF 渲染图。输出经现有业务管线解析，收据商家为 `QA SYNTHETIC MARKET`、日期为 `2026-11-20`、金额为 `USD 10.25`。PDF 8/8 行的日期和带符号金额正确，7 行可确认，1 行待审阅，0 行错误标为可确认，在待审阅行未处理时 `committable=false`。独立回归还覆盖真实 Chromium 离线 OCR、收据匹配、人工确认前零写入和保存幂等。Phase 5 QA 账本在本轮只读复核为 0 笔交易、0 个账单、完整性 `ok`、0 外键违规。参见 [真实 Chromium OCR](../../clients/universal/test/ocr/browser.real.test.ts)、[收据回归](../../clients/universal/test/receiptCapture.test.tsx)和 [PDF 审阅回归](../../clients/universal/test/pdfReviewPage.test.tsx)。

## 9. 修改及本地提交

| 提交 | 主要文件与变更 |
| --- | --- |
| `33a4c40` | 两项 Render Blueprint、Rails/Docker 启动和构建脚本、数据库目标校验、identity 迁移入口、发布运行手册及回归测试。 |
| `48f1980` | Rails 前端 `package.json` 和 `yarn.lock`。Sucrase 更新至 3.35.1，移除命中公告的 glob 10 和 minimatch 9。Typography 使用同主版本修复后的 selector parser 6.1.6。 |
| `a93e691` | Rust 依赖与锁文件、应用 SQLite 诊断、升级回归、可追溯的 Tauri SQL 补丁。 |
| `8ea4c3d` | macOS Vision worker、取消和截止协议、Rust 资源与 FFI 测试、Universal 回退测试。 |
| `e57d4c5` | 开发 Docker 启动改为检查迁移状态，文档明确本地初始化步骤。 |

## 10. 回归结果

| 项目 | 状态 | 结果 |
| --- | --- | --- |
| Rails 全套 | PASS | 821 项，819 通过、2 既有跳过、0 失败、0 错误，31,050 断言。额外数据库目标回归 3/3、10 断言。 |
| identity-api 全套 | PASS | 128/128，包含真实 Rails 互操作和目标守卫，1 项 Starlette 弃用告警。 |
| Universal 最终源全套 | PASS | 73 文件、929/929，0 跳过，包含 Chrome 离线 OCR、Node Tesseract 和 12 项真实 Swift Vision。TypeScript 检查通过。 |
| Rust arm64 library | PASS | 22/22，包含 SQLite 升级、事务、快照、并发和 worker 清理。 |
| Rust arm64 完整 suite（最终） | PASS | 23/23，包含 1 项真实 FFI，0 跳过。 |
| Rust arm64 真实 FFI 稳定性 | FAIL | 此前两次全套各 22 通过、1 超时，另有 3 次真实 FFI 专项复试超时。 |
| Rails 前端审计及构建 | PASS（已列安全公告） | 三项安全公告消失，构建成功。审计仍报告图标包、旧开发工具链 glob 和 inflight 的三条弃用记录。 |
| Ruby 依赖审计 | PASS | 独立 `bundler-audit` 使用本机 Ruby Advisory DB 复查，0 项漏洞。 |
| Universal 生产依赖审计 | PASS | `npm audit --omit=dev` 报告 0 项漏洞。 |
| Rust 依赖审计 | PASS（漏洞） | 0 项漏洞。6 条维护及健全性告警保留。 |

全量回归覆盖交易、转账与退款、收据匹配、重复识别、导入幂等、账户隔离、离线使用、功能库持久化、跨设备偏好同步冲突与重放，以及 Default / Manual 和中英文界面。原生包中的这些交互没有在本轮获得完整复测。

过程记录包括首次 Rails 回归误启全局同步开关导致 7 项功能库失败，按默认设置复跑通过。identity 初次与 Rails 共用测试库出现 1 次 fixture 锁冲突，分库后通过，另一次未启用互操作标志造成 1 项跳过，最终已执行。Universal 初次分组运行排除 12 项 Swift 用例并触发 1 条隐私断言，去掉 Rust 输出宏后全量通过。部署的早期演练纠正了 Rails release task 加载前需要的 URL、identity 的 CORS 测试配置，以及历史 SQL 探针缺失原始描述的字段。按正确条件复跑。Ruby 审计的两次初始命令未找到 gem，使用隔离安装的审计工具完成复查。未将这些初始失败计入最终通过次数。

## 11. 剩余风险

- **BLOCKED**，原生收据和 PDF 缺少可操作桌面上的选择、读取、回退、审阅、确认和持久化证据。GUI 障碍与 Apple Vision 不是同一项验收。
- **FAIL**，真实签名 macOS worker 的有效图片仍可在 Vision 内超时。隔离保障进程回收，签名包真实引擎恢复及 Tesseract 回退仍需实测。
- **BLOCKED**，实际 Render 命令、环境组、Neon endpoint/分支、运行角色、备份恢复窗口和授权发布凭据未在获批云环境验证。常规启动无法依赖本地演练证明生产连接配置。
- **BLOCKED**，macOS 正式签名、公证、stapling、安装和旧版本升级未验。其余原生平台的 SDK、权限、安装程序及设备验收待完成。

## 12. 各平台发布评估

| 平台 | 验证状态 | 生产建议 |
| --- | --- | --- |
| macOS Apple Silicon | PASS，优化 arm64 QA 构建、ad hoc 签名和包内 SQLite 3.54.1。FAIL，真实 FFI。BLOCKED，原生导入和正式分发。 | **NO-GO**。合成数据隔离 QA 为 **CONDITIONAL GO**。 |
| macOS Intel | BLOCKED，`cargo check --target x86_64-apple-darwin` 返回 E0463，缺目标标准库。实机未验。 | **NO-GO**，排除出本次候选范围。 |
| Windows | NOT TESTED，当前宿主无 Windows/MSVC 和 WebView2 实机。 | **NO-GO**，排除出本次候选范围。 |
| iOS | BLOCKED，仅安装 Command Line Tools，缺完整 Xcode SDK 和设备环境。 | **NO-GO**，排除出本次候选范围。 |
| Android | BLOCKED，无可用 JDK、SDK/NDK 或模拟器。 | **NO-GO**，排除出本次候选范围。 |
| Web / 后端 | PASS，构建、回归和隔离部署演练。BLOCKED，Render 与 Neon 真实环境。 | **NO-GO**，云端审批与验收单独进行。 |

## 13. 发布候选就绪度

Apple Silicon 可继续使用隔离 QA 包。正式候选仍需实机完成两条原生导入路径，测实 Apple Vision 截止后的回退，然后使用批准端点、正式签名及可核验的安装和升级流程。Web 与后端可继续本机复核，云环境放行由实际目标、权限和恢复演练决定。本次没有推送、合并、部署、访问生产财务数据或替换已安装的 BillieWeather。临时服务和 PostgreSQL 已停止。合成数据、命令结果和 ANE 采样保留在 `/private/tmp/billie-roadmap.DKiqZpZs`。

## 14. 剩余外部批准

1. 批准可操作的 macOS 桌面验收，以及正式 Developer ID、签名、公证、stapling 和分发验证。
2. 批准仅含合成数据的 Neon 隔离分支、成本范围及 Render 只读配置核验。审查实际 TLS、DB 目标标识、运行角色和旧开发服务凭据。
3. 批准数据库恢复点、备份保留、恢复负责人、DDL 变更单与分阶段部署范围。生产数据库操作和发布保留为单独授权。
