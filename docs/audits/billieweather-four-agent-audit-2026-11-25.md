# BillieWeather / FinRx 四智能体工程审计报告（2026-11-25）

- 集成候选分支：`audit/four-agent-2026-11-25`（worktree `billieweather-audit`），基于本地 `main` 1656256；未推送、未合并到 main、未部署。
- 团队：Chief（集成与最终验收）+ Agent A（架构与数据完整性）+ Agent B（产品/UX/跨平台）+ Agent C（QA/安全/发布）。三名成员为独立后台子智能体（本环境无"团队"原生工具），由 Chief 分派任务、转交交叉审查并独立复核关键结论。
- 证据目录：`docs/audits/evidence/four-agent-2026-11-25/`（`chief/` 任务板与回归日志，`agent-a|b|c/findings.md` 与原始日志，`agent-b/rc3-native-checklist.md`）。
- 证据等级：**已确认（代码）**、**已复现（测试）**、**假设**、**未测试**。

---

## 1. 已核实的仓库与阶段基线

| 项目 | 实际状态（2026-11-25 Chief 核实） |
|---|---|
| 仓库结构 | `billieweather`、`billieweather-roadmap`、`billieweather-dualmac` 共用同一个 `.git` |
| `billieweather` | 分支 `phase-1a-modular-shell` @ e4380af（= origin/main），114 个未提交文件（75 M / 39 ??）。已完整归档为提交 8f6d0a3（分支 `archive/phase1a-checkpoint`），**未在 main 中**。本次审计未触碰该工作区。 |
| 本地 `main` | 1656256，比 origin/main 领先 70 个提交，**从未推送**，因此 CI 从未构建 0.9.0-beta.1 |
| `billieweather-roadmap` | `autonomous-development` @ 34a2aeb（= rc2 源码），18 个未跟踪的 Phase 6.3 证据文件（另一会话产生） |
| 并发进程 | 开发栈 :3000（Rails，`.env.local` 指向 Neon）、:8100 identity、:1420 Vite；roadmap 会话 :38530/:38531 + 临时 PG；另一会话的 `run-e2-retry.sh` 正在等待桌面空闲以驱动原生 QA 应用 `com.billieweather.client.qa.p63`。全部未触碰。 |
| 构建产物 | `ClaudeGenerated/phase6.3-rc1`、`phase6.3-rc2`（个人版 DMG + QA DMG + 0.1.0 QA app）、`checkpoint-phase6.3` bundle |
| 已安装应用 | `/Applications/BillieWeather.app` 及多个 QA 数据目录，未替换、未卸载 |

隔离措施：每个成员独立的临时 PG 集群（55431/55432/55433，Chief 55440）、独立 Rails/identity 端口、`DATABASE_URL`/`NEON_*`/`RENDER_*` 一律清除，从未读取 `.env.local`；未进行任何原生 GUI 操作（桌面被另一会话占用且未获授权）。

**流程事故（已处理）**：A 与 C 在共享 scratchpad 中都使用了同名指针文件 `scratchpad/pgdir`，清理时删除了对方/B 的临时 PG 目录。仅涉及会话临时测试库，无用户数据；经核对 B、C 的测试结果均在删除前完成，结论不受影响。之后所有成员改用唯一命名路径。

## 2. 当前架构与推荐架构

### 2.1 当前架构（A 绘制，Chief 抽查确认）
```mermaid
flowchart LR
  subgraph Device["Tauri 客户端（仅 macOS arm64 实际构建）"]
    UI[React UI clients/universal/src] --> SQLP[vendored tauri-plugin-sql 2.6 / sqlx 0.9]
    SQLP --> S1[(SQLite 槽位 1..8 billieweather[-N].db\nsettings.owner_account_id)]
    UI --> REG[localStorage：账户书册注册表 + 模块偏好 v1/v2]
    UI --> OCR[Apple Vision OCR 子进程]
  end
  subgraph Server["Render（未触碰）"]
    RAILS[Rails web + /api/client/v1] --> PG[(Neon Postgres — 权威数据源)]
    ID[identity-api FastAPI] --> PG
  end
  UI -- Bearer token --> RAILS
  UI -- 登录 --> ID
  RAILS -- 账单行、商户规则、自定义分类 --> UI
  UI -- 显式传输：账单、DB 元数据、收据、AI 分类请求、模块偏好 --> RAILS
```
- 不同步：手工/收据/周期性条目，账户、标签、预算、链接（单向/不对称同步，A-12）。
- identity-api 直接写 `users/teams/memberships`（第二写入者，A-11，已有兼容测试缓解）。

### 2.2 数据关系
- 服务器：每个 finance 子表都有复合 owner 外键（`db/schema.rb:983-1031`）；账单幂等键 `(user_id, sha256)`；收据文件存于 `private_database` 服务（Postgres 表 `private_storage_files`）。
- 本地：10 个只进不退的迁移，外键开启；"回滚" = 恢复 `.bak`/自动副本；数据目录单进程锁；书册归属记录在文件内（`settings.owner_account_id`）。
- 模块偏好：本地 localStorage + 服务器 `finance_module_preferences`（随账户删除级联删除；"删除我的财务数据"不删除——轻微隐私问题，待产品决定）。

### 2.3 推荐目标架构（不重写）
1. **原生打开闸门**（已部分落地）：每次打开都迁移并校验 `_sqlx_migrations` = 1..`LOCAL_SCHEMA_VERSION`，失败时保留迁移注册，仅允许已注册槽位文件名。后续：迁移前快照与版本校验合并为单一原生命令。
2. **单一行入口流水线**：plan → 行级去重（复用 finance-core）→ 单批次写入（已用于网站下载；`mergeData` 待迁移）。
3. **服务器副作用仅在写入时发生**：GET 不加锁不写（A-09，待做）；导入后续步骤失败不影响已提交导入（已落地）。
4. **发布后**：基于 uuid 的实体级同步（解决 A-12/A-15）。
- 取舍：保持 vendored 插件补丁最小化以便跟随上游；单锁串行化所有槽位的打开（C 指出慢迁移会阻塞其他槽位，可接受）。

## 3. 平台功能完整度矩阵（B 编制，A/C 交叉审查）

图例：IT 已实现且有测试 · ST 占位/即将推出 · NB 有代码但从未构建/编译。

| 功能 | Web（Rails） | macOS arm64 | macOS Intel / Windows / iOS / Android |
|---|---|---|---|
| 认证 | IT | IT（Keychain） | NB |
| 引导 + 必填昵称 | IT（新注册）；老账户仅可关闭的提示（B-05） | IT（jsdom） | NB |
| Transactions | IT | IT（vitest；原生 a1/c1 于 rc1） | NB |
| AI Assistant | IT（服务器端） | 部分：命令与 AI 分类；洞察跳转网站；**无原生证据** | NB |
| Settings / Feature Library | IT | IT（原生 a1 于 rc1） | NB |
| CSV 导入 | IT（XLSX/OFX 无） | IT（0.9 构建无原生证据） | NB |
| PDF 导入 | IT（文本 PDF） | IT（jsdom）；**无原生证据** | NB |
| 收据 OCR | 默认 ST（需 `BILLIE_LOCAL_OCR_COMMAND`） | IT（Apple Vision + Tesseract）；真实引擎测试本次均被跳过 | NB |
| 手工录入 / 审核确认 | IT | IT | NB |
| 重启后持久化 | IT | IT（rc1 原生：17 表 1334 行一致） | NB |
| 撤销/重做 | 部分（批次/命令撤销） | IT（vitest；原生 c2 于 rc1） | NB |
| 深色模式 / 6 语言 | IT | IT | NB |
| 连接金融账户 | ST | ST | ST |

已移除的金融服务功能：未发现可达入口；"Connect Financial Accounts"即将推出卡片仍在（B-12，待产品确认）。

## 4. 缺陷登记册（按优先级）

未发现 P0（无数据丢失或可直接利用的安全漏洞）。

### P1
| ID | 等级 | 证据 | 位置 | 问题 | 状态 |
|---|---|---|---|---|---|
| A-01 | P1 | 已确认（代码）+ C 对抗审查维持且升级 | `vendor/tauri-plugin-sql/src/commands.rs:35` | 迁移列表在执行前被移除；失败后同进程"重试"/切换书册会打开**未迁移**的库并跳过降级防护 | **已修复** 5003593、eebc421 |
| A-04 | P1 | 已复现 | `clients/universal/src/services/store.ts:1186-1294` | 网站下载仅按文件哈希去重，同一行来自不同文件会重复入库，支出翻倍 | **已修复** d21fb21、a05b222 |
| B-01 | P1 | 已复现（CI 日志 31/31 失败） | `clients/universal/vite.config.ts`；根 `postcss.config.js` | Windows 桌面 CI 构建加载 Rails 的 PostCSS 配置而失败 | **已修复（待推送后 CI 确认）** 4dac268 |
| B-02 | P1 | 已确认 + 原生日志 | `test/helpers.ts`、`useModules.tsx`、Rails `base_controller.rb` | 测试无法区分"模块关闭"与"功能缺失"（Categories 假失败根因） | **已修复（自动化测试层）** ab37461；原生脚本需其所有者修改 |
| C-01 | P1 | 已确认（二进制溯源） | Phase 6.3 证据 | 原生 a1/b1/c1/c2/e1 运行于 **rc1**（07f5ec4，exe 2b6ad246…）而非 rc2（34a2aeb，exe 186f5483…） | 记录；rc3 须重跑 |
| C-02 | P1 | 已确认（代码）/ 端到端未测试 | `src/services/databases.ts:154` | "0.1.0 拒绝 schema-10 书册"、恢复自动副本、再次升级从未在原生上通过 | 新增 Rust 降级防护测试；**原生仍未验证** |
| B-09 | P1（发布声明） | 已确认 | `clients/universal/README.md` | README 声称 Windows "已在 CI 配置" 等，与证据不符 | **已修复** b0287a5 |

### P2（已修复）
| ID | 问题 | 提交 |
|---|---|---|
| A-03 | Rust/TS 的 schema 版本与 `MAX_DATABASES` 无一致性测试 | 5003593 |
| A-05 | 账户/审计/自定义分类在原子批次外写入，失败留下幽灵账户，空书册被误判为"有内容" | d21fb21（`mergeData` 仍残留） |
| A-06 | 导入已提交但后续重分类/余额同步失败时报告"导入失败"，重试提示"已导入" | 0289c5f、84182ab、1d825a1 |
| A-14 / C-09 | 插件 `load` 接受任意 `sqlite:` 路径 | 55700fe |
| C-04 | `/api/client/v1/*` 对任意来源返回 `ACAO: *` 并允许 Authorization | e2c986d、e082c12 |
| C-06 | 收据决策 `public_send` 仅靠路由约束 | 77246a2 |
| C-08 | 限流从未测试；生产无 Redis 时静默退化 | b451a96（仅告警，不改启动） |
| C-10 | Android/Linux token 文件先写后 chmod | 70c1a08（未在目标平台编译） |
| C-11 | QR 迁移 `down` 会删除已存文件 | af17a4d |
| C-12 | CI 缺 cargo test / identity pytest / 依赖审计；PG 版本为 11 | 76142fe（PG 17 为**假设**，需 `SHOW server_version` 确认） |
| B-03 | 默认用户可见链接通向"模块已关闭"页面（含删除前导出） | 2a75027 |
| B-06 | Transactions 保存错误显示为绿色成功状态 | 3f1352b |
| B-07 | AI 分类意外错误未处理、无提示 | 8114db3 |
| S1 | 不完整/被修改的 schema 错误映射为"其他"/"更新版本" | b0616a2 |
| S4 | 同一槽位第二次加载遗留旧连接池 | eebc421 |

### P2（未修复 / 待决定）
| ID | 问题 | 原因 |
|---|---|---|
| A-02 | 快照保留仅按时间保留 2 份，可能丢失唯一能被旧版本打开的副本；大小不含 `-wal`；`.partial` 不清理 | 时间不足，排入下一迭代 |
| A-07 | 两个无账户标识 CSV 中的相同行被静默跳过 | **产品决定**（有文档化夹具） |
| A-09 / A-10 | finance GET 加锁并写入；"待核对收入"计数上限 2000 | 下一迭代 |
| A-11 / A-12 / A-15 | 第二写入者；同步不对称；服务器删除覆盖本地编辑 | 架构项，发布后 |
| A-13 | 删除书册保留 `.bak`、删除前无副本 | 下一迭代 |
| B-04 / B-05 / B-08 / B-12 | 命令忽略模块状态；老账户昵称非强制；关闭核心模块后的起始页；"连接金融账户"卡片 | **产品决定** |
| B-10 / B-11 | Web 与 App 撤销不对等；模块同步无 UI 级测试 | 记录 |
| C-05 | Web CSP 无 `script-src` | 建议先上 report-only |
| C-07 | `config/secrets.yml` 提交了 dev/test `secret_key_base` | **所有者操作** |
| S6 | AI 分类失败写 console 日志 | Chief 拒绝：`privacy.test.ts` 明确禁止客户端日志，保持该隐私决定 |
| A-08 | 收据文件在事务内删除 | **已被 C 证伪**（文件存于 Postgres，随事务回滚）；759459e 增加了固定此行为的测试 |

## 5. 根因分析与修复（摘要）

- **A-01**：上游插件 `migrations.remove(&db)` 在 `migrate` 之前执行，失败即永久丢失该库的迁移注册。修复：保留注册、每次 load 都运行迁移器（无待执行迁移时仅校验 10 个校验和）；只允许已注册名称；已打开的库复用连接池；失败时关闭新池。Chief 核实：客户端唯一加载点 `platform.ts:13`，所有 8 个槽位均在 `lib.rs:126-127` 注册，不会误拒真实书册。
- **A-04**：`applyWebData` 只比较文件哈希。修复：对本地非手工、非网站来源行调用 finance-core `detectDuplicates`，仅跳过"自动重复"，真实相同消费与"可能重复"保留；跳过数显示在同步状态（6 语言）。
- **B-01**：Vite 向上查找 PostCSS 配置，在 Windows 上未在客户端目录停止，加载了运行 `bundle exec bin/theme` 的 Rails 配置。修复：内联空 PostCSS 配置；C 验证 macOS 下 CSS 输出字节一致（76,643 B）。
- **B-02 / Categories 假失败**：可选模块默认关闭，偏好存于 WebView localStorage，QA 种子只写账本；后续重试按精确标签 "Categories" 点击，而实际标签是 "Categories & Tags"，导致开启步骤本身失败（C 采纳 B 的反驳后修正）。修复：测试辅助抛出 `ModuleDisabledInTest`，无 Provider 时按目录默认值，Rails 新增 `assert_module_page`/`assert_module_disabled`。
- **迁移界面竞态（e1）**：固定 4 秒等待后读取屏幕，只读到窗口标题；rc2 上 e2 两次观察到 PASS，但之后的尝试均在步骤前因"QA app did not quit"失败——结论为"rc2 上观察到通过，尚不可复现"。
- **A-06**：后续步骤在事务外抛出普通异常。修复：已提交导入只记录（类名 + 首行消息，避免 PG DETAIL 中的行值）并在 Web 通知中提示；处于调用方事务内时重新抛出以保持批次原子性。

## 6. 已执行测试与可复现命令

公共前置：`unset DATABASE_URL`，清除 `NEON_*`/`RENDER_*`；`export PATH="$HOME/.local/share/mise/installs/ruby/4.0.3/bin:$PATH"`；临时集群 `initdb -D <dir> -U postgres -A trust && pg_ctl -D <dir> -o "-p <port> -k <sock> -c listen_addresses=127.0.0.1" start`；`RAILS_ENV=test DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/<db> bin/rails db:create db:schema:load`。Chief 脚本见 `chief/regress.sh`（日志 `chief/regress-*.log`、`chief/final-*.log`）。

| 阶段 | 套件 | 命令 | 结果 |
|---|---|---|---|
| 基线（main 1656256，C） | Rails 全量 | `bin/rails test` | 858 测试，0 失败，2 跳过 |
| 基线（C） | 客户端 | `npx tsc --noEmit && npx vitest run` | tsc 干净；1178：1165 通过，13 跳过 |
| 基线（C） | identity-api | `pytest`（及 `IDENTITY_RAILS_COMPAT=1`） | 129 通过 1 跳过；130 通过 |
| 基线（C） | Rust | `cargo test --offline --locked` | 41 + 3 通过 |
| 基线（C） | 迁移 | 回滚 32 个再迁移 | 可逆，schema 一致（空库） |
| 基线（C） | 依赖 | bundle-audit / npm audit / cargo audit / brakeman | 0 漏洞；cargo 5 个不再维护 + 1 unsound（传递依赖）；brakeman 3 警告；pip-audit 未安装 |
| 基线（B） | Rails 集成 | `bin/rails test test/integration …module_catalog_test.rb` | 439，0 失败 |
| 基线（B） | 无头 Web 走查 | `walk.mjs`/`walk2.mjs`（playwright-core + headless-shell 1255，:3212 测试环境） | 复现 B-03；深色模式正常 |
| 中期集成（Chief，b670c9e） | Rails 全量 | 同上 | 881，0 失败，0 错误，2 跳过；行覆盖率 90.9% |
| 中期集成（Chief） | tsc / vitest | 同上 | 干净；1183 通过，13 跳过 |
| 中期集成（Chief） | cargo app / plugin | `cargo test --offline --locked`；`-p tauri-plugin-sql` | 43+3；5+1 通过 |
| 最终集成（Chief，8fa8303） | 全部 | 同上 | 见 §6.1 |

### 6.1 最终回归（8fa8303）
| 套件 | 结果 |
|---|---|
| Rails 全量（隔离 PG14 :55440） | 886 测试，31709 断言，0 失败，0 错误，2 跳过；行覆盖率 90.9% |
| `tsc --noEmit` | 干净 |
| vitest | 91 个文件（90 通过，1 跳过）；1203 测试：1190 通过，13 跳过，0 失败 |
| cargo（app） | 43 + 3 通过 |
| cargo（`-p tauri-plugin-sql`） | 6 + 1 通过 |

日志：`evidence/four-agent-2026-11-25/chief/final-*.log`；脚本：`chief/regress.sh`。

**未运行 / 限制**：Rails system 测试（26 个文件，无构建资产/Chrome）；真实 OCR 引擎测试（13 个，受 `skipIf` 保护）；任何原生 GUI；Windows/iOS/Android/Intel 构建；GitHub CI（不允许推送）；对 Neon 的任何查询。

## 7. 数据完整性与安全评估

- **数据完整性**：服务器端 owner 外键与幂等键健全；本地主要风险（A-01 未迁移打开、A-04 重复入库、A-05 幽灵账户）已修复并有回归测试。剩余：A-02 快照保留策略、A-13 删除书册无副本、`mergeData` 的 A-05 残留、A-15 同步覆盖。
- **安全**：tracked 文件与全部 128 个提交历史中未发现密钥；client API 会话为服务器端可撤销；identity-api token/签名校验正确；OCR 子进程有超时与大小限制。已修复 CORS 通配、`public_send`、token 文件权限竞态、插件路径逃逸。剩余：C-05 CSP、C-07 dev/test 密钥、生产 Redis 依赖（限流）。
- **隔离**：本地书册归属判断逻辑正确，但不是安全边界（同一 OS 用户目录、未加密）。

## 8. Phase 6.3 收尾状态

| 项目 | 状态 |
|---|---|
| Categories 假失败 | **已诊断（测试设计缺陷）**：模块默认关闭 + 标签重命名；rc2 上 e2 部分匹配点击两次通过。自动化层已修复（B-02）。原生脚本修正归另一会话所有者。 |
| 迁移界面过早读取 | **rc2 上观察到通过，尚不可复现**（之后尝试在步骤前失败）。 |
| 原生回滚（0.1.0 拒绝 schema-10、恢复副本、再升级） | **未关闭**。 |
| 撤销栏 rc2 原生 | 未证明。 |
| 最新 RC 独立通过 | **否**：多数原生运行用的是 rc1；本次修改改变了原生打开路径，需构建 **rc3** 并按 `agent-b/rc3-native-checklist.md` 的 10 项检查重跑。 |

## 9. 各平台 GO / CONDITIONAL GO / NO-GO

| 平台 | 结论 | 条件 / 理由 |
|---|---|---|
| Web（Rails） | **CONDITIONAL GO** | 需推送并通过 CI；所有者确认 `SECRET_KEY_BASE`/master key；生产必须配置 `REDIS_URL`；确认 Neon PG 主版本；部署前在 Neon **分支**上做迁移演练 |
| macOS Apple Silicon | **个人自用 CONDITIONAL GO；对外分发 NO-GO** | 必须构建 rc3 并通过 10 项原生检查（尤其 #3 失败迁移重试、#4 降级拒绝）；未签名、未公证 |
| macOS Intel | **NO-GO** | 从未构建 |
| Windows | **NO-GO** | 从未成功构建；B-01 修复待 CI 验证 |
| iOS | **NO-GO** | 从未编译，需完整 Xcode |
| Android | **NO-GO** | 从未编译，需 JDK/SDK/NDK |

## 10. 剩余阻塞项、发布依赖与下一步优先级

**阻塞项**
1. 构建 rc3（集成分支）并在**桌面空闲且获授权**时运行原生 10 项检查；须等另一会话的 e2 结束，串行使用桌面。
2. 推送一个审查分支以运行 CI（Windows 构建、cargo、identity、审计）——需用户单独授权推送。
3. 所有者操作：Neon PG 版本确认、`SECRET_KEY_BASE` 移除、master key 校验、Redis。

**产品决定**：A-07、B-04、B-05、B-08、B-12、模块偏好是否纳入"删除财务数据"。

**下一迭代（工程）**：A-02 快照保留；`mergeData` 原子化；A-09 GET 无副作用；A-13 删除前副本；C-05 CSP report-only；"可能重复"的审核界面；原生 QA 脚本修正（由其所有者）。

### 集成分支提交（均为本地提交，未推送）
| 提交 | 内容 |
|---|---|
| 1a35f23 | 合并 C：e2c986d C-04、77246a2 C-06、70c1a08 C-10、af17a4d C-11、b451a96 C-08、76142fe CI |
| 2e0033f | 合并 A：5003593 A-01/A-03、55700fe A-14、d21fb21 A-04/A-05、0289c5f + 84182ab A-06、759459e A-08 测试 |
| b670c9e | 合并 B：4dac268 B-01、ab37461 B-02、3f1352b B-06、8114db3 B-07、2a75027 B-03、b0287a5 B-09 |
| （e082c12 合并） | C S5：仅开发/测试环境的额外应用来源 |
| 8fa8303 | 合并 A 第二轮：b0616a2 S1、a05b222 S2、1d825a1 S3、eebc421 S4 |

---

## 中文总结

**已完成**
- 基线核实、三名成员并行审计、交叉审查（A↔B、B↔C、C↔A）、最终独立复审，全部完成；未发现 P0。
- 修复 23 个提交，覆盖 A-01（重试打开未迁移书册）、A-04（网站下载重复入库）、A-05、A-06、A-14、B-01、B-02、B-03、B-06、B-07、B-09、C-04、C-06、C-08、C-10、C-11、CI 及 S1–S4；均已集成到 `audit/four-agent-2026-11-25` 并通过全量回归（见 §6.1）。
- A-08 被证伪并以测试固定；C 修正了自己的 Phase 6.3 结论。

**部分验证**
- B-01 Windows 构建修复仅在 macOS 上验证，需 CI。
- C-10 token 文件修复未在 Android/Linux 编译。
- Categories 与迁移界面问题：根因已定，但最新构建上的原生证明不完整。
- CI 工作流修改仅做了 YAML 语法校验；PG 17 为假设。

**受阻**
- 原生 GUI（rc3 10 项检查、原生回滚）：桌面被另一会话占用且需授权。
- 推送/CI、Neon 版本确认、生产密钥与 Redis：需用户/所有者操作。

**未测试**
- Rails system 测试、真实 OCR 引擎、macOS Intel / Windows / iOS / Android 的任何构建、对 Neon 的任何操作（按规则禁止）。
