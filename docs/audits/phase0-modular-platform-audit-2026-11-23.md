# BillieWeather / FinRx — Phase 0 审计与模块化平台路线图

日期：2026-11-23 · 范围：只读审计（未修改应用代码、未运行迁移、未连接 Neon、未推送、未部署）
仓库：`billieweather/`（`main`，工作区干净，HEAD `e4380af`）

证据分级：**[已验证]** = 读过实现并追踪到写库/计算；**[测试]** = 有对应自动化测试通过；**[未验证]** = 只有源码、未编译或未运行；**[缺失]** = 代码中不存在。

---

## 1. Executive Summary

1. **实际上有两套独立 UI，而不是一套共享 UI。**
   - **Web** 是 Rails 8.1 的服务端 ERB 页面（`app/views/layouts/billie.html.erb`），不是 React 客户端。
   - **Mac/Windows/iOS/Android** 共用 `clients/universal`（React 19 + Vite + Tauri 2 + 本地 SQLite）。
   - React 客户端的"浏览器模式"使用内存中的 sql.js（`clients/universal/src/services/platform.ts:31-40`，`persistent: false`），只是 demo，不是生产 Web。
   - 结论：Feature Library、导航、Overview 都必须**在 ERB 与 React 两侧各实现一次**。共享点应是"模块清单 + 偏好数据 + 计算逻辑"，而不是组件。
2. **共享的领域内核已经存在，质量不错。**
   - `packages/finance-core/schema/financial-schema.json` 被 TS（`finance-core`）和 Ruby（`app/models/finance/domain.rb:10`）共同读取，定义 8 种 `kind`、计入规则（只有 expense/income/refund 计入）和 5 种 link。
   - Rails 与 TS 之间有 parity 测试（`shared_fixture_parity_test`、`snapshot-parity`）。
   - 转账/还款不会虚增收支：Rails 侧 `app/services/finance/snapshot.rb:25,50`，客户端侧 `packages/finance-core/src/snapshot.ts:10`。
   - 这是本次重构最重要的可复用资产。
3. **已有"Default / Manual 模式"，可视为 Feature Library 的雏形，但它不是按模块的开关。**
   - Web 端存在 `session[:billie_mode]`（`app/controllers/finance/base_controller.rb:15-17`）。
   - 客户端存在 React state（`clients/universal/src/hooks/useMode.tsx:24`），**两端都没有持久化，也不跨设备**。
   - 现在**不存在任何模块级开关或偏好表**。
4. **Add & Sync 四项能力的现状：**
   - Connect Financial Accounts：[缺失]，没有 Plaid 或任何聚合代码（这是正确的）。
   - Import Statements：[已验证/测试]，客户端格式更全（CSV/TSV/XLSX/OFX/PDF/扫描 PDF），Web 只支持 CSV 与文本 PDF。
   - Scan & Capture：[部分]。设备端 OCR（Apple Vision / tesseract.js），用规则解析字段，没有 AI 抽取。客户端不保存小票本体，Web 有完整的 `finance_receipts` 和对账。
   - Quick Add：[部分]。手动表单完整，但没有自然语言/语音记账，Siri 只是未编译的 deep link。
5. **AI 只接入了 OpenAI。** Responses API（`app/services/finance/insight_generator.rb:9`）提供 Insights、Chat、税务准备、AI 分类。命令栏 `nl-action-engine` 是确定性解析器，不经过 LLM，带 preview/confirm/undo。
   - 主要缺口：AI 分类在 Web 端直接 `update_all`，**没有 AuditEvent，也不能撤销**（`app/services/finance/ai_categorizer.rb:177-183`）。
6. **跨平台的真实状态：**
   - 只有 macOS 有构建产物（`src-tauri/target/release/bundle/dmg/BillieWeather_0.1.0_aarch64.dmg`）。
   - Windows 没有构建证据。
   - iOS/Android 的 Tauri 工程**从未生成**（`src-tauri/gen/` 只有 `schemas/`），移动端 OCR 插件和 AppIntents 自述"未编译"。
7. **同步不是双向的。**
   - 导入账单：服务器 → 客户端自动拉取；客户端 → 服务器只能手动增量推送。
   - 手动记账、账户、标签、预算、links **从不同步**（`clients/universal/src/services/store.ts:864-866`）。
   - 所以"模块偏好跨设备同步"需要**新的服务器端存储**，不能复用现有的同步通道。
8. **本次测试基线：**
   - Rails：755 tests，**5 failures**（4 个是测试 seed 落后于 receipt 表，1 个是缺少 `billie_receipts.es.yml`），2 skips，行覆盖率 91.7%。
   - universal vitest：872 pass、12 skip；`tsc --noEmit` 0 错误。
   - identity-api pytest：全部通过（1 skip）。
   - billieforecast：55 pass。
9. **发现 3 个应先修的数据完整性问题**（详见 §11）：
   - 删除账户时没有检查 receipts，会撞上外键 → 500。
   - AI 分类写入没有审计。
   - 客户端 API 不校验 sha256 格式 → 500。
   - 另有多处注释与实际行为相反（例如 `ClientApi::SessionToken` 的注释写着"不访问财务数据"）。

**建议**：把 Phase 1 拆成 1a（模块注册表 + 偏好存储 + 双端导航）和 1b（跨设备同步），并在 Phase 1 之前插入一个很小的 **Phase 0.5 "完整性修补"**。

---

## 2. Current Product Architecture

| 层 | 实际技术 | 证据 |
|---|---|---|
| Web 后端 + 网站 | Rails 8.1.4（Bullet Train 模板），ERB + 原生 JS（`public/billie.js`、`public/billie-command.js`） | `Gemfile.lock`、`app/views/layouts/billie.html.erb` |
| 服务器数据库 | PostgreSQL（开发库在 Neon；测试库在本地 `untitled_application_test_billieweather`） | `config/database.yml` |
| 桌面/移动客户端 | React 19 + Vite 7 + Tauri 2（Rust），`@tauri-apps/plugin-sql` 管理本地 SQLite，最多 8 个库槽位 | `clients/universal/package.json`、`src-tauri/src/lib.rs:28-105` |
| 共享 TS 包 | `finance-core`（领域/导入/小票/去重）、`reporting`、`shared-types`、`design-tokens`、`nl-action-engine`、`nl-action-react`、`billie-commands` | 通过 vite alias 引入（`vite.config.ts:57-58`）。Rails 通过生成产物消费：`public/billie-command.js`、`billie-tokens.css`、`financial-schema.json` |
| 注册服务 | Python FastAPI `services/identity-api`：只负责注册（邮箱验证码、Google PKCE），**直接写 Rails 的 `users/teams/memberships` 表** | `identity_api/main.py:208-286` |
| 登录/会话 | Rails `POST /api/client/v1/session`，签发无状态 `MessageVerifier` token（30 天，绑定 Devise salt） | `app/models/client_api/session_token.rb:9-25` |
| 预测 | Rails 进程内 `prophet-rb`（默认）、HTTP 调用 Python `billieforecast`（Chronos-2）、linear | `app/services/finance/cash_flow_forecast.rb:6`、`billie_forecast_client.rb:13-20` |
| LLM | 仅 OpenAI Responses API（Net::HTTP，`store: false`），模型名由 credentials/ENV 配置 | `insight_generator.rb:9,106-120` |
| OCR | 设备端：macOS/iOS 用 Apple Vision，Android 用 ML Kit，Windows/浏览器用 tesseract.js；没有云端 OCR | `clients/universal/src/services/ocrEngine.ts:70-97` |
| 遗留模板 | Bullet Train 的 Stripe 集成、Doorkeeper、webhooks、"tangible things" scaffolding | `Gemfile:134`、`db/schema.rb:643,733,865` |

**导航系统：**
- Web：layout 内联侧栏（`billie.html.erb:39-104`，链接由 `finance_nav` 生成，见 `app/helpers/finance_helper.rb:169`）。Default 模式 10 项，Manual 模式按 record / organize / plan / automatic 分 4 组。
- 客户端：`useState<Page>` 状态路由，没有 URL 路由（`clients/universal/src/App.tsx:87,163-174`）。导航常量 `NAV`（8 项）和 `MANUAL_NAV`（`App.tsx:48-65`）；打开 Manual 专属页面会自动切到 Manual 模式（`App.tsx:97`）。

**认证与授权：**
- Web：Devise + OTP。
- 客户端：Bearer token，所有 finance 查询都按 `current_user.id` 作用域（没有 team 作用域）。
- 数据库层：财务表全部有 `user_id NOT NULL` 和**复合所有者外键** `(col, user_id) → (id, user_id)`，由 `20261116000100_enforce_finance_integrity.rb` 加入。这是很强的租户隔离，需要保留。

**架构重复与耦合：**
- 导入：Ruby（`StatementImporter`，只支持 CSV/PDF）与 TS（`finance-core/universal`，支持 CSV/XLSX/OFX/PDF/OCR）是两套实现，格式能力不一致。共享的只有 kind 规则和测试 fixture。
- 去重：Ruby 的 `DuplicateDetector`/`ImportPlan` 与 TS 的 `ledger/dedupe.ts` 各写了一份。
- 偏好：Web 存 session，客户端存 React state 和 localStorage，没有统一模型。
- 读请求带写入：每个 finance 页面的 GET 都在 `User#with_lock` 下跑 `BalanceSync` 并清理过期草稿（`base_controller.rb:58-67`）；`TransactionsController#index` 还会 `post_auto_recurring`。

---

## 3. Existing Feature Inventory

状态：✅ 已实现 · 🟡 部分实现 · ❌ 缺失 · ⚠️ 有缺陷 · 🔁 重复实现

### Transactions / Overview
| 能力 | 状态 | 证据 |
|---|---|---|
| 收入/支出/净额汇总 | ✅ 测试 | Web `snapshot.rb:17-56`，客户端 `pages/Dashboard.tsx` + `finance-core/snapshot.ts` |
| 转账/还款不计入收支 | ✅ 测试 | `domain.rb:27`、`snapshot.ts:9-10`、parity 测试 |
| 退款冲减支出、退款上限 | ✅ 测试 | `ledger.rb:342-343,407-425`；SQLite 触发器 `0008_refund_integrity.sql` |
| 按类别统计支出 | ✅ | `SpendingCharts.tsx`、`spending_breakdown_test` |
| 按类别统计收入 | 🟡 | 只有 snapshot 汇总，没有专门图表 |
| 月度趋势 | ✅ | Dashboard 月度柱条、`Categories.tsx` 的 12 个月趋势 |
| 与上期对比 | ❌ | 两端都没有 period-over-period |
| 日期范围 | ✅ | `DashboardPeriod`（all_time / 本月 / 上月 / 近 30 天 / 今年 / 去年 / 自定义） |
| 账户/账本筛选（Overview） | ❌ | Overview 没有账户筛选，只有交易列表有 |
| 图表 | 🟡 | 客户端是 CSS 柱条，没有 SVG 或图表库；Web 同样以 CSS 为主 |
| AI 洞察 | 🟡 | Web 有 `InsightGenerator`（rules/openai），客户端没有 |

### All Transactions
| 能力 | Web | 客户端 | 证据 |
|---|---|---|---|
| 搜索 | ✅ | ✅ | `transactions_controller.rb:25-27`、`Transactions.tsx:58-61` |
| 筛选（类别/kind/账户/商户/项目/标签/日期） | ✅ | 🟡 只有类别筛选两种模式都可用，其余仅 Manual 模式 | `transactions_controller.rb:13-40`、`Transactions.tsx:62-64` |
| 排序 | ❌ 固定按日期倒序 | ❌ | `transactions_controller.rb:15` |
| 编辑 / 回收站 / 恢复 | ✅ | ✅（仅 Manual 模式） | `Transactions.tsx:120-141,258-262` |
| 批量操作 | ✅ | ✅（仅 Manual 模式） | `ledger.ts:1032` |
| 标签 / 商户 / 项目 | ✅ | ✅ | `finance_tags`、`finance_merchants`、迁移 0007 |
| 转账（双腿 + link） | ✅ 手动创建 | ✅ 手动创建，由触发器写入 | `ledger.rb:300-312`、`0007_ledger.sql:244` |
| 导入流水的转账自动配对 | ❌ Web | 🟡 由客户端 Organize 提议 | `organize.ts` |
| 退款关联 | ✅ | ✅ | `refund_of` link |
| 拆分交易 | ❌ | ❌ | schema 中没有 split 概念 |
| 对账 | 🟡 只有小票对账 | 🟡 只有导入时的余额核对 | `ReceiptReconciler`、`ImportPreview.tsx:220-224` |
| 重复检测 | ✅ 导入时，确定重复会静默跳过 | ✅ 导入时 + Organize | `import_plan.rb:65-68`、`dedupe.ts` |
| 来源/出处 | ✅ `entry_origin`、`category_source` | ✅ 更丰富：`source_raw`、`parse_confidence`、`import_batch_id` | 迁移 0004 |
| 不确定分类的复核 | 🟡 Web Reviews（收入、重复） | 🟡 `suspectIncome` 复核 | `Transactions.tsx:150-158` |

### Add & Sync（详见 §9）
| 能力 | Web | 客户端 |
|---|---|---|
| CSV | ✅（2 MB / 5000 行；日期只认 ISO 和 m/d/Y） | ✅（CSV/TSV，可映射字段） |
| Excel | ❌（只能导出） | ✅ XLSX；旧版 .xls 明确拒绝 |
| PDF 文本 | ✅ 草稿 → 复核 | ✅ |
| PDF 扫描件 | ❌ | ✅（渲染为图片后 OCR） |
| OFX/QFX | ❌ | ✅ |
| QIF | ❌ | ❌ |
| 预览 + 字段映射 + 模板 | 🟡 只能逐行编辑 | ✅ |
| 导入历史 + 撤销导入 | 🟡 只能删除整张账单，是硬删除 | ✅ `importHistory` / `reverseImport` |
| 小票 OCR | 🟡 依赖设备 OCR、PDF 文本或本地命令 | ✅ 设备 OCR |
| 小票存储 + 对账 | ✅ `finance_receipts` / `finance_receipt_matches` | ❌ 不在本地存储；可选上传到 Web |
| AI 抽取 | ❌ | ❌ 只有规则解析 |
| 手动记账 | ✅ | ✅ |
| 自然语言/语音记账 | ❌ | ❌（命令栏没有 add 动作） |
| Siri/Shortcuts | — | [未验证]（3 个 deep link intent，未编译） |
| 银行连接 | ❌ | ❌ |

### 其他模块（对应 Feature Library）
| 模块 | Web | 客户端 | 备注 |
|---|---|---|---|
| Ledgers | 🟡 `finance_books` 只有默认账本，没有表引用它 | 🟡 8 个本地数据库槽位 + `book_uuid` | **目前没有真正的多账本**；客户端的"多数据库"是另一种概念 |
| Accounts & Assets | ✅ 9 种账户、净值、归档 | ✅ | |
| Categories & Tags | ✅ 类别树 + 标签 | ✅ | category 是字符串，没有外键 |
| Budgets | ✅ | ✅ Planning 页 | |
| Reports | ✅ ledger reports、Excel/CSV 导出 | ✅ Excel/CSV + SQL 维度报表（仅 Manual 模式） | |
| Recurring & Bills | ✅ recurring rules（自动入账） | 🟡 规则表有；Organize 的 recurring 提议**不执行任何操作**（`organize.ts:91-94`） | |
| Goals & Planning | ❌ | ❌ | |
| Household | ❌（Bullet Train 的 teams 没有覆盖 finance） | ❌ | 需要新的授权模型，复杂度高 |
| Cash Flow Forecast | ✅ 30/60/90 天，三种引擎 | ❌ | |
| Multi-Currency | ❌ 每个用户只有一种币种，导入时强制 | ❌ | |
| AI Assistant（chat） | ✅ InsightChat（只用聚合数据，不写库） | ❌ | |
| Tax preparation | ✅ | ❌ | 需要决定归入哪个模块（建议并入 Reports） |

### 已移出产品范围的功能：现状
- 投资收益、FX 执行、汇款、支付执行、发卡、金融产品推荐、信用分：**代码中都不存在**（已 grep 确认）。不需要删除任何功能代码。
- Community 页的 Alipay/WeChat/Zelle/Venmo 只是静态捐赠二维码图片，不是支付功能，可以保留。
- Bullet Train 的 Stripe 遗留：gem、initializer、3 张空表、Ability 规则。属于死代码，见 §11 的处理建议。**不建议在本次重构中删表。**

---

## 4. Missing Feature Analysis

按优先级排列（P1 = 本次重构必需，P2 = 增强，P3 = 未来）：

| 缺口 | 优先级 | 说明 |
|---|---|---|
| 模块注册表 + 用户偏好（服务器持久化，跨设备） | P1 | 两端都没有 |
| 新的默认导航（只显示 Transactions / AI Assistant / Settings） | P1 | 需要把现有 10 项和 8 项导航归入各模块 |
| Transactions 内部的三分区：Overview / All Transactions / Add & Sync | P1 | 现在 Dashboard、Transactions、Import、Receipt 是平级页面 |
| AI Assistant 作为独立入口 | P1 | Web 有 Insights + Chat，需要合并成一个入口；客户端完全没有，需要代理到服务器 |
| 上期对比、收入类别图、Overview 账户筛选 | P1 | 只涉及计算与 UI，不改 schema |
| 交易排序 | P1 | 低成本 |
| AI 写入审计与撤销 | P1 | 合规前提 |
| Add & Sync 中的 "Connect Financial Accounts" 占位卡片（标注为未来功能） | P1 | 只做 UI 和文案 |
| Web 端支持 XLSX/OFX | P2 | 可以用 Ruby 实现，或让 Web 复用 TS 解析器（见 §9） |
| 客户端本地保存小票与对账 | P2 | 需要 SQLite 迁移 0010 |
| 自然语言记账（"午饭 38 元"） | P2 | 在 `nl-action-engine` 中加 `transactions.create`，走 preview/confirm |
| 拆分交易 | P2 | 需要 schema 改动，见 §6 |
| 账户对账工作流 | P2 | |
| 手动记账数据的跨设备同步 | P3 | 这是最大的架构项，不应混入 UI 重构 |
| Goals、Household、Multi-Currency | P3 | Household/Multi-Currency 涉及会计语义，应单独立项 |
| 语音记账、Siri 实装、iOS/Android 构建 | P3 | 前提是先生成移动端工程并真机验证 |
| Plaid 等 provider | 未来，需单独批准 | 先做 adapter 接口文档 |

---

## 5. Cross-Platform Feature Matrix

图例：✅ 已验证（代码 + 测试）· 🟡 部分 · ❌ 缺失 · ❓ 共享源码但未在该平台构建或运行 · — 不适用
"Web" = Rails ERB 网站。Mac 有 DMG 构建产物，本次未启动 GUI。Windows/iOS/Android 本次**无法运行时测试**。

| Feature | Web | Mac | Windows | iOS | Android | Backend | Database | Recommendation |
|---|---|---|---|---|---|---|---|---|
| Feature Library / 模块开关 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Phase 1：新表 `user_module_preferences` + 共享的模块 manifest |
| Default / Manual 模式 | 🟡 存 session | 🟡 内存 | ❓ | ❓ | ❓ | session | 无 | 由 Feature Library 取代，迁移期保留 |
| Overview 汇总 | ✅ | ✅ | ❓ | ❓ | ❓ | `Snapshot` | PG / SQLite | 复用，新增对比与筛选 |
| 转账/退款正确计入 | ✅ | ✅ | ❓ | ❓ | ❓ | `Domain` | 触发器 / CHECK | 保留，作为回归测试基线 |
| 交易搜索/筛选 | ✅ | 🟡 | ❓ | ❓ | ❓ | ✅ | — | 客户端放开 Manual 模式限制 |
| 交易排序 | ❌ | ❌ | ❌ | ❌ | ❌ | — | 加索引 | Phase 2 |
| 拆分交易 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Phase 2b，需要 schema 设计 |
| CSV 导入 | ✅ | ✅ | ❓ | ❓ | ❓ | `StatementImporter` | `finance_statements` | 两端能力对齐 |
| XLSX / OFX 导入 | ❌ | ✅ | ❓ | ❓ | ❓ | ❌ | — | Phase 3 |
| PDF 导入（文本） | ✅ | ✅ | ❓ | ❓ | ❓ | `PdfStatementExtractor` | drafts | 保留 |
| PDF 导入（扫描） | ❌ | ✅ Vision | ❓ tesseract | [未验证] | [未验证] | — | — | 保留 |
| 小票 OCR | 🟡 | ✅ Vision | ❓ tesseract | [未验证] 插件 | [未验证] ML Kit | `ReceiptReconciler` | `finance_receipts` | 客户端补本地存储 |
| 小票对账 | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | Phase 3 |
| 手动记账 | ✅ | ✅ | ❓ | ❓ | ❓ | `Ledger` | ✅ | 做一个更快的 Quick Add 入口 |
| 自然语言/语音记账 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | — | Phase 3（NL）/ 未来（语音） |
| Siri / Shortcuts | — | — | — | [未验证] | — | — | — | 需要先 `ios:init` |
| 预算 | ✅ | ✅ | ❓ | ❓ | ❓ | ✅ | ✅ | 归入 Budgets 模块 |
| 周期账单 | ✅ | 🟡 | ❓ | ❓ | ❓ | ✅ | ✅ | 修复 Organize 中的空操作 |
| 现金流预测 30/60/90 | ✅ | ❌ | ❌ | ❌ | ❌ | ✅ | 不落库 | 客户端可通过服务器 API 获取 |
| AI Chat / Insights | ✅ | ❌ | ❌ | ❌ | ❌ | OpenAI | `finance_insights` | AI Assistant 模块 |
| AI 分类 | ✅ ⚠️ 无审计 | 🟡 仅建议 | ❓ | ❓ | ❓ | ✅ | — | 补 AuditEvent + undo |
| 自然语言命令（preview/undo） | ✅ | ✅ | ❓ | ❓ | ❓ | `SmartCommand` | `finance_command_executions` | 复用为 AI 写入通道 |
| 多账本 | ❌ | 🟡（多数据库） | ❓ | ❓ | ❓ | ❌ | `finance_books` 无引用 | 定义 Ledgers 语义后再做 |
| 多币种 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 未来单独立项 |
| 家庭共享 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 未来单独立项 |
| 银行连接 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 只做 adapter 设计 |
| 数据同步 | 服务器为主 | 拉取 + 手动推送 | ❓ | ❓ | ❓ | `client_api` | — | 偏好同步单独设计 |
| i18n（en / zh-CN / zh-TW / ja / ko / es） | 🟡 缺 `billie_receipts.es.yml` | ✅ | ❓ | ❓ | ❓ | — | — | 补齐翻译文件 |

---

## 6. Database Architecture Assessment

**优点（保留）：**
- 财务表都带复合所有者外键和 `UNIQUE(id, user_id)`，跨用户的批量写入在数据库层就会被拒绝（`schema_integrity_test`）。
- 账单文件级去重：服务器 `UNIQUE(user_id, sha256)`，本地 `statements.sha256 UNIQUE`。
- `transaction_links` 统一建模 transfer / card_payment / refund_of / duplicate_of / pending_to_posted，带 status 与 decided_by。
- `original_description` 不可变（触发器 + `attr_readonly`），回收站用 `deleted_at`，本地 `audit_events` 只追加。
- 本地导入原子提交：`import_staging_rows` + 触发器 `statements_commit_staged`。
- 每次迁移前快照本地 SQLite（`src-tauri/src/lib.rs:94-105`）。

**问题：**
1. **Source records 与规范化 transaction 没有分开存储。**
   - 客户端把 `source_raw` 存成交易上的 JSON 列。
   - 服务器只保留 `original_description`，草稿行存在 `finance_statement_drafts.rows`（jsonb，过期后删除）。
   - 小票是唯一独立的源记录表。
   - 建议：短期不拆表，把 "statement / receipt / (future) provider_sync" 统一视为 *source*，transaction 通过 `entry_origin` + 外键追溯即可。
2. **服务器交易没有行级去重指纹**（`fingerprint` 已在 20261116 删除）。去重依赖 date + amount + 规范化描述，确定重复时静默跳过。可以接受，但被跳过的行应写入导入报告。
3. **`finance_books` 没有被任何表引用**，"Ledgers"模块因此没有数据基础。
   - 客户端的"多个本地数据库"与服务器"账本"是两种概念，需要先在产品层面定义清楚。
   - 建议：Ledgers 在 Phase 1 只作为模块占位，不实现。
4. **category 是自由文本**（transactions / budgets / merchant_rules），没有外键。改名靠批量更新，可以接受，但不能把 Categories 做成"可禁用即失效"的模块。
5. **服务器 transactions 没有 currency 列**，币种是每个用户一种。Multi-Currency 必须重新设计 schema，不能只靠模块开关。
6. **模块偏好、UI 布局、同步状态目前都没有专门存储。** 客户端把同步状态放在 `settings` 键值表里，服务器什么都没有。
7. **小票外键没有 on_delete**，而账户删除前的检查漏掉了小票（§11 R1）。

**Phase 1 的唯一 schema 变更提案**（只新增、向后兼容）：

```
finance_module_preferences   (Rails / PG)
  id, user_id NOT NULL FK users ON DELETE CASCADE
  module_key  varchar(40) NOT NULL   -- 'transactions','ai_assistant','budgets',...
  enabled     boolean NOT NULL
  updated_at_client  timestamptz NOT NULL   -- 客户端修改时间，用于冲突解决
  revision    bigint NOT NULL              -- 服务器单调递增版本
  device_id   varchar(36) NULL             -- 最后修改者
  created_at, updated_at
  UNIQUE(user_id, module_key)
  CHECK(module_key ~ '^[a-z_]{2,40}$')
```

- 用户没有某个模块的行，就表示使用该模块的默认值。因此**老用户不需要回填**，迁移是纯新增。
- 本地 SQLite 新增迁移 `0010_module_preferences.sql`：同样的字段，外加 `dirty` 标志。
- 回滚方式：删表 / 回退迁移，不影响任何财务数据；本地 `0010` 同样只新增。
- **禁用模块不触碰任何财务表**，这一点由测试断言。

---

## 7. Proposed Navigation and UI Structure

### 模块清单（单一来源）
新建 `packages/shared-types/src/modules.ts`，作为模块 manifest。由构建脚本导出 JSON 给 Rails，复用 `financial-schema.json` 已有的跨语言共享方式。

| key | 名称 | 默认 | 归入的现有页面（Web / 客户端） |
|---|---|---|---|
| `transactions` | Transactions | ✅ core | dashboard、transactions、statements、statement drafts、receipts、reconciliation、reviews、entries / import、receipt、manual |
| `ai_assistant` | AI Assistant | ✅ core | insights、chat、command bar |
| `ledgers` | Ledgers | ⬜ | （暂无实现；客户端多数据库管理在 Data 页）→ **标记为 coming soon** |
| `accounts` | Accounts & Assets | ⬜ | accounts、净值 |
| `categories` | Categories & Tags | ⬜ | categories、lists（merchants / projects / tags） |
| `budgets` | Budgets | ⬜ | budgets / Planning |
| `reports` | Reports | ⬜ | ledger reports、export、tax preparation |
| `recurring` | Recurring & Bills | ⬜ | recurring |
| `goals` | Goals & Planning | ⬜ | （缺失）coming soon |
| `household` | Household | ⬜ | （缺失）coming soon |
| `forecast` | Cash Flow Forecast | ⬜ | forecast |
| `multi_currency` | Multi-Currency | ⬜ | （缺失）coming soon |

**关键规则：**
- **可见性和功能处理分开。**
  - 关闭 `categories` 只隐藏 Categories 页面。分类、规则和 AI 分类照常运行，All Transactions 里的类别下拉也保留。
  - 关闭 `recurring` 不会停止 `post_auto_recurring` 自动入账，否则会少记账。需要在 UI 中说明这一点，或在模块描述里写明。
  - 关闭 `budgets` 只隐藏页面和提醒，预算数据保留。
- **Settings 永远可见。** 它包含 Feature Library、账户、外观、数据与隐私（客户端现有的 Data 页并入 Settings → Data）。
- **Transactions 和 AI Assistant 可以关闭；全部关闭时**，主区域显示 Settings → Feature Library，并提示"至少启用一个模块"。
- **直接访问被禁用模块的 URL / deep link**：展示"该模块已关闭，[启用]"页面，不报 404，也不丢数据。
- **未实现的模块**在 Feature Library 中显示为 "Coming soon"，开关禁用，不冒充可用功能。

### Default / Manual 模式的去留
- Feature Library 取代"模式"这一概念。
- Manual 模式下的进阶能力（编辑、批量、kind / 账户筛选）**直接对所有用户开放**，放在 All Transactions 的"更多"菜单里。不再用模式控制可见性。
- 现有 `session[:billie_mode]` 与 `useMode` 保留一个版本周期作为兼容层，之后移除。

### 侧栏结构
```
[BillieWeather]
 ▸ Transactions            ← 内部 tabs：Overview | All Transactions | Add & Sync
 ▸ AI Assistant
 ─ 已启用的可选模块（按 manifest 顺序）
 ─────────
 ⚙ Settings                ← Feature Library / Account / Appearance / Data & Privacy
```

---

## 8. Transactions Dashboard Design（Overview）

**可复用：**
- 计算：`finance-core` 的 `buildSnapshot`、`spendingMix`、`spendingPalette`，以及 Rails `Snapshot`、`DashboardPeriod`、`SpendingBreakdown`、`BalanceSync`。
- 样式：`design-tokens`（已有 WCAG 对比度测试）。
- 现有 Dashboard 的 KPI 卡、月度柱条、spending mix、最近交易、未分类提示、转账计数说明。

**组件清单（两端各实现一次，计算统一调用共享函数）：**

| 组件 | 数据来源 | 新增 / 复用 |
|---|---|---|
| `PeriodBar`（预设 + 自定义 + 账户多选） | `DashboardPeriod` / `PeriodPreset` | 复用，新增账户筛选 |
| `KpiTile` × 4（收入、支出、净现金流、余额），每张带"较上期 ±%" | snapshot（本期 + 上期） | 新增 `compareSnapshot(prev, cur)`，放在 finance-core 中，并写 Ruby parity |
| `CashflowTrend`：12 个月收支柱 + 净额折线 | `monthly` | 由 CSS 柱条升级为轻量 SVG（不引入图表库） |
| `CategoryDonut` / `CategoryBars`（支出 / 收入切换） | `spendingMix`，新增 `incomeMix` | 部分新增 |
| `TopMerchants` | 已有的 `CategoryInsights` 逻辑 | 复用 |
| `RecentTransactions`（5–8 条，点击进入 All Transactions 并带上筛选） | 现有 | 复用 |
| `StateExplainer`：转账 N 笔、已排除 N 笔、未分类 N 笔，各配一句话解释 | 现有计数 | 复用并强化 |
| `InsightCard`（AI Assistant 启用且有真实数据时才显示，标明来源 rules 或 openai） | `finance_insights` | 复用 |
| `EmptyState`（无数据时：导入账单 / 手动添加 / 试用演示数据，演示数据须明确标注 "Demo"） | — | 新增 |

**设计原则：**
- 克制的配色：收入用 accent，支出用中性深色，负净额用警示色。
- 数字使用 tabular-nums。
- 图表要有可读的轴标签和 hover / focus 提示。
- 移动端单列、桌面端 12 栅格。
- 深色模式复用 tokens。
- 所有图表提供 `<table>` 形式的可访问替代。

Reports 模块提供 ledger 维度报表、导出、税务准备和净值历史，与 Overview 不重复。

---

## 9. Add & Sync Design

四张能力卡，同一页面：

### 9.1 Connect Financial Accounts — **Future**
| 项 | 内容 |
|---|---|
| 现状 | 两端都不存在任何 provider 代码（已 grep：plaid / teller / yodlee / mx / truelayer / saltedge / gocardless 均为 0） |
| 本期范围 | 只放一张 "Coming later" 卡片，**没有按钮流程**，只放说明与"了解更多"；另外写一份文档 `docs/architecture/account-connectivity-proposal.md` |
| Adapter 设计 | `Finance::Connectivity::Provider` 接口：`link_token` / `exchange` / `sync(cursor)` / `revoke`。同步结果统一转成 `ImportPlan` 的输入行，`entry_origin` 新增 `provider` 值（未来迁移），进入同一条去重 / 分类管线 |
| 数据库（未来） | `finance_connections`（provider、institution、status、encrypted access token 用 Rails `encrypts`、cursor、consent_at、revoked_at）、`finance_connection_syncs`（历史） |
| 安全 | 不存银行凭据；token 只存服务器，用 ActiveRecord Encryption，绝不下发到客户端；用户可随时撤销；记录审计 |
| 复杂度 / 阶段 | 高；需单独批准的未来项目 |

### 9.2 Import Statements
| 项 | 内容 |
|---|---|
| 现状 | 客户端：CSV / TSV / XLSX / OFX / PDF（文本 + 扫描），支持预览、映射、模板、去重、余额核对、导入历史、撤销导入。Web：CSV（只认 ISO 和 US 日期）+ 文本 PDF 草稿复核，支持批量（10 个文件） |
| 缺失 | Web 端 XLSX / OFX；Web 的预览 / 映射；Web 的导入历史与"撤销导入"（目前删除账单是硬删除）；两端都缺 QIF |
| 方案 | 方案 A（推荐）：Web 端用 Ruby 补 XLSX（`roo` 或 `creek`）和 OFX，并以 `finance-core` 的 fixture 做 parity 测试。方案 B：在 Web 端加载 TS 解析器 bundle（类似 `billie-command.js`），浏览器解析，服务器复验。B 去重更彻底，但会给服务器带来信任边界问题，留作后续 |
| 后端 / DB | 新增"撤销导入"：软删除 statement 及其交易，进回收站，再审计。可能要给 `finance_statements` 加 `deleted_at`（新增列） |
| 安全 | 维持现有大小 / 行数 / 超时限制；CSV 导出保持公式中和 |
| 复杂度 / 阶段 | 中；Phase 3 |

### 9.3 Scan & Capture
| 项 | 内容 |
|---|---|
| 现状 | 客户端：设备 OCR，规则解析商户 / 日期 / 总额 / 币种 / 税 / 小费 / 支付方式 / 卡尾号，字段带置信度；可匹配已有交易（exact / probable / ambiguous）；保存前必须复核。Web：完整的 `finance_receipts` 状态机 + 自动对账，但 exact 且完整的小票会被**自动入账**（`receipt_reconciler.rb:36-39,272`） |
| 缺失 | AI 抽取；明细行持久化；客户端本地小票表；税 / 小费结构化存储（目前写在 note 里） |
| 方案 | ① 客户端新增本地迁移 `0010/0011 receipts`，对齐服务器字段。② 可选的 AI 抽取：用户同意后在服务器端调用，**输出只进入 `extraction` jsonb，必须经用户确认才落成交易**，复用现有 status 机。③ 重新审视 Web 的自动入账策略：建议默认改为"exact 时自动关联，新建交易需确认"，或至少保持可撤销 |
| 安全 | 小票图片属于敏感数据；AI 抽取默认关闭，需要用户同意（沿用 `AiCategorizer` 的 consent 模式） |
| 复杂度 / 阶段 | 中高；Phase 3（本地存储）+ Phase 3b（AI 抽取） |

### 9.4 Quick Add
| 项 | 内容 |
|---|---|
| 现状 | `EntryForm` 完整（kind / 金额 / 日期 / 账户 / 转账 / 退款 / 标签 / 商户 / 项目）；命令栏可以预览、确认、撤销，但**没有 add 动作**；没有语音；Siri 未编译 |
| 方案 | ① "Quick Add" 小表单：金额 + 描述 + 回车，其余字段可选；按描述实时调用 `categorizer` 给出类别建议（规则匹配，本地完成，不需要 LLM）。② 在 `billie-commands` 中注册 `transactions.create`（risk: low，必须 preview + confirm，可撤销），让"昨天午饭 38"这类输入走现有的可信执行器。③ 全局快捷键（桌面 ⌘N）。④ 语音 / Siri 留到移动端工程生成后再做 |
| 复杂度 / 阶段 | 低到中；Phase 3（①②③），未来（④） |

**统一管线（所有来源都走同一条）：**
来源 → parse / OCR → normalize（`finance-core/universal` 或 `StatementImporter`）→ classify（`Categorizer` + 可选 AI 建议）→ dedupe（`DuplicateDetector` / `dedupe.ts`）→ match（`ReceiptReconciler` / `matchReceipt`）→ 用户复核 → `Ledger` / `ImportPlan` 持久化 → Snapshot / Forecast / AI。
现状已大致如此；需要补的是 Web 端缺失的格式，以及把"静默跳过的重复行"写入报告。

---

## 10. Recommended Implementation Phases（修订版）

### Phase 0.5 — 完整性修补（新增，建议先做）
- **目标**：清掉会影响后续重构的已知缺陷，让测试恢复全绿。
- **范围**：
  - R1 账户删除前检查 receipts。
  - R2 校验 client API 的 sha256 格式。
  - R3 AiCategorizer 写入时记录 AuditEvent 和 undo batch。
  - 修复 4 个过时的隐私测试 seed，补齐 `billie_receipts.es.yml`。
  - 修正 3 处与实际行为相反的注释。
- **DB**：无。
- **测试**：新增 R1/R2/R3 回归测试；Rails 全绿。
- **验收**：755+ tests、0 failures。
- **回滚**：git revert。
- **复杂度**：低。

### Phase 1a — 模块化外壳
- **目标**：建立 Feature Library、新的默认导航和持久化偏好。
- **范围**：
  - 共享 manifest（`packages/shared-types/src/modules.ts` → JSON → Rails）。
  - 服务器表 `finance_module_preferences` 和 API：`GET/PUT /api/client/v1/module_preferences`，Web 使用同一个 model。
  - Web layout 侧栏改为由 manifest 和偏好驱动。
  - 客户端 `App.tsx`：`NAV` 改为由 manifest 和偏好驱动；新增 `useModules()` hook。
  - Settings → Feature Library 页面（启用 / 可用筛选，coming soon 状态）。
  - 被禁用模块的路由守卫页。
  - 客户端放开 Manual 模式的限制。
- **复用**：`finance_nav`、`NAV` 的图标与 i18n 键；`settings` 键值表（作为离线缓存）。
- **DB**：PG 新表 1 张；SQLite `0010_module_preferences.sql`。两者都只新增。
- **老用户迁移**：老用户**默认启用"该用户过去能看到的模块"**，即 Default 模式全部页面对应的模块。这条规则在读取时计算：用户没有偏好行 + 有财务数据 + 注册早于上线日 → legacy 默认集。**不回填数据。** 新用户只启用 Transactions + AI Assistant。
- **风险**：两端行为不一致；老用户突然"少了页面"。缓解：legacy 默认集 + 一次性提示"可在 Feature Library 自定义"。
- **测试**：见 §12 T1–T6。
- **回滚**：功能开关 `BILLIE_FEATURE_LIBRARY=off` 时回退到旧侧栏；删除新表不影响财务数据。
- **复杂度**：中。

### Phase 1b — 偏好跨设备同步
- **冲突规则（确定性）**：逐模块按 `(updated_at_client, device_id)` 字典序 last-writer-wins；服务器 `revision` 单调递增。
- **离线**：离线修改写入本地 `dirty=1`；联网后推送，服务器返回合并后的结果；客户端用服务器结果覆盖本地非 dirty 项。
- **原则**：用户可见的结果永远等于"最后一次实际点击"。不会静默覆盖：如果推送被更新的远端值击败，提示"已在另一台设备上更改"。
- **复杂度**：中。可以与 1a 合并上线，但要分开验收。

### Phase 2 — Transactions 工作区
- **2a**：Transactions 内部 tabs（Overview / All Transactions / Add & Sync），把现有页面挂到 tabs 下。
  - Overview：上期对比、收入类别、账户筛选、SVG 趋势图、空状态。
  - All Transactions：排序、可见列、"更多"菜单（原 Manual 功能）、手动 link 转账 / 退款 UI。
  - 只新增 `compareSnapshot` 与 `incomeMix`（TS + Ruby + parity 测试）。不改 DB；排序可能需要加索引（新增）。
- **2b**（建议拆出）：拆分交易。需要新的 schema（`finance_transaction_splits` 或 parent_id 方案），并要解决与 refund / transfer 的不变量。要先单独出设计评审。
- **复杂度**：2a 中；2b 高。

### Phase 3 — Add & Sync
- **3a**：页面整合。四张卡：Connect（Future）、Import（复用两端现有能力）、Scan（复用）、Quick Add（新的小表单 + 类别建议 + ⌘N）。
- **3b**：Web 端补 XLSX / OFX 及 parity 测试；"撤销导入"改为软删除；导入报告记录被跳过的重复行。
- **3c**：客户端本地 receipts 表与对账；命令栏新增 `transactions.create`。
- **3d**（可选，需同意）：服务器端 AI 小票抽取，进入复核流程。
- **复杂度**：3a 低，3b 中，3c 中高，3d 中。

### Phase 4 — 跨平台加固与连接设计
- 生成并构建 Windows 安装包；执行 `ios:init` / `android:init`，在模拟器上跑通启动、登录、导入、OCR。
- 针对偏好同步的多设备测试。
- Provider adapter 文档与安全评审（**不接入真实 provider**）。
- 手动记账数据同步的设计文档（P3，单独立项）。
- **复杂度**：高（主要是环境与设备）。

**建议的合并 / 拆分**：
- Phase 0.5 单独做，体量小、风险低。
- Phase 1 拆成 1a / 1b。
- Phase 2 的拆分交易单独做成 2b。
- AI Assistant 的入口整合放进 1a（只是导航）；AI 能力扩展（客户端代理 chat、AI 写入走命令执行器）放进 Phase 3 之后的 "Phase 3e"。

---

## 11. Technical Risks and Migration Strategy

### 已确认的缺陷（只读核验）
| ID | 问题 | 证据 | 影响 |
|---|---|---|---|
| R1 | `AccountsController#destroy` 只检查交易和账单，不检查 receipts；`fk_finance_receipts_bank_account_id_owner` 没有 on_delete | `app/controllers/finance/accounts_controller.rb:97`、`db/schema.rb:960` | 删除被小票引用的账户 → FK 异常 → 500（数据不会丢） |
| R2 | client API `create_statement` 不校验 sha256 格式，只 rescue `RecordInvalid` | `app/controllers/client_api/v1/finance_controller.rb:101` | 坏输入 → `StatementInvalid` → 500 |
| R3 | `AiCategorizer` 用 `update_all` 写入，并可能改动 `kind`；没有 AuditEvent，也不能撤销 | `app/services/finance/ai_categorizer.rb:172-183` | AI 改动无法追溯或回退，违反"高影响修改可审阅、可撤销" |
| R4 | `StatementsController#destroy` 硬删除整张账单及其交易（包括用户编辑） | `statements_controller.rb:34-42` | 有确认步骤，但没有回收站 |
| R5 | Web 小票 exact 时自动入账 | `receipt_reconciler.rb:36-39,272` | 有审计；但与"复核后持久化"原则有张力 |
| R6 | GET 请求带写入（BalanceSync、清理草稿、自动入账 recurring） | `base_controller.rb:58-67` | 锁竞争；模块禁用时**不能**跟着停掉自动入账 |
| R7 | 注释与实际行为相反 | `session_token.rb:6-7`、`client_api base_controller.rb:3-4`、`finance_controller.rb:131-132` | 误导后续维护者和安全评审 |
| R8 | 移动端从未构建 | `src-tauri/gen/` | 不能宣称 iOS / Android 已对齐 |
| R9 | 本地 SQLite 没有静态加密 | `clients/universal/README.md` | 已知限制 |

**说明**：本仓库中不存在名为 "accountsreset" 或 "dataclear" 的破坏性脚本（这两个只是 commit 名）。`Finance::DataDeletion` 需要用户输入邮箱确认，是用户主动发起的删除，应保留。

### 迁移策略
- **只新增迁移**：Phase 1 新增 1 张表；Phase 2b、3b、3c 的新表 / 列逐一另行审批。
- **不动现有交易的 id、uuid、links 和 audit。**
- **Neon**：任何 `db:migrate` 都要先在 Neon 开一个分支库试跑，确认后再对主分支执行，并且**每次都先征求同意**。
- **本地 SQLite**：沿用"迁移前快照"机制（`snapshot.rs`）；新迁移只新增表。
- **老用户**：用 legacy 默认集，在读取时计算，不批量写入。
- **偏好**："没有行 = 默认"，因此删除偏好表即等于回滚。
- **Bullet Train Stripe 遗留**：本期不删表、不删 gem；只在 Phase 4 的安全评审中评估移除，届时另行审批。

---

## 12. Test and Acceptance Plan

| ID | 场景 | 层 | 类型 |
|---|---|---|---|
| T1 | 新用户的侧栏只有 Transactions、AI Assistant、Settings | Web integration + 客户端 vitest | 新增 |
| T2 | Settings 始终可达，即使所有模块都关闭 | 同上 | 新增 |
| T3 | 每个可选模块的启用 / 禁用 → 侧栏即时变化，不刷新页面 | 客户端 vitest；Web 走 Turbo / JS | 新增 |
| T4 | 禁用后，所有 finance 表的行数和 checksum 不变；重新启用后数据完整 | Rails `finance_counts` 风格的断言 | 新增 |
| T5 | 偏好在重启后保留（SQLite 重新打开）与重新登录后保留（服务器） | vitest + integration | 新增 |
| T6 | 两台设备离线修改同一模块 → 按 LWW 规则得到确定结果，并给出提示 | service 单测 | 新增 |
| T7 | 老用户（有数据、无偏好行）看到 legacy 默认集，所有数据可达 | integration | 新增 |
| T8 | Overview 的收入 / 支出 / 净额 / 上期对比等于手算 fixture | `shared_fixture_parity_test` 扩展 | 扩展 |
| T9 | 转账、card_payment 不计入收支；退款冲减支出且不超过上限 | 现有 parity、ledger、refundIntegrity | 保持 |
| T10 | 重复导入同一份账单 → 不重复；重叠账单 → 按 occurrence 计数正确 | `duplicate_import_test`、`universalImport` | 保持 |
| T11 | 小票在用户确认前不生成交易（客户端）；Web 自动入账策略按新决定测试 | receiptCapture、receipt_reconciliation | 扩展 |
| T12 | Quick Add：金额 + 描述 → 一笔交易，类别建议正确 | vitest | 新增 |
| T13 | Add & Sync 中的 Connect 卡片没有任何可提交表单或网络调用 | 静态测试（参照现有 `privacy` 测试） | 新增 |
| T14 | AI 分类写入产生 AuditEvent，并能撤销 | Rails service | 新增（R3） |
| T15 | 响应式：Overview 在 375 / 768 / 1280 宽度下无溢出 | Chrome DevTools（独立 tab，使用测试库 + FactoryBot 合成用户） | 手动 + 截图 |
| T16 | 全部现有测试通过：Rails 755+、vitest 872+、identity-api、billieforecast | CI | 回归 |
| T17 | Windows / iOS / Android 冒烟测试 | Phase 4 | 新增（当前无法执行） |

每个 Phase 结束时提交一份验证报告：测试数、失败数、截图、未覆盖平台说明。

---

## 13. Exact Recommended Next Step

1. **审阅本报告**，确认以下 4 个产品决定：
   - (a) 老用户上线后是否保留 legacy 默认集。建议保留。
   - (b) Default / Manual 模式是否废弃，Manual 的进阶能力是否对所有人开放。建议都是。
   - (c) Web 小票 exact 时自动入账是否改为需要确认。
   - (d) Ledgers / Goals / Household / Multi-Currency 在 Feature Library 中显示为 "Coming soon"，还是暂时不显示。
2. 批准后先做 **Phase 0.5**：修复 R1–R3，更新 4 个过时测试，补 es 翻译，修正注释。不改 schema，目标是 Rails 全绿。
3. 然后给出 Phase 1a 的详细设计，包括 `finance_module_preferences` 迁移的完整 DDL、回滚脚本，以及 Neon 分支试跑计划。**等你批准后再执行迁移。**

---

### 附录：本次执行的非破坏性检查
- `RAILS_ENV=test bin/rails test test/integration test/models test/services test/controllers`：先确认目标是本地 PG 测试库、`DATABASE_URL` 未设置。结果：755 runs，5 failures，0 errors，2 skips。
  - 4 个失败：`privacy_data_deletion_test` 中的 `finance_counts(...).all?(&:positive?)`。原因是 seed 没有创建 Receipt、ReceiptMatch、CaptureToken。
  - 1 个失败：`billie_localization_test`，缺少 `config/locales/billie_receipts.es.yml`。
- `clients/universal`：`npx vitest run` 结果为 65 个文件通过 / 1 个跳过，872 tests 通过 / 12 跳过；`npx tsc --noEmit` 0 错误。
- `services/identity-api`：`uv run pytest` 全部通过（1 skip）。
- `billieforecast`：`uv run --group dev python -m pytest` 55 passed。
- 未执行：GUI 启动、Windows / iOS / Android 构建、任何 Neon 访问、任何迁移。
