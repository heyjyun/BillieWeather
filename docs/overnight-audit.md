# BillieWeather 夜间审计报告(QA 之后的稳定化、安全与优化)

日期:2026-11-11 · 基线提交:`2c3de35 fixdrop1`(`origin/main` 同此) · 本次修改:**全部未提交、未推送、未部署**

状态标记:
- ✅ 本机实际执行验证
- 🧪 自动化测试或模拟验证
- ⚠️ 未验证
- 🔒 需要外部凭据、硬件或你的批准

---

## A. 执行摘要

**整体健康度:良好。**
- 网站端没有发现跨用户数据访问漏洞:每个财务查询都按当前用户限定,并用跨用户测试复现确认。
- 导入是原子的,重复文件有数据库唯一索引保护。
- 金额全程使用整数分或 BigDecimal,没有浮点。
- 客户端的网络出口受 CSP 限制,只能访问一个源;没有自动上传财务数据。

**最重要的风险(尚未修复,需要你决定):**
1. **P0:同一台设备上的本地数据库不属于任何账号。** 账号 B 在账号 A 用过的设备上登录后,会自动发生以下情况:
   - 把 B 的云端数据合并进 A 的本地库;
   - 删除 A 从网站下载的副本,包括 A 在本机改过的分类;
   - 把 A 的数据库信息(名称、条数、日期范围)上报到 B 的网站账号。

   修复需要产品决策,方案见 §C.3。
2. **P1:信用卡还款和退款会抬高收入与支出**(网站和客户端都有)。本次修好了最常见的一类("PAYMENT - THANK YOU" 这种带标点的写法),但完整修复需要按账户类型(现金或信用卡)判断,见 §D。

**本次最有价值的改进:**
- **Keychain 按构建变体隔离**:正式版沿用原来的条目名,现有用户不会被登出;开发版、QA 版、测试版再也无法读写正式版的令牌。
- **macOS 应用二进制从 18.0 MB 降到 7.76 MB(−57%)**:Apple 和 Android 构建不再打包永远用不到的 Tesseract OCR 资源。
- 修复 4 个数据完整性或安全缺陷:
  - "新建数据库"可能清空被遗忘的数据库;
  - 用户主动选的"未分类"会被覆盖;
  - 2FA 验证码可以无限次猜;
  - 导出 CSV 时自定义分类名可以注入公式。
- 交易搜索词不再写入日志。

---

## B. 既有 QA 成果的保全

| 项目 | 状态 |
|---|---|
| 13 项 QA 修复 | ✅ 已在提交 `2c3de35 fixdrop1` 中(你在 QA 报告之后提交了它们;报告写的"未提交"已过时)。本次没有改动这些文件里的相关规则。 |
| QA 报告 | ✅ 已复制到 `docs/qa/2026-11-11-ui-qa/QA-REPORT.md`,文件顶部注明了来源 |
| 证据 | ✅ 机器可读的结果放在 `evidence/`(布局审计、交互结果、构建日志、518 个 Rails 测试的输出),审计脚本放在 `scripts/`。约 32 MB 的截图**没有**放进仓库,以免仓库变大;它们仍在旧会话的临时目录里,临时目录被清理后就没有了。 |
| 不包含 | 脚本读取的开发预览账号密码文件 `preview-pass.txt` 故意没有复制 |
| 基线复核 | ✅ 本次开始时重新运行:客户端 461/461 通过,typecheck 通过 |

此前的修复都在 `2c3de35` 中,本次的修改都在工作区(见 §L),两者没有混在一起。

---

## C. 安全与数据完整性

### C.1 Keychain 凭据隔离(✅ 已实现,🧪 已测试)

**问题:** `session.rs` 写死了服务名 `com.billieweather.client`。因此:
- 任何其他构建都会共用并覆盖正式版的登录令牌,包括 `desktop:dev`、`cargo test`、QA 或 beta 包;
- 之前的 QA 构建因此只能完全不登录。

**实现:**
- 服务名改为运行时的 bundle identifier。
- 正式版(release 构建、identifier 为 `com.billieweather.client`)得到的服务名与原来**完全相同**,现有用户不会被登出,也不需要迁移。
- debug 构建(`desktop:dev`、`cargo test`)使用 `<identifier>.dev`。
- 其他 identifier 的构建(例如 `com.billieweather.qa`、`.beta`)各有独立条目。
- Android 和 Linux 的令牌文件本来就在按 identifier 区分的数据目录里;debug 构建现在还改用 `session.dev.token`。

**测试:** `session.rs` 中新增 4 个 Rust 单元测试:
- 固定正式版的条目名不变;
- debug 构建永远不会用到正式版的条目名;
- QA 和 beta 构建的条目名互不相同;
- `cargo test` 一定以 debug 方式编译,所以测试只能接触 `.dev` 条目。

`cargo test` 6/6 通过,clippy 无警告。

**遗留问题(🔒 需要你决定):** `desktop:dev` 使用和正式版相同的 identifier,所以也使用相同的**数据目录**。也就是说,开发版会打开你真实的本地数据库,并对它执行迁移。今后如果开发分支加了新迁移,一次 `desktop:dev` 就会迁移你的真实库。
- 建议:让 `desktop:dev` 通过 `--config` 使用独立的 identifier(例如 `com.billieweather.client.dev`)。
- 代价:开发版会从空库开始。
- 因为这会改变你的开发习惯,本次没有自动执行,只在 README 里写明了。

### C.2 网站端(Rails)

- **跨用户访问 ✅🧪:**
  - 所有财务控制器都通过 `current_user.finance_*` 加载数据;
  - 用测试复现了"删除或修改他人的账单和交易",结果是 404 或重定向,记录不受影响。
- **管理后台:** 由 `DEVELOPER_EMAILS` 控制。
- **重复文件:** 按文件 SHA-256 判断,有 `(user_id, sha256)` 唯一索引,检查时持有行锁。
- **导入原子性:** 单个文件在一个事务中导入。
- **服务端限制:** 2 MB、5,000 行、20 页、10 个文件。
- **金额:** 使用 BigDecimal,不用浮点。
- **密钥:** 仓库及其历史里没有 master.key 或 .env。
- **AI:** 必须在服务端确认同意(consent)后才调用,并且 `store: false`。

### C.3 客户端(Tauri / 本地 SQLite)

- **网络出口 ✅:**
  - CSP 只允许一个 API 源;
  - 账单只在用户明确点击"同步到云端"并确认后才上传;
  - AI 分类只发送清洗过的商户名;
  - 启动时只会自动:获取账号信息、从网站下载副本、上报白名单内的数据库元数据。
- **SQL 注入:** 全部使用参数绑定。
- **导入:** 通过 staging 表和触发器实现原子导入,文件哈希去重,并按账户识别重叠的交易。
- **日期和货币:** 不猜测日/月顺序;"$" 不默认当作美元。
- **地区自动识别:** 不会覆盖用户的明确选择,只给建议,需要用户点击确认。

**🔴 P0(未修复,🔒 需要产品决策):本地数据库没有所属账号**
- 原因:
  - 数据库列表 `billie.databases` 是整台设备共用的;
  - 登出只清除令牌;
  - 登录后 `syncFromWeb` 会自动写入当前打开的数据库;
  - `applyWebData`(`store.ts:871-876`)会删除"当前账号下载内容里没有的网站副本"。
- 后果:账号 B 登录后,
  - A 的网站副本被删除,其中 A 在本机改过的分类会丢失;
  - B 的数据混入 A 的库;
  - A 的数据库元数据被上报到 B 的账号;
  - 如果 B 再手动点"同步到云端"或"AI 分类",A 的数据会以 B 的身份发出去。
- 已核实:相关代码路径本次逐一读过,子代理用合成数据复现了这一过程。
- 为什么本次没有修:客户端只有 email,没有稳定的账号 ID(email 可能会变);而且"另一个账号登录时应该怎么办"是产品决策。可选方案:
  - ① 每个账号使用各自的数据库列表(推荐);
  - ② 弹窗询问;
  - ③ 直接阻止。
- 建议方案:
  1. 服务端在 `/api/client/v1/account` 返回一个不可变的账号 ID;
  2. 每个库在 `settings` 里记录 `owner_account_id`;
  3. 没有记录的旧库,由第一次登录的账号认领,这样你现有的数据不受影响;
  4. 所属账号不一致时,停止自动下载、元数据上报、云同步和 AI 分类,并在界面上说明原因。

  风险为 MEDIUM,需要你批准。

---

## D. 缺陷修复

| # | 严重度/风险 | 问题与根因 | 文件 | 证据 | 状态 |
|---|---|---|---|---|---|
| 1 | P1 / LOW | **"新建数据库"可能永久清空一个现有数据库。** 应用存储(localStorage)丢失后,数据库列表只剩 1 号槽位;新建时会复用 2 号槽位并执行 `deleteAllData` 加 `VACUUM`,而 2 号槽位里其实还有数据。 | `useFinance.tsx`, `store.ts`(`hasContent()`) | 新测试 `dataPage.test.tsx`"creating a database never wipes…";去掉修复后该测试会失败 | ✅ 已修:有内容的槽位会重新加回列表,永不清空,新库改用下一个空槽位 |
| 2 | P1 / LOW(部分修复) | **信用卡还款被算成收入。** 转账规则要求逐字匹配 "payment thank you",所以 "AUTOPAY PAYMENT - THANK YOU"、"ONLINE PAYMENT, THANK YOU" 会被归为 Income。 | `categorizer.rb`, `finance-core/categorizer.ts` | Ruby 和 TS 各新增一组相同的测试,包括反例("COMCAST AUTOPAY" 仍是 Utilities,"PAYMENT THANK YOURSELF SPA" 仍是 Income);Ruby↔TS 一致性测试通过 | ✅ 短语之间允许出现标点和空格,两端使用同一组分隔符。**没有**加入 `autopay`,因为水电网费的自动扣款是真实支出。已导入的数据保持原分类,只影响以后的导入 |
| 3 | P2 / LOW | **2FA 验证码可以无限次猜。** 应用登录 API 中,验证码错误不计入锁定次数,唯一的限制是按 IP 每分钟 10 次。 | `client_api/v1/sessions_controller.rb` | 新测试;用原来的控制器运行该测试会失败 | ✅ 验证码错误计入同一个锁定计数(20 次),完整登录成功后清零(与网站一致)。注:只有配置了 AR 加密密钥时 2FA 才会启用 |
| 4 | P3 / LOW | **用户主动设为"未分类"的交易,在下次导入或保存规则时被改掉。** | `store.ts`(`automaticTransactions()`) | 新测试 `store.test.ts`;去掉修复后该测试会失败 | ✅ 规则和导入后的重新分类都跳过 `category_source='user'` 的行(只改客户端;Rails 没有这个字段,见 §K) |
| 5 | P3 / LOW | **导出交易 CSV 时,自定义分类名可以注入公式**(`=HYPERLINK(…)`) | `transactions_controller.rb` | 新集成测试 | ✅ 分类名也经过 `TransactionCsv.safe_text` 处理 |
| 6 | P3 / LOW | **交易搜索词(例如 "pharmacy")写入了日志** | `filter_parameter_logging.rb` | 新测试 | ✅ 已加入 `:search` |
| 7 | P3 / LOW | `device.rs` 的注释写"设备名从不发送",实际会作为数据库元数据上报(README 中已说明) | `device.rs` | 对照代码 | ✅ 已改正注释 |

**已确认但未修复(详见 §K):**
- 客户端仪表盘的"最新账单余额"只取最新一张账单的余额。如果最新的是信用卡账单,显示的就是负数。Rails 已有按账户汇总的逻辑(`AccountOverview`),客户端需要移植。P2 / MEDIUM。
- 本地库之间的复制(`mergeData`)和网站下载(`applyWebData`)不是原子操作,中途被杀会留下行数不全的账单。P2 / MEDIUM。建议改用现有的 staging 机制。
- AI 分析的 1 分钟冷却可以被同时发出的两个请求绕过,最多多一次付费调用。P3。根治需要新的时间戳列,也就是需要数据库迁移。
- 英国、欧元区用户导入网站 CSV 时,`03/04/2026` 一律按美式 月/日 解析。P2 / LOW,需要先决定对模糊日期是拒绝还是询问。
- 应用令牌无法单独吊销(只有改密码才会失效)。P3,需要迁移。
- 应用 API 允许每张账单 50,000 行,网站只允许 5,000 行。P3。

---

## E. 架构

- **重复的业务逻辑:** 财务逻辑有 Ruby 和 TS 两份实现。这是有意为之:网站在服务端,客户端离线运行。共享的测试夹具和两端的一致性测试(`shared_fixture_parity_test.rb`、`parity.test.ts`、`snapshot-parity.test.ts`)保证两份实现同步。本次的分类修复两端同步修改,一致性测试通过。**不建议**合并成一份实现。
- **已漂移的地方:** 余额汇总。Rails 已经升级到按账户汇总,客户端还停在旧版 `snapshot.rb` 的单余额逻辑。建议下一步移植(P2)。
- **小的冗余(未处理,收益很小):**
  - `public/billie-tokens.css` 和 `packages/design-tokens/dist/tokens.css` 内容相同,都由生成器写出,属于有意设计;
  - `public/heroku-logo.png` 与 `app/assets/images/logo/icon.png` 完全相同,来自 Bullet Train。
- **本次完成的简化:** 只做了局部改动,没有做结构性重构,因为没有足够的收益证据。

---

## F. 应用体积

| 测量项 | 修改前 | 修改后 | 变化 |
|---|---|---|---|
| 仓库受跟踪的源码 | 5.89 MB / 1,120 个文件 | 基本不变(docs 增加约 0.36 MB) | — |
| 客户端前端 dist(浏览器、Windows、Linux) | 21 MB | 21 MB | 不变(这些平台需要 Tesseract) |
| 客户端前端 dist(macOS、iOS、Android) | 21 MB | **3.3 MB** | **−84%** |
| macOS 主程序(release, aarch64) | 17,997,136 B | **7,759,696 B** | **−57%** ✅ 在独立目录中实际构建 |
| macOS .app / .dmg | 17 MB / 14.3 MB | 预计约 7.8 MB / 约 6 MB | ⚠️ 只构建了主程序(`--no-bundle`),没有重新打 dmg |
| 主 JS 包 | 764 KB(gzip 239 KB) | 不变 | — |

**依据:**
- macOS 的 `ocr_capabilities` 在编译期就固定返回 Apple Vision;iOS 和 Android 走原生插件;
- 所以 Tesseract(3 个 WASM 内核加 3 个语言模型,约 10 MB)在这三个平台上永远不会被加载;
- 通过实际构建确认,Tauri CLI 设置的是 `TAURI_ENV_PLATFORM=darwin`;
- 构建出的主程序里已找不到任何 tesseract 字符串;
- 新测试 `ocrAssetsPlatform.test.ts` 锁定了各平台的结果。

**依赖情况:**
- `sql.js` 在运行时被 import(浏览器预览用),却被列为 devDependency。目前没有影响,建议改到 dependencies。
- 根目录 `@esbuild-plugins/node-globals-polyfill`、`postcss-nested`、`@neon/env` 找不到任何使用处,可能可以删除。未删除:Bullet Train 升级时可能会重新需要。
- Bullet Train 的 `application.js` 有 2.55 MB,其中 zxcvbn 占 800 KB。它只在账号页面加载,财务页面不加载。

**本地磁盘(未自动清理,由你决定):**
- `src-tauri/target` 5.4 GB;
- `bundle/macos` 下有一个 32.5 MB 的 `rw.*.dmg`,是失败的打包残留;
- `log/test.log*` 约 200 MB;
- `billieforecast/.venv` 891 MB,其中 torch 占 597 MB。

---

## G. 性能

- 启动时不会立即加载重型模块:pdfjs、tesseract、sql.js 都是按需动态 import。
- 已识别、未修改:6 种语言的文案全部打进主包(i18n 约 136 KB)。按需加载每种语言可以减少约 100 KB(gzip 约 30 KB),收益较小,列为可选项。
- 没有发现有证据支持的明显瓶颈,所以没有做推测性的微优化。
- 本次没有进行大账单基准测试(⚠️)。现有导入上限是 20,000 行(客户端)和 5,000 行(网站)。

---

## H. 质量保证

| 套件 | 结果 |
|---|---|
| 客户端 vitest(含 finance-core、reporting、design-tokens) | ✅ **466/466**(基线 461,新增 5 个) |
| 客户端 TypeScript typecheck | ✅ 通过 |
| Rust `cargo test` | ✅ 6/6(新增 4 个),clippy 无警告 |
| Rails 全套测试 | ✅ **527 个测试,0 失败,0 错误**,2 个跳过(与 QA 时相同)。本次新增 4 个;本次没有单独测基线,QA 报告记录的是 518 个 |
| macOS release 构建(独立 target 目录,`--no-bundle`) | ✅ 成功 |
| Vite 浏览器构建与 darwin 构建 | ✅ 成功;浏览器构建仍包含 3 个语言模型 |

每个修复都做了"去掉修复后测试应该失败"的变异检查:槽位清空、2FA、用户选择的分类这三项已逐一确认。

**测试中没有接触任何真实数据:**
- Rails 只用测试数据库;
- 客户端只用内存 sql.js 和合成数据;
- 没有打开 `~/Library/Application Support/com.billieweather.client`;
- 没有发出付费 API 请求;
- 没有使用真实的 Google 凭据。

**未验证(⚠️):**
- 网站真实的 Google 登录;
- 真实的 OpenAI 调用;
- 启用 AR 加密后的真实 2FA 流程(测试中是模拟的);
- 装好的应用中 Keychain 的实际行为:只有单元测试覆盖,没有在已安装的正式版上验证升级后仍保持登录。逻辑上服务名完全相同,所以应当保持登录。

---

## I. 跨平台就绪度

| 平台 | 已验证 | 未验证 |
|---|---|---|
| Web | ✅ Rails 全套测试;QA 时的 Chromium 审计 | Safari 和 Firefox 的逐页渲染 |
| macOS | ✅ release 构建;Keychain 逻辑有单元测试;Apple Vision 分支 | 本次没有启动修改后的应用(启动会打开真实数据库) |
| Windows | 🧪 Tesseract 资源保留;Credential Manager 使用相同的服务名逻辑 | 🔒 需要 Windows 机器或 CI 构建 |
| iOS | 🧪 已确认走 Apple Vision 插件,去掉 Tesseract 不影响功能 | 🔒 需要完整 Xcode;从未构建 |
| Android | 🧪 已确认走 ML Kit,去掉 Tesseract 不影响功能 | 🔒 需要 JDK、SDK、NDK;从未构建 |

**功能对齐建议(按优先级):**
1. 账户余额汇总:直接移植 `AccountOverview`。这是正确性问题,不只是功能缺失。
2. 预测:先移植历史均值模型(纯计算、离线可用);Prophet 和 Chronos 依赖服务端,应保持只在网站提供,或者只发送日汇总数据并征得同意。
3. Insights:先移植基础分析(本地规则);AI 分析复用现有的同意面板模式。
4. Tax:属于美国税务整理范围,建议先只在网站提供。

---

## J. UI/UX 评估(基于 QA 截图;没有访问外部设计参考)

**现存的弱点(证据来自 QA 截图):**
- **网站仪表盘里有营销内容:**
  - 页面标题 "A clearer financial picture." 和 eyebrow;
  - 侧栏的 "A little clarity goes a long way.";
  - 底部 "Let your numbers tell you more" 推广卡。

  这些占用了首屏空间,却不提供数据。效率型工具(例如 Toggl)的首屏通常直接是数据。
- **空状态占空间太大:** 网站的 "Credit cards" 空卡片高约 330px;"Money in. Money out." 图表下方有大片空白。
- **余额卡片文字太多:** 网站的余额卡片有 4 行说明;应用只有一行 "as of"。
- **两端不一致:**
  - 应用显示 ISO 日期 `2026-10-29`,网站显示 `Oct 29, 2026`;
  - 应用显示月份 `2026-06`,网站显示 `Jun 2026`;
  - 标签不同:"Spending" 与 "Total expenses","Latest statement balance" 与 "Cash balance from statements";
  - 转账金额在应用中显示为红色,在网站中是中性色。
- **复数处理:** "transaction(s)"、"statement(s)" 写死在 6 种语言的文案里,没有复数规则。

**可以低风险做的小改进(本次未做,原因见下):**
- 应用改用 `Intl.DateTimeFormat` 显示日期;
- 统一两端的 KPI 标签;
- 转账金额统一使用中性色。

这些改动涉及 6 种语言的文案和 UI 测试的断言。按你的要求,不和稳定性工作混在一起。

**需要单独批准的设计提案:**
- 去掉应用内页面的营销标题和推广卡;
- 首屏改成"时间段 + 4 个 KPI + 图表";
- 空状态折叠成一行提示;
- 引入 i18n 复数规则(`Intl.PluralRules`)。

---

## K. 剩余风险与需要你批准的决定

| 优先级 | 决定 | 风险 |
|---|---|---|
| P0 | 本地数据库归属到账号(§C.3):需要服务端返回账号 ID,并决定另一个账号登录时的行为 | MEDIUM |
| P1 | 信用卡还款和退款的完整处理:按账户类型(cash/credit)判断还款,退款冲减支出;Ruby 和 TS 同步修改 | MEDIUM |
| P1 | `desktop:dev` 使用独立的 identifier 和数据目录,保护真实数据库不被开发迁移改动 | LOW(但会改变你的开发习惯) |
| P2 | 客户端移植按账户汇总余额 | MEDIUM |
| P2 | `mergeData` 和 `applyWebData` 改为原子操作 | MEDIUM |
| P2 | 网站对非美元用户的 `d/d/yyyy` 日期:拒绝还是询问 | LOW |
| P3 | AI 冷却的原子认领、应用令牌吊销(两项都需要迁移) | MEDIUM |
| P3 | Rails 记录"用户主动选择的分类"(需要迁移),与客户端行为对齐 | MEDIUM |
| — | 生产环境要求 `REDIS_URL`:否则限流按进程计算,多进程时形同虚设 | 运维 |

---

## L. Git 摘要

- 本次开始时工作区是干净的;此前的 13 项 QA 修复都在 `2c3de35` 中。
- **以下全部是本次的新修改**(未提交):

```
M  app/controllers/client_api/v1/sessions_controller.rb   2FA 失败计入锁定
M  app/controllers/finance/transactions_controller.rb      CSV 分类名防公式注入
M  app/services/finance/categorizer.rb                     转账短语允许标点
M  config/initializers/filter_parameter_logging.rb         过滤 :search
M  packages/finance-core/src/categorizer.ts                同 Ruby
M  clients/universal/src-tauri/src/session.rs              Keychain 按变体隔离
M  clients/universal/src-tauri/src/device.rs               注释更正
M  clients/universal/src/hooks/useFinance.tsx              新建数据库不再清空遗忘的库
M  clients/universal/src/services/store.ts                 hasContent();跳过用户选择的分类
M  clients/universal/vite.config.ts                        Apple/Android 不打包 Tesseract
M  clients/universal/.gitignore                            coverage/
M  clients/universal/README.md                             Keychain 隔离说明;测试数 461
M  test/integration/client_api_test.rb                     新测试
M  test/integration/finance_workflow_test.rb               新测试 ×2
M  test/services/finance/categorizer_test.rb               新测试
M  packages/finance-core/test/core.test.ts                 新测试
M  clients/universal/test/dataPage.test.tsx                新测试
M  clients/universal/test/store.test.ts                    新测试
?? clients/universal/test/ocrAssetsPlatform.test.ts        新测试
?? docs/                                                   本报告与 QA 归档
```

- **确认:** 没有提交、没有推送、没有部署;没有数据库迁移;没有修改生产数据或你的本地财务数据库;没有执行破坏性的 git 命令。
- 构建产物只写到会话临时目录和已被忽略的 `clients/universal/dist`。

---

## M. 建议的下一步

**必须做的稳定化工作(按影响排序):**
1. P0 本地数据库归属账号(影响高 · 风险中 · 约 1–2 天)
2. 信用卡还款和退款的完整处理(影响高,直接影响所有总额 · 风险中 · 约 1 天,含两端测试夹具)
3. `desktop:dev` 隔离数据目录(影响中 · 风险低 · 约 0.5 小时)
4. 客户端按账户汇总余额(影响中 · 风险中 · 约 0.5–1 天)
5. 合并和下载的原子性(影响中 · 风险中 · 约 0.5 天)
6. 生产环境配置 Redis(影响中 · 运维)
7. 在 CI 中构建 Windows、iOS、Android,并在真机或模拟器上冒烟测试(影响中 · 需要硬件或 CI)

**可选的改进:**
- 非美国日期处理(P2);
- 按需加载各语言文案;
- 清理本地构建残留(约 4–5 GB);
- 删除根目录未使用的依赖;
- 把 `sql.js` 改到 dependencies;
- UI 设计阶段(§J);
- 功能对齐(§I)。
