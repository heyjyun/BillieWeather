# BillieWeather / FinRx 自主开发进度

## 2026-11-24 · 验收基线与环境

- Phase 0.5 / 1a 已验收，证据见 [Phase 1a 验收报告](phase0.5-phase1a-implementation-report-2026-11-23.md)。独立工作树分支为 `autonomous-development`，基线提交为 `d3061e4`，原工作树有用户的未提交改动。
- 原 :3000 和 :8100 开发服务仍指向同一 Neon 生产端点。独立工作树复制已验收代码和已安装构建依赖，本地工具 `bin/billie-local` 初始化专用 PostgreSQL。工具在启动 Rails 或 Python 前核对当前库名、数据目录、Unix socket 和数据库角色，数据库相关环境只允许本次专用连接。
- 原数据库配置审计覆盖 Rails Web、identity-api、本机 Tauri SQLite、开发脚本、环境变量和 Render 蓝图。Render 运行时环境仍待单独核验。

## Phase 1b · 跨设备模块偏好

- 实现覆盖 Rails Web、Bearer API 和 Universal。Web 与 API 共用账号行锁，模块分别比较修订号，冲突只影响同一模块。以账号和请求 UUID 保存成功事务的响应供重试。首次同步保留旧客户端偏好，并让用户确认仅本机有值的选项或在不同值之间作选择。离线队列、冻结后的重试请求和未解冲突均按不可变账号 ID 持久化。
- 主要文件包括 `app/services/finance/module_preference_sync.rb`、`app/controllers/client_api/v1/module_preferences_controller.rb`、`app/models/finance/module_preference.rb`、`clients/universal/src/services/moduleSync.ts`、`clients/universal/src/services/modulePreferenceApi.ts`、`clients/universal/src/hooks/useModules.tsx` 和两端 Feature Library。
- PostgreSQL 迁移 `20261124000100` 增加设备 UUID 和请求重放表。仅在两个专用本地库执行。开发库回滚、重新迁移及再次运行均成功，回滚保留两个合成模块偏好及其修订号。该回滚会移除设备标记和请求重放历史。
- 原生 Apple Silicon macOS 开发包使用独立 Bundle ID、SQLite、Keychain、Rails :33531 和 identity-api :38531。Web 界面接收原生 Reports 开启状态，原生接收 Web 的 Budgets 开启状态。暂停专用 Rails 后在原生启用 Categories & Tags，再用 Web 相同的写入路径提交相反值。恢复服务后原生同时显示两个候选；选用本机值后双方同步，退出重启保持选择，登出回到登录页。自动化覆盖租户隔离、重放、部分冲突、离线重启及账号切换期间丢弃迟到响应。
- 回归中修复两处问题。将模块偏好请求移到独立隐私审计的网络服务。AI 分类完成后的撤销入口在服务不可用时仍可访问。隔离启动器优先使用项目 Ruby，避免 Rails 测试子进程调用系统 Ruby。
- 回退时将服务器 `BILLIE_MODULE_SYNC` 关闭，客户端可通过 `VITE_BILLIE_MODULE_SYNC=0` 禁用后台同步。先保留两个数据库结构及请求历史，待本机队列处理完再评估结构回退。关闭功能开关并保留结构是常规止损路径。
- 阶段回归记录。TypeScript 通过。Vitest 906 通过、12 跳过、0 失败。Rails 全量实跑 816 项、30,983 断言、1 失败、0 错误、2 跳过。唯一失败是命令上下文的旧断言把不透明租户标识中的随机数字误认作交易金额。改为验证完整允许字段集合、精确租户标识和其余载荷后，受影响的 28 项、221 断言全部通过。里程碑 `5ec26c2` 的隔离快照全量重跑结果为 816 项、30,986 断言、0 失败、0 错误、2 跳过，Rails 行覆盖率 92.38%。
- 下一阶段为 Phase 2。保留 Transactions、AI Assistant、Settings 默认导航以及现有账本口径。改版范围为 Web 与 Universal 的 Transactions Overview。

## Phase 2 · Transactions Overview

- Rails 与 Universal 提供收入、支出、净现金流、可展开的月份明细、支出与收入分类及最近交易。沿用共享财务规则，退款冲减支出，转账和信用卡还款不计入。账户、日期和 Universal 本机账本选择控制总览范围。Web 每个账号目前只有一个云端账本。账户筛选生效时，页面省略全账本余额和全账本导出入口，避免把它们当成筛选结果。AI 洞察继续使用现有显式入口。
- 主要文件为 `app/controllers/finance/dashboard_controller.rb`、`app/services/finance/snapshot.rb`、`app/services/finance/spending_breakdown.rb`、`app/views/finance/dashboard/`、`packages/finance-core/src/snapshot.ts`、Universal Dashboard、OverviewCharts 和对应样式、翻译。数据库结构未变。
- Web 合成账本核对收入 $6,780.00、支出 $1,809.63、净额 $4,970.37；信用卡筛选后的 $50.00 含退款并排除了还款。键盘可展开月份，390px 简体中文无横向溢出。见 [英文浅色桌面](evidence/2026-11-24-autonomous/phase2-web-en-light.png) 和 [简体中文深色移动尺寸](evidence/2026-11-24-autonomous/phase2-web-zh-dark.png)。
- 独立原生 macOS QA 应用从隔离服务取得 6 笔合成交易。全部日期收入 $3,700.00、支出 $120.20、净额 $3,579.80；切到上月后为 $1,200.00、$76.45、$1,123.55，月份明细可展开。混合账户、退款、还款和账本切换另由 Rails 和 Universal 自动测试验证。
- Universal 类型检查与打包通过，Vitest 907 通过、12 跳过、0 失败。旧工作流测试原先按全页金额查找，在新增收入分类后同时命中两处，已精确定位原有收入总计行为。回滚只需撤销本阶段界面和查询提交。

- Rails 全量回归 `818 tests, 31021 assertions, 0 failures, 0 errors, 2 skips`。里程碑为 `aad3c7d`。

## Phase 3 · Add & Sync

- Connect Financial Accounts 保留 Coming Soon。Universal 桌面原生文件选择器只读取明确选中的文件，先验大小。CSV、TSV、XLSX、OFX、QFX、文本 PDF 与扫描件沿用已有解析、字段映射、去重和错误报告。文本 PDF 也须先检查并确认。Web 继续支持原有的 CSV 和 PDF 导入流程，并拒绝超限或参数格式错误的上传。
- 收据在设备上识别，并显示商家、总额、币种、日期及可能的重复项。原有政策保持生效。只有精确、唯一、有效的匹配可自动关联，新建交易须明确确认。Universal 在 Apple Vision 无响应时有 20 秒等候上限，且可取消。无可用原生识别页时可改用随包附带的本机 Tesseract。
- Quick Add 支持英、简中、繁中的常见收支短句，预填既有交易表单，手动检查后才写入。桌面快捷键 Control 或 Command + Shift + E 打开空白支出表单。语音和银行连接没有启用。Web 支持网页手动入口，键盘快捷键在 Universal。
- 主要文件包括 `app/services/finance/quick_entry.rb`、Rails entries、receipts、statements 控制器及 Add & Sync 视图、Universal `DocumentPicker.tsx`、`documentInput.ts`、AddSync、Import、Receipt、`ocr/nativeEngines.ts`、`quickEntry.ts` 和本地化文件。无数据库迁移。
- 原生 macOS 隔离包用系统选择器打开合成 CSV。两行先显示在预览，点击确认后导入 2 笔、跳过 0 笔、失败 0 笔。验收 SQLite 含 2 个账单、8 笔交易，完整性检查为 `ok`，外键违规 0。真实收据 GUI 触发 Apple Vision 后，进程采样显示操作系统 TextRecognition 的 Neural Engine 队列等待。指定 CPU 阶段后仍能复现。后续桌面工具无法取得窗口，收据与扫描 PDF 的最终原生 GUI 验收仍待补验。
- Chromium Web 验证了简中 `支出 12.34 合成午餐` 预填方向、金额和描述，以及银行连接没有操作入口。服务端集成测试验证预览零写入、显式保存写入一笔。见 [简体中文预览](evidence/2026-11-24-autonomous/phase3-web-quick-zh.png)。
- Rails 全量通过，820 项、31,048 断言、0 失败、0 错误、2 跳过，行覆盖率 92.43%。Universal 在加入 OCR 超时回退前已回归 909 通过、12 跳过。新入口让三处旧测试读到了不再适用的行为，已更新为验证明确 PDF 确认、可用文字入口和仅限动态文件授权。最终 OCR 和平台验证见下文。
- Phase 3 本地里程碑为 `dee1fea`。回退时撤销该提交即可恢复原入口和导入流程。保留已经确认的交易和导入历史。
- OCR 回退、收据工作流和实际 Chromium 离线引擎的组合用例全部通过，28 项、0 失败。合成扫描 PDF 的 8 行金额和日期均匹配，7 行可直接确认，1 行待复核，没有错误金额被标为可直接确认。真实 Apple Vision 运行在本机陷入操作系统调用的等待，未将该次运行计为通过。继续独立的 Phase 4 加固与本地回归。

## Phase 4 · 工程加固

- Rails 在 PostgreSQL 按入账月份和类型聚合，再用原有财务规则计算收入、净支出和净额。120,000 行合成样本的数据库输出从 120,000 行减到 72 个分组。聚合占用 145 kB，旧排序在该样本中发生约 3.3 MB 的临时写入。该探测衡量结果规模与查询计划，未测生产请求延迟。另有跨年、仅退款月份及信用卡还款排除的回归。
- Universal 计算期间起止日期时只扫描已计入的交易一次，只对不同月份排序。已归属的账本启动时跳过内容扫描，并行读取账本名称和数据。下载期间可以切换账本，迟到的响应仅刷新对应账本。监听状态、设置和交易按活动账本发布。新增延迟下载回归，覆盖两个账本都完成下载且旧账本不会覆盖当前界面。
- 总览的公用样式移至 `public/billie-overview.css`，Rails 与 Universal 直接引用。复核 Chromium 桌面浅色与 390px 简中深色总览，金额一致、可键盘展开月份、无横向溢出及页面异常。
- 主要文件包括 `app/services/finance/snapshot.rb`、`packages/finance-core/src/snapshot.ts`、`clients/universal/src/hooks/useFinance.tsx`、共享总览样式、账本切换测试和 Chromium OCR 回归。Phase 2–4 没有新增数据库迁移。专用 PostgreSQL 仍通过身份检查，无无效索引或未验证约束。新增 OCR 回归在浏览器断网后识别合成收据，并校验商家、USD 和精确总额 $10.25。
- Apple Silicon macOS 的本地 Tauri debug 打包成功，Bundle ID 为 `com.billieweather.roadmap.phase4`。桌面自动化服务列不出应用窗口，原生收据、扫描 PDF 和最终 GUI 回归因此待复验。此 Mac 仅有 Xcode 命令行工具，缺少 iOS SDK 和 Android 工具链。Windows、Linux、Intel macOS 及移动端未构建、未验收。Chromium 验证覆盖 Rails Web 与浏览器中的本机 OCR。
- 回退时撤销 Phase 4 提交。由于结构未变，无 Phase 4 数据库回滚。下一步仅在单独授权后进行发布准备。

### 最终回归与发布条件

- Rails 全量运行 821 项、31,050 断言、0 失败、0 错误、2 跳过，行覆盖率 92.44%。最终 SQL 日期类型转换再跑快照、期间和 Web 外壳套件，23 项、359 断言、0 失败、0 错误、0 跳过。
- Universal 类型检查通过。Vitest 72 个测试文件全部通过，共 914 项、0 失败。其中共享财务域、报告、类型、命令和模块同步的单独验证为 18 个文件、372 项、0 失败。最终 Vitest 包含实际 Chromium 扫描件与收据 OCR，Apple Vision 实引擎文件的 12 项单独排除。它在早期 Phase 3 全量通过，本机随后出现系统调用阻塞。
- macOS Rust 目标 19 项通过、0 失败。第 20 项真实 Apple Vision FFI 的独立复试在 25 秒终止，未计为通过。IPC 超时、取消和设备上回退均有自动化覆盖。原生回退在 WKWebView 的完整流程仍待验证。
- 发布前需要复验 macOS 收据和扫描 PDF、核准的平台构建和签名，以及在经批准的隔离 Neon 环境验证迁移与回滚。核对 Render 实际数据库目标和迁移时机。先保留模块偏好及其历史，并在隔离环境验证开关回退，再决定是否启用跨设备同步。
- 本轮使用专用 PostgreSQL、回环服务、独立应用标识和合成交易。原工作树和开发服务保留，未操作 Neon 生产库、真实财务记录或已安装的应用。提交只存在本地。发布状态保留为待验收。
