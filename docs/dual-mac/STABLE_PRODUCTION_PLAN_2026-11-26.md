# BillieWeather Stable / Dev 分离：生产核查与受控发布计划（2026-11-26）

状态：**G0、G1 已于 2026-11-26 完成（见文末“G0/G1 结果”）；G2–G4 未执行，等待一次性统一授权。** 任何生产数据库变更、Render 部署和 Stable 客户端安装，都需要所有者对下面每个闸门（G1–G4）分别明确授权。

## 目标

| | BillieWeather Stable | BillieWeather Dev |
| --- | --- | --- |
| 标识符 | `com.billieweather.client`（不变） | `com.billieweather.client.dev`（`npm run desktop:dev`，已有） |
| 账户服务 | 托管生产 API `https://web-68wd.onrender.com` | `localhost:3000` / `localhost:8100` |
| 云数据库 | Neon `production`（br-damp-sea / ep-raspy-sound） | 独立 Neon Development Project（odd-firefly-71205607） |
| 本地账本 | 原有 `~/Library/Application Support/com.billieweather.client/billieweather.db` | `…/com.billieweather.client.dev/`，与 Stable 完全隔离 |
| 账户 | 真实账户（原 owner ID 不变） | 合成测试账户 |

## 一、核查结果（2026-11-26 11:00Z 前后，均为只读）

| 项目 | 结果 | 依据 |
| --- | --- | --- |
| 托管 Rails 在线 | 是，冷启动约 60 秒，随后 `/up` 200 | curl |
| Render 运行版本 | e4380af（11-23）；63958b0 之后的部署都在启动时失败并回滚 | 既有记录 |
| CORS 允许 Stable 客户端来源 | 是：`tauri://localhost`、`http://tauri.localhost`、`http://localhost:1420` 预检均 200 | OPTIONS 预检 |
| `/api/client/v1/session`、`/account` | 存在；无令牌时 `/account` 返回 401 JSON | curl |
| 返回 `owner_id`（本地账本绑定所需） | 是，e4380af 的 `account_json` 已包含 `owner_id: finance_owner_uid` | `git show e4380af` |
| Render 连接的数据库 | **很可能**是 Neon production：本机进程只连 ep-cold-brook，而 ep-raspy-sound 在探测 Render 后变为 active（last_active 11:02:28Z） | Neon API、`lsof` |
| 生产库结构 | 有 `users.finance_owner_uid`、`identity` schema；**缺少** `user_sessions`、`finance_module_preferences`、`finance_module_preference_mutations`、`billie_release.target` | Neon schema API（仅结构） |
| 真实账户是否在生产库、是否被锁定/未确认 | **未核实**。只读查询被本机权限策略拦下 | — |
| identity API 托管服务 | 不存在（Render 上只有 web） | 既有记录 |
| 本地真实账本 | schema v9；transactions 0、statements 0（与 11-22 记录一致） | `sqlite3 -readonly` |
| Neon 恢复窗口 | 21600 秒（6 小时） | Neon API |
| 已有生产快照分支 | `release-predeployment-20261125`（01:08Z）及其子分支 `release-migration-rehearsal-20261125`；两者均尚未应用 3 个新迁移 | Neon API |

### 当前客户端（HEAD，0.9.0-beta.1）对 e4380af 服务端的兼容性

| 功能 | 对 e4380af |
| --- | --- |
| 登录、读取/修改账户、`owner_id` 绑定 | 可用 |
| 退出登录 | 只删除本地令牌；e4380af 的令牌是无状态签名，服务端无法撤销，到期前仍然有效 |
| 离线退出补撤销 `/session/revocations`、"退出其他会话" `/sessions` | 404，失败 |
| 功能库同步 `/module_preferences` | 404，同步报错 |
| 注册、Google 登录（identity API） | 没有托管服务，不可用 |

**结论：** 现有托管 API 在协议上已能支持真实账户登录，但目前还不能直接使用，原因有三：

1. 已安装的 0.1.0 把 `localhost:3000/8100` 编译进了程序，必须重新构建 Stable 客户端。
2. 真实账户在生产库中的状态尚未核实。
3. e4380af 缺少服务端会话撤销和功能库同步，与当前客户端只是部分兼容。

推荐路线是把服务端升级到 HEAD（三个都是只新增的迁移），而不是让新客户端去适配旧服务端。

## 二、发布闸门

### G0：补齐核查（只读，需要所有者许可或亲自执行）

1. 只读查询生产库（`default_transaction_read_only=on`，只输出计数和布尔值）：迁移版本、真实账户是否存在（按 owner ID 前缀）、`confirmed`、`locked`、`failed_attempts`、当前连接来源。脚本已准备好，未执行。
2. 通过 Render API 确认：`DATABASE_URL` 的主机是否为 ep-raspy-sound；Build/Start Command；是否已有 `SECRET_KEY_BASE` / `BILLIE_SECRET_KEY_BASE`；Auto-Deploy 是否为 Off。
3. 通过 Render CLI 诊断最近三次启动失败。

### G1：用生产副本演练（不改生产；需授权，因为会复制真实数据到新分支）

1. 新建分支 `release-rehearsal-<日期>`，父分支为 production 的当前状态。免费版分支数量有限，必要时先删除 `migrate-test-nickname`，删除前需单独确认。
2. 用 owner 直连 URL，在演练分支上：创建运行时角色 `billie_rails_runtime`（只给 DML），插入 marker（`environment=staging`，独立的 target_id），然后在固定提交上运行 `bin/billie-release rails`。
3. 只读验证：`schema_migrations` 新增 20261123000100、20261124000100、20261125000100；用户数、`finance_owner_uid` 和账本行数在迁移前后一致；运行时角色没有 DDL 权限，也不能写 marker。
4. 演练不启动本地开发服务器，不把任何 `.env` 指向演练分支。演练结束后删除该分支。

### G2：生产数据库迁移（需明确授权）

1. 冻结：Render 保持 e4380af；记录固定的发布提交（推荐打 tag `v0.9.0-beta.2-server`）。
2. 恢复点：新建 `release-predeploy-<时间>` 分支（父分支为 production 当前状态）。不要依赖 6 小时窗口。
3. 以 owner 身份走直连端点：创建 `billie_rails_runtime`（和 `billie_identity_runtime`，如果 G3b 一起做），设置 GRANT 和 DEFAULT PRIVILEGES，撤销 PUBLIC 的 CREATE，创建 marker（`environment=production`）。
4. 运行 `BILLIE_RELEASE_APPROVAL=<变更号> bin/billie-release rails`，凭据只注入当前进程，用完撤回。
5. e4380af 能在新结构上继续运行（迁移只新增），所以迁移和部署可以分开进行；此时线上服务不受影响。

### G3：Render 手动部署（需明确授权）

1. 按 `docs/audits/render-neon-release-runbook.md` 设置环境变量：pooler URL 使用运行时角色，`sslmode=verify-full&sslrootcert=/etc/ssl/certs/ca-certificates.crt`；四个 `BILLIE_DB_*`；新的 `BILLIE_SECRET_KEY_BASE`；删除 `RUN_MIGRATIONS`。
2. Manual Deploy 固定提交，检查 `/up`、预检和无令牌 401。
3. 所有者用 curl 或 Stable 客户端登录真实账户，确认返回的 `owner_id` 与本地账本绑定的 ID 一致。不在生产库创建测试账户。
4. 冒烟通过后删除 `SECRET_KEY_BASE`（关闭回滚栅栏）。所有已签发的旧令牌随之作废，需要重新登录一次。
5. 回滚：栅栏关闭前，可在控制台回滚到 e4380af；关闭后部署 `dbd85e7`。数据库不回滚，因为迁移只新增。

G3b（可选，可以推后）：用 `services/identity-api/render.yaml` 创建 identity 服务，配齐 marker、运行时角色和 `bin/billie-release identity`，注册才能使用。Stable 只需要登录已有账户，不依赖它。

### G4：Stable 客户端（需明确授权）

1. 先完整备份 `com.billieweather.client` 数据目录和 Keychain 条目（`install-stable.sh` 会自动备份，另外手动再拷一份）。
2. 构建：`BILLIE_API_URL=https://web-68wd.onrender.com BILLIE_IDENTITY_URL=<已验证的正式 HTTPS 地址> ops/release-build.sh`，标识符保持 `com.billieweather.client`。
3. 先运行 `install-stable.sh --check`，再安装。首次登录真实账户后，核对 owner ID 绑定、设置、分类、规则、预算和主题。
4. 回滚：`install-stable.sh --rollback`。

### Dev

- 使用 `npm run desktop:dev`（`com.billieweather.client.dev`，独立的数据目录、Keychain 和 WebView 来源），服务器为 localhost，数据库为 Neon development，账户为合成测试账户。
- 在 G4 之前，**不要**在 `/Applications/BillieWeather.app`（Stable 标识符）里登录测试账户，否则会在真实数据目录里为测试 owner 创建账本。

## 三、不做的事

- 不把本地开发服务器或任何 `.env` 指向 Neon production。
- 不放宽启动检查（`billie:release:check`、`database.yml`）来让部署通过。
- 不在未授权的情况下运行生产迁移、Manual Deploy 或安装 Stable 客户端。
- 不更换品牌，也不迁移出 Render/Neon。

## G0/G1 结果（2026-11-26，所有者授权执行）

本节不写邮箱或凭据。账户细节只在对话报告中给出。

- **G0：** 对生产库 `ep-raspy-sound`/`neondb` 做了只读核查（PG 18.7，160 个迁移，最新为 20261122000100）。共有 2 个用户。本地 Stable 账本绑定的 owner 在生产库中**不存在**：该账户已于 2026-11-23 05:49Z 被删除。Render 进程以 `neondb_owner` 连接这个库。GitHub 部署记录显示，899241e 之后没有再触发过部署。
- **G1：** 演练分支是 `release-rehearsal-20261126`（br-green-tree-bdltws96），会保留到验收结束。结果如下：
  - 用 `ops/neon-release-provision.sql` 配置角色和标记，在固定提交 18493c4 上运行 `bin/billie-release rails`，3 个迁移耗时约 0.5 秒。
  - 迁移前后，所有原有表的行数和内容 md5 都一致。
  - 启动检查的正向和反向测试都通过。
  - API 测试 19/19 通过。
  - 跨版本测试：e4380af 和 dbd85e7 都能在新结构上运行，令牌栅栏有效。
  - 时间点恢复演练和逻辑备份恢复演练都通过。
  - 回归测试：Rails 894 个中 1 个错误，属测试环境缺陷；vitest 1193 个通过；tsc、cargo、identity pytest 都通过。
- **新发现**（已写入运行手册）：
  - Neon 在派生或恢复的分支上会把运行时角色重建为特权角色，需要用 API 删除后重新配置。
  - dbd85e7 回滚时，Start Command 必须改为 `bundle exec puma -C config/puma.rb`。
  - 需要设置 `BILLIE_MODULE_SYNC=1` 才会开启功能库同步。

## Dev 实测与 Stable 剩余阻塞项（2026-11-26 第二轮）

本节不写邮箱或凭据。

**Dev（已完成）**

- 本地 Rails `:3000` 和 identity `:8100` 连接的是 Neon `development`（marker `development`），不是 production。
- 通过真实 HTTP 请求测试（不是查数据库记录）：合成账户登录 201，`/account` 200，退出 204，退出后的旧令牌 401，重新登录 201，错误密码 401 `invalid_credentials`。
- 新注册的合成账户：注册 201（`created`），重复注册 409 `email_taken`，登录、退出、重新登录都通过。凭据保存在 `~/.billieweather-dev/`（权限 600）。
- 两台服务器的 CORS 都允许 `tauri://localhost`。
- 新增 `BILLIE_VARIANT=dev` 构建和 `ops/install-dev.sh`，安装 `/Applications/BillieWeather Dev.app`。它的标识符是 `com.billieweather.client.dev`，钥匙串服务、WebKit 存储、数据目录和链接协议 `billieweather-dev://` 都是自己的；只允许连接 localhost。
- 安装和启动 Dev 前后对比了 Stable 的数据目录和 WebView 存储的校验和，没有任何变化。
- **尚未完成：** 在 Dev.app 界面中实际登录。自动键盘输入时屏幕切换到了其他桌面，输入没有进入 Dev.app，所以停止了自动化，需要所有者亲自登录一次（或在机器空闲时再运行）。

**Stable 本地账本**

- `billieweather.db`：schema v9，所有账本表 0 行。`settings` 只有 5 行：已删除 owner 的绑定、数据库名、同步标记。`.pre-v9` 备份只有 1 行设置。没有需要保留的财务数据。
- 因为设置了 `database_name`，客户端会把它判定为“foreign”。Booth 账户登录时会新建第二个槽位，这个文件会被搁置。
- 备份：`~/BillieWeather-Backups/20261126-055654-stable-pre-init/`（数据目录 + WebKit，SHA256SUMS 已核对，`integrity_check` 结果 ok）。
- 初始化方案（G4 时执行，需授权）：退出 Stable，把 `billieweather.db*` 移到备份目录（移走，不删除），然后安装新的 Stable 并用现有生产账户登录。客户端会新建并认领一个空账本。回滚方法：把文件移回原处。

**Stable 剩余阻塞项**

1. G2 生产迁移：尚未执行，需授权。
2. G3 Render：环境变量待 G3 经 Render API 配置（包括 `BILLIE_MODULE_SYNC=1`），然后触发手动部署。当前仍运行 e4380af（`/module_preferences` 返回 404），冷启动约 72 秒。
3. identity 托管服务当前未部署。Stable 正式构建等待 G3b 提供可用的 Identity HTTPS URL 和真实邮箱验证码验收。
4. `release-build.sh` 要求工作区干净，且 HEAD 上有版本标签。目前没有任何 `v*` 标签，本轮改动也还没有提交。
5. Mac mini：还没有运行 `ops/neon-dev-env.sh`、`ops/install-dev.sh`，也还没有同步 main。

## 独立项目与 Render 复核（2026-11-26）

- Development 已切换为免费组织下的独立项目 `odd-firefly-71205607`，角色
  `billie_development_owner`。从空库执行 Rails 全部迁移及 identity 两个迁移，MacBook
  已通过真实 HTTP 请求验证合成用户注册、登录、账户读取、退出和旧令牌失效。
- Render CLI 和 API 确认生产服务为 Free，跟踪 `main`，Auto-Deploy 为 Off。
  Build Command 为 `./bin/render-build.sh`，Start Command 为 `./bin/render-start.sh`。
  `DATABASE_URL` 指向 Production 的 pooler，直连只读检查确认库名及 160 个 Rails 迁移。
  服务缺少 `BILLIE_DB_HOST`、`BILLIE_DB_NAME` 和 `BILLIE_DB_TARGET_ID`，生产库也尚无目标标记。
  已链接的设置组同时有 `SECRET_KEY_BASE` 与 `BILLIE_SECRET_KEY_BASE`，本次只检查了键名。
- 最近三次部署（两次 `63958b0`，一次 `899241e`）均因 PostgreSQL 发布目标验证失败
  而在启动阶段退出。仍在线的 `e4380af` 返回 `/up` 200 和无令牌 `/account` 401。
- Production 只读检查确认一个 Chicago Booth 账户且未锁定。旧 SQLite 账本内的 owner ID
  在 Production 中没有匹配项，账本有名称但交易及账单均为 0。G4 使用 Booth 账户建立独立
  账本槽位，原文件作为可恢复副本保留。不得将旧 owner ID 直接改成 Booth 的 ID。
- G2–G4 仍受各自的发布闸门约束。Render CLI 已授权，后续核查可直接走 CLI/API。

## 最新审批范围与执行顺序

本轮只把已验证的 Development 改动推到 GitHub `main`。Render 服务 Auto-Deploy 和根
Blueprint Auto Sync 均为 Off。后续正式发布须一次批准下列范围，并逐项完成验证后继续。

| 阶段 | 执行内容和验证 |
| --- | --- |
| G2 备份和迁移 | 读取 Production 直连主机、项目、分支、库名和 owner 角色。使用可恢复的 GPG 接收密钥执行 `ops/infrastructure.py backup --before-marker` 并校验归档。记录 Neon 恢复窗口和恢复点。执行经审核的 marker、Rails 和 Identity 迁移，再以 `phase=roles` 创建两套运行时角色。旧应用在此阶段继续服务。确认 Booth 账户、迁移历史及对象权限。 |
| G3 Render Rails | 使用现有 `BILLIE_SECRET_KEY_BASE`，保持现有 legacy key 值。设置 Rails 专属 TLS pooler `DATABASE_URL`、`BILLIE_DB_ENV`、`BILLIE_DB_HOST`、`BILLIE_DB_NAME`、`BILLIE_DB_TARGET_ID` 和 `BILLIE_MODULE_SYNC=1`。更新前记录每个变量的键和可恢复状态。通过 CLI 手动部署确切的 main 提交并验证 API 和登录兼容性。 |
| G3 Identity | 在同一工作区提交独立 Identity Blueprint，关闭 Auto Sync 和 Auto-Deploy。使用专属运行时角色和 Postmark HTTPS 事务邮件接口。只在可确认 $0 时创建 Free 服务。使用 Render 分配并验证的 HTTPS URL，必需邮箱验证码，Google OAuth 默认关闭。校验 `/health`、`/v1/config`、CORS 以及经授权的真实邮箱验证码、注册与 Rails 登录。 |
| G4 Stable | 在确切的 main 发布提交上创建 `v0.9.0`，使用两项已验证的 HTTPS 服务地址构建。校验 Tag、DMG、签名、构建和安装标识。运行 `ops/install-stable.sh --initialize-empty-ledger` 前再次核查 SQLite 和备份，原文件连同 sidecars 移入备份。安装新 Stable 后由账户本人登录，双应用分别核对存储和连接。 |

Identity 需要 `POSTMARK_API_TOKEN` 和已验证的 `MAIL_FROM`，当前 Render 配置没有这两个键。
`RENDER_EXTERNAL_URL` 由 Render 注入，其他平台通过 `PUBLIC_URL` 指定自己的 HTTPS 地址。
免费方案共用 Render 工作区每月 750 实例小时和构建、带宽额度。第二服务会占用同一额度并会冷启动。
Postmark Developer 每月可发送 100 封，正式发送需验证发件人并满足账号审批要求。
预算、验证发件人或使用量保护条件不满足时，Identity 暂停在准备阶段。

生产数据库的任何直接恢复、数据删除、旧账户恢复、现有签名密钥轮换和付费套餐
均在本次发布审批范围外。回滚候选需兼容新 schema，恢复旧应用后再验证会话与线上健康。
