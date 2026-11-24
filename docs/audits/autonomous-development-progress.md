# BillieWeather / FinRx 自主开发进度

## 2026-11-24 · 验收基线与环境

- Phase 0.5 / 1a 已验收，证据见 [Phase 1a 验收报告](phase0.5-phase1a-implementation-report-2026-11-23.md)。独立工作树分支为 `autonomous-development`，基线提交为 `d3061e4`，原工作树有用户的未提交改动。
- 原 :3000 和 :8100 开发服务仍指向同一 Neon 生产端点。独立工作树复制已验收代码和已安装构建依赖，本地工具 `bin/billie-local` 初始化专用 PostgreSQL。工具在启动 Rails 或 Python 前核对当前库名、数据目录、Unix socket 和数据库角色，数据库相关环境只允许本次专用连接。
- Phase 1b 进行中。阶段验收记录会依次记录实现、回归、数据迁移、提交与回滚。

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

- Rails 全量回归 `818 tests, 31021 assertions, 0 failures, 0 errors, 2 skips`。下一阶段为 Phase 3 Add & Sync。
