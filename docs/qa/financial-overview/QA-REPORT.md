# BillieWeather 财务概览改版验收报告

2026 年 11 月 28 日 · 开发分支 `dev/financial-overview-redesign`

## 预览与对照

[打开本机中文预览](http://127.0.0.1:18479/app?locale=zh-CN)。有历史记录的演示账号为 `populated@example.invalid`，空账号为 `empty@example.invalid`。两个账号都使用此次预览的合成密码 `Preview-Only-2026!`。建议分别在两个浏览器会话中登录，以便并排比较。Web 服务使用独立 PostgreSQL 测试库，绑定本机回环地址。

| 场景 | 改版前 | 改版后 |
| --- | --- | --- |
| 有历史记录的 Web 账本 | [原页面](before-populated.png) | [英文页面](after-populated.png) · [简体中文页面](after-populated-zh-CN.png) |
| 首次使用的 Web 空账本 | [原页面](before-empty.png) | [新版空账本](after-empty.png) |
| 390 像素宽的手机视口 |  | [首屏](mobile-viewport.png) · [整页](mobile.png) |
| 通用客户端与本地 SQLite |  | [WebKit 无头浏览器截图](sqlite-webkit.png) |

有数据的 Web 账本包含 12 周合成收支、支票账户、储蓄、信用卡、投资、欧元钱包和三个定期付款。美元视图显示净资产 33,396 美元、可用资金 21,494 美元、收入 13,230 美元、支出 6,804 美元。选中欧元钱包后可用资金为 280 欧元，收入显示破折号。账本内没有已保存且适用于当前范围的 AI 摘要。

## 已交付

- 默认先展示净资产、可用资金、总收入和总支出。用户还可以启用总资产、负债、净现金流、储蓄率、固定资产、即将到期账单和预算余额。
- 默认组件包括通栏收支趋势图，以及按行排列的消费分类与现金流预测、账户资产与账单、最近交易与 AI 摘要。每个组件可以隐藏、移动和调整宽度。支持拖放、上下移动按钮和恢复默认布局。
- 工具栏包含账本、账户、币种和日期。六个预设自动应用，自定义范围支持校验和显式应用。标题旁显示实际生效的日期范围及币种。Rails 地址可以收藏，桌面端支持切换本机账本。
- 收支趋势支持日、周、月、年聚合。鼠标和键盘都能查看每个时间点的收支与净额。消费分类默认显示前五项，可展开、逐层打开，或跳转到包含后代分类的交易。收入、支出和最近交易的入口也携带适用的筛选条件。
- 预测可切换 30、60、90 天，显示预计余额、首次短缺日期及窗口内最大一笔计划付款。最近交易最多展示六笔，账单列表展示未来 30 天内最早的五笔。一个指标所用的数据发生错误时，其余独立组件仍可操作，失败组件提供重试。
- 空账本保留完整结构，并提供创建账户、添加交易、导入对账单入口。原有的现金录入、对账单账户别名维护迁至「账户与资产」。侧栏继续沿用现有模块顺序与可见性。
- 覆盖英语、简体中文、繁体中文、日语、韩语、西班牙语。共享展示层使用区域化日期、数字、货币格式以及用户时区。图表有可访问名称，布局编辑有键盘替代操作，页面支持减少动态效果。

## 架构与数据边界

Rails 和通用客户端复用同一组 React 指标卡、筛选控件、组件容器、图表、状态组件和布局编辑器。各端保留各自已经存在的数据所有权、身份与导航体系。Rails 的网页入口以及同源请求代码单独放在 `clients/universal/web`，桌面端的 SQLite 读取路径不依赖 Web 入口。Web 的 JS 和 CSS 与仓库内命令栏采用相同的预构建方式，重新构建命令为 `node clients/universal/scripts/build-overview.mjs`。此次未增加第三方依赖。

Rails 的 `Finance::OverviewData` 提供当前登录用户的分项只读 JSON。收支时间序列按日聚合，分类按路径返回，最近交易限定六笔。复用现有交易分类、余额观测、预算期间和定期规则。SQLite 端使用现有财务状态、账本存储和 `@billie/finance-core`。布局、金额展示以及汇总口径由共享模型处理。打开概览不触发新的外部 AI 或汇率请求。

布局以版本 1 保存至按用户区分的 `localStorage`，同一用户在同一客户端重启后仍会保留。Web 浏览器与桌面安装各自保存，不跨设备同步。此次没有 PostgreSQL 或 SQLite 迁移，没有改写现有侧栏偏好。隔离分支底部的本地快照保留了原工作区已有的 82 项变动，其中包含先前的侧栏工作，这些不属于本次改版。

## 财务口径

| 指标 | 计算方式及边界 |
| --- | --- |
| 净资产 | 已纳入净资产的资产余额减负债，按币种单独计算。手工现金快照与净资产所纳入的活期账户范围一致时，用该快照替代对应现金小计，防止重复相加。信用类账户的负余额按正的欠款展示。纳入项缺少可靠余额时显示破折号。归档账户遵循各端已有账户模块规则，Rails 以净资产纳入标记为准，本地账本的净资产排除归档账户。 |
| 可用资金 | 未归档的现金、支票、储蓄和支付应用账户。投资、应收款、固定资产、信用额度不计入。全账本可采用已录入且不会与手工账户重计的现金快照，另计已申报的手持现金。无法确认的账户余额不会当成零。 |
| 余额与日期 | 资产卡按用户所在时区的当天取值，独立于历史收支筛选。有可靠日期的对账单余额加上此后已入账的变动，手工账户以期初余额及截至当日的有效变动为准。混币且无法确认币种归属的账户金额显示破折号。 |
| 收入、支出、净现金流 | 收入取已计入的收入类记录。支出按支出及退款的带符号净额，退款冲减相应类别。内部转账、信用卡还款、余额调整以及被排除的记录不进入收支。净现金流等于收入减净支出。发生过转账但净收支为零的时段可显示零，完全没有记录的时段显示破折号。 |
| 储蓄率与比较 | 储蓄率为净现金流除以收入，收入大于零时显示。月、年预设分别比较前一个日历月、日历年。滚动及自定义区间比较此前等长区间。收支卡在两期有记录时展示绝对变动。全部时间和缺少前期数据时不生成比较。 |
| 分类 | 按层级汇总净支出。占比以当前层级的净支出合计为分母，仅在分母大于零时展示百分比。 |
| 预测 | 复用现有历史均值线性算法。要求已知的可用资金，近 90 天内至少有 3 个有效交易日，首末活动日覆盖至少 14 个日历日。用首个有效日到今天的含首尾日数计算日均净流量。预测值为当前可用资金加日均净流量乘以未来天数。计划付款单列，避免对历史均值重复扣除。 |
| 账单与预算 | 只采用既有、启用的定期支出及其计划日期、金额和账户。预算余额取当前账本预算月的单一全账本额度减同期净支出。有重叠预算、账户筛选或不匹配的币种时不推测额度。 |
| 固定资产与 AI | 当前没有可用的固定资产估值模型，固定资产显示破折号。Web 可读取用户此前授权生成并保存的通用 AI 摘要，显示生成日期，只在适用账本范围展示。桌面端没有对应的本地摘要存储，保留 AI Insight 入口。 |

## 验证结果

| 验证项 | 结果 |
| --- | --- |
| Rails、PostgreSQL | 财务模型、服务、Web 与客户端 API 集成测试共 653 项，5,811 个断言全部通过。单独复核了带币种与账户条件的 CSV、退款冲减，以及登录 API 时区字段，共 16 项、189 个断言通过。 |
| 通用客户端 | 除 Apple Vision 原生 OCR 专项外，99 个测试文件、1,305 项测试全部通过。此次广泛回归启用了 Chrome 通道，单项测试上限设为 20 秒。另以默认上限重跑了概览财务模型和交互，7 项通过。 |
| 无头端到端 | Rails + Chromium 的合成历史账本及空账本均通过。SQLite + Chromium、SQLite + WebKit 各自的有数据与空账本案例均通过。共六组。Web 另验证一个组件返回 503 后独立恢复、账户与币种切换、收支与分类明细、键盘与拖放、保留侧栏设置、全部六种语言和 360–1,440 像素视口。 |
| 静态与构建 | TypeScript 类型检查、Vite 客户端构建、Rails 页面资源构建、变更 Ruby 文件的 StandardRB、共享页面源文件的 Prettier 及 Rails Zeitwerk 自动加载检查均通过。Vite 报告主 JS 包超过默认体积提示阈值，构建成功。 |
| macOS QA | 最终代码构建成功。独立 QA 应用完成 ad hoc 签名、包标识、隔离存储路径和回环地址检查，原生二进制返回的源码版本与开发提交一致。复制到交付位置后再次预检通过。 |
| Apple Vision OCR | 在首次广泛回归中，11 个识别案例触发该测试用的 25 秒子进程超时。单独重试一张合成对账单图片也返回 `ETIMEDOUT`。此次未改动 OCR 实现或其超时限制，原生 OCR 识别能力仍未验证通过。 |

当前构建的桌面源码版本为 `be5c111`。QA 使用独立应用标识 `com.billieweather.client.qa.overviewdev`、独立存储目录和回环服务地址。签名与身份预检均在未打开窗口的条件下执行。QA 产物保存在独立工作树的 `tmp/overview-qa/BillieWeather QA overviewdev.app`。[打开本地 QA 产物](../../../tmp/overview-qa/BillieWeather%20QA%20overviewdev.app)单独的身份服务未在此次预览中启动，完整的桌面登录流程未做实机验收。

## 验证范围与发布状态

- 网页回归覆盖有记录和空账本、退款与还款、外币账户、分类下钻、日期比较、真实零与未知、历史不足、AI 缺失、键盘及拖放、宽度、布局恢复和持久化。浏览器测试故意让账单请求失败，在其余组件可用的情况下重试并恢复。
- 在独立进程执行 macOS QA 原生二进制的身份预检。SQLite 端的界面交互使用无头 Chromium 和 WebKit 验证。未打开桌面应用窗口。真实原生窗口中的焦点、系统辅助技术和交互手感仍需人工验收。
- 六种语言的每套仪表盘文案均包含 90 个相同的键。已验证关键正文及链接在明暗主题下达到 4.5∶1，三条图表数据系列达到 3∶1。
- 预览没有外币折算、固定资产估值或跨设备布局同步。历史均值预测未提供概率区间。后端现有的高级预测和完整 AI 分析继续在各自的模块中使用。
- 独立工作树为 `billieweather-overview-dev`。原工作树保留在 `main` 的 `5e1c68e`，保留的 82 项改动与隔离前的 Git 内容树一致。仅在独立工作树提交。未推送、合并、安装 Stable 或部署生产。发布前需要用户审阅界面、数据口径和上述边界，并另行授权发布。

## 复现与文件清单

合成数据脚本会检查 Rails 环境、数据库名和测试账号是否已存在。将 Rails 配置为独立测试数据库 `overview_test`，设置 `OVERVIEW_TEST_PASSWORD` 后，可通过 `bundle exec rails runner docs/qa/financial-overview/seed.rb` 生成数据。Rails 回归套件使用另一个数据库 `overview_test_suite`。SQLite 冒烟脚本给每次运行建立干净浏览器上下文，并拦截非预览来源的请求。

- Rails 浏览器测试脚本为 `clients/universal/scripts/overview-web-smoke.mjs`，读取 `OVERVIEW_ORIGIN`、`OVERVIEW_TEST_PASSWORD` 和可选的 `CHROMIUM_EXECUTABLE`。
- SQLite 测试脚本为 `clients/universal/scripts/overview-smoke.mjs`，设置 `OVERVIEW_WEBKIT=1` 可切换至 WebKit，设置 `OVERVIEW_EMPTY=1` 可测试空账本。
- 仅查看本次开发改动可执行 `git diff be9b8c9..dev/financial-overview-redesign`。下列清单含开发文件、测试、报告与截图。

- [`app/controllers/client_api/v1/base_controller.rb`](../../../app/controllers/client_api/v1/base_controller.rb)
- [`app/controllers/finance/bank_accounts_controller.rb`](../../../app/controllers/finance/bank_accounts_controller.rb)
- [`app/controllers/finance/dashboard_controller.rb`](../../../app/controllers/finance/dashboard_controller.rb)
- [`app/controllers/finance/profiles_controller.rb`](../../../app/controllers/finance/profiles_controller.rb)
- [`app/controllers/finance/transactions_controller.rb`](../../../app/controllers/finance/transactions_controller.rb)
- [`app/models/finance/recurring_rule.rb`](../../../app/models/finance/recurring_rule.rb)
- [`app/services/finance/cash_flow_forecast.rb`](../../../app/services/finance/cash_flow_forecast.rb)
- [`app/services/finance/dashboard_period.rb`](../../../app/services/finance/dashboard_period.rb)
- [`app/services/finance/overview_data.rb`](../../../app/services/finance/overview_data.rb)
- [`app/views/finance/accounts/index.html.erb`](../../../app/views/finance/accounts/index.html.erb)
- [`app/views/finance/dashboard/_accounts.html.erb`](../../../app/views/finance/dashboard/_accounts.html.erb)
- [`app/views/finance/dashboard/_rename_account.html.erb`](../../../app/views/finance/dashboard/_rename_account.html.erb)
- [`app/views/finance/dashboard/index.html.erb`](../../../app/views/finance/dashboard/index.html.erb)
- [`app/views/finance/transactions/index.html.erb`](../../../app/views/finance/transactions/index.html.erb)
- [`app/views/layouts/billie.html.erb`](../../../app/views/layouts/billie.html.erb)
- [`clients/universal/scripts/build-overview.mjs`](../../../clients/universal/scripts/build-overview.mjs)
- [`clients/universal/scripts/overview-smoke.mjs`](../../../clients/universal/scripts/overview-smoke.mjs)
- [`clients/universal/scripts/overview-web-smoke.mjs`](../../../clients/universal/scripts/overview-web-smoke.mjs)
- [`clients/universal/src/App.tsx`](../../../clients/universal/src/App.tsx)
- [`clients/universal/src/commands/handlers.ts`](../../../clients/universal/src/commands/handlers.ts)
- [`clients/universal/src/overview/Overview.tsx`](../../../clients/universal/src/overview/Overview.tsx)
- [`clients/universal/src/overview/charts.tsx`](../../../clients/universal/src/overview/charts.tsx)
- [`clients/universal/src/overview/layout.tsx`](../../../clients/universal/src/overview/layout.tsx)
- [`clients/universal/src/overview/local.ts`](../../../clients/universal/src/overview/local.ts)
- [`clients/universal/src/overview/messages.json`](../../../clients/universal/src/overview/messages.json)
- [`clients/universal/src/overview/model.ts`](../../../clients/universal/src/overview/model.ts)
- [`clients/universal/src/overview/overview.css`](../../../clients/universal/src/overview/overview.css)
- [`clients/universal/src/pages/Accounts.tsx`](../../../clients/universal/src/pages/Accounts.tsx)
- [`clients/universal/src/pages/Dashboard.tsx`](../../../clients/universal/src/pages/Dashboard.tsx)
- [`clients/universal/src/pages/Transactions.tsx`](../../../clients/universal/src/pages/Transactions.tsx)
- [`clients/universal/src/services/account.ts`](../../../clients/universal/src/services/account.ts)
- [`clients/universal/test/categoriesPage.test.tsx`](../../../clients/universal/test/categoriesPage.test.tsx)
- [`clients/universal/test/dashboardOverview.test.tsx`](../../../clients/universal/test/dashboardOverview.test.tsx)
- [`clients/universal/test/dataPage.test.tsx`](../../../clients/universal/test/dataPage.test.tsx)
- [`clients/universal/test/featureLibrary.test.tsx`](../../../clients/universal/test/featureLibrary.test.tsx)
- [`clients/universal/test/moduleGuards.test.tsx`](../../../clients/universal/test/moduleGuards.test.tsx)
- [`clients/universal/test/overviewModel.test.ts`](../../../clients/universal/test/overviewModel.test.ts)
- [`clients/universal/test/welcome.test.tsx`](../../../clients/universal/test/welcome.test.tsx)
- [`clients/universal/test/workflow.test.tsx`](../../../clients/universal/test/workflow.test.tsx)
- [`clients/universal/tsconfig.json`](../../../clients/universal/tsconfig.json)
- [`clients/universal/web/overview.tsx`](../../../clients/universal/web/overview.tsx)
- [`docs/qa/financial-overview/QA-REPORT.md`](../../../docs/qa/financial-overview/QA-REPORT.md)
- [`docs/qa/financial-overview/after-empty.png`](../../../docs/qa/financial-overview/after-empty.png)
- [`docs/qa/financial-overview/after-populated-zh-CN.png`](../../../docs/qa/financial-overview/after-populated-zh-CN.png)
- [`docs/qa/financial-overview/after-populated.png`](../../../docs/qa/financial-overview/after-populated.png)
- [`docs/qa/financial-overview/before-empty.png`](../../../docs/qa/financial-overview/before-empty.png)
- [`docs/qa/financial-overview/before-populated.png`](../../../docs/qa/financial-overview/before-populated.png)
- [`docs/qa/financial-overview/mobile-viewport.png`](../../../docs/qa/financial-overview/mobile-viewport.png)
- [`docs/qa/financial-overview/mobile.png`](../../../docs/qa/financial-overview/mobile.png)
- [`docs/qa/financial-overview/seed.rb`](../../../docs/qa/financial-overview/seed.rb)
- [`docs/qa/financial-overview/sqlite-webkit.png`](../../../docs/qa/financial-overview/sqlite-webkit.png)
- [`public/billie.css`](../../../public/billie.css)
- [`public/financial-overview.css`](../../../public/financial-overview.css)
- [`public/financial-overview.js`](../../../public/financial-overview.js)
- [`test/integration/client_api_test.rb`](../../../test/integration/client_api_test.rb)
- [`test/integration/finance_account_balances_test.rb`](../../../test/integration/finance_account_balances_test.rb)
- [`test/integration/finance_accounts_overview_test.rb`](../../../test/integration/finance_accounts_overview_test.rb)
- [`test/integration/finance_dashboard_period_test.rb`](../../../test/integration/finance_dashboard_period_test.rb)
- [`test/integration/finance_default_modules_links_test.rb`](../../../test/integration/finance_default_modules_links_test.rb)
- [`test/integration/finance_feature_library_test.rb`](../../../test/integration/finance_feature_library_test.rb)
- [`test/integration/finance_manual_mode_test.rb`](../../../test/integration/finance_manual_mode_test.rb)
- [`test/integration/finance_report_export_test.rb`](../../../test/integration/finance_report_export_test.rb)
- [`test/integration/finance_workflow_test.rb`](../../../test/integration/finance_workflow_test.rb)
- [`test/integration/google_sign_in_test.rb`](../../../test/integration/google_sign_in_test.rb)
- [`test/integration/nickname_personalization_test.rb`](../../../test/integration/nickname_personalization_test.rb)
- [`test/integration/session_csrf_test.rb`](../../../test/integration/session_csrf_test.rb)
