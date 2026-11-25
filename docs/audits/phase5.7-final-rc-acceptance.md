# BillieWeather / FinRx Phase 5.7 最终 RC 验收报告

2026-11-24 · `autonomous-development` · macOS 27.2，Apple Silicon · 未推送、未合并、未部署。原始证据在 [evidence/2026-11-24-phase5.7](evidence/2026-11-24-phase5.7/)。状态只用 PASS、FAIL、BLOCKED、NOT TESTED。

## 1. 执行摘要

结论是 **生产 NO-GO**，macOS Apple Silicon 隔离 QA 为 **CONDITIONAL GO**。

- **最终 RC 自身的原生 GUI 验收为 BLOCKED。** 测试期间桌面先在使用，随后锁屏，解锁后又在使用。锁屏时 macOS 不向辅助功能暴露窗口，我没有解锁屏幕。收据、扫描 PDF、CSV 三条流程没有在这个 RC 的界面里走过。
- QA 隔离由程序强制，PASS。标识、数据目录、钥匙串或后端不符时，应用在打开任何东西之前退出。
- 修复 4 类已确认缺陷，其中 1 类会丢数据：原生应用中“清空回收站”不经确认就永久删除。
- Vision 可靠性、无障碍与全部回归 PASS，条件见各节。
- 新发现 1 项待您决定的安全风险：退出登录不会在服务端吊销令牌（第 12 节）。

## 2. QA 隔离核验：PASS

| 项目 | QA RC 的值 |
| --- | --- |
| Bundle ID（Info.plist、签名、编译期三处一致） | `com.billieweather.client.qa` |
| 名称与窗口标题 | BillieWeather QA |
| URL scheme | `billieweather-qa` |
| 数据、缓存、WebKit、偏好 | `~/Library/…/com.billieweather.client.qa` |
| 钥匙串服务 | `com.billieweather.client.qa` |
| 后端 | 仅 `http://127.0.0.1:33557` 与 `:38557`，Unix socket 上的隔离 PostgreSQL |

强制手段有三层。

1. **应用内守卫**（`src-tauri/src/variant.rs`）。在窗口、数据库、钥匙串之前检查，不符即以 78 退出。拒绝的情形：debug 构建使用生产标识；Info.plist 与编译期标识不同；release 二进制不在 App 包内；QA 构建可连非隔离服务器；数据目录或账本文件是链接。
2. **预检与启动**（`scripts/qa.mjs build | preflight | launch`）。只从干净提交构建并记录提交号。先做静态检查，确认有守卫标记后才在禁网、禁写的沙箱中询问二进制。启动后核对已打开文件，碰到生产目录立即停止。
3. **`desktop:dev` 改用 `com.billieweather.client.dev`**。此前它会打开并迁移已安装应用的真实账本。**您下次运行 `desktop:dev` 会看到空账本并需重新登录，这是预期变化。**

反向测试：改写 Bundle ID 的包、包外二进制均以 78 退出；生产 Bundle ID 的包、无守卫的旧 QA 包、被篡改的包均被预检拒绝且未执行。被执行的二进制编译期标识都是 QA。单元回归 Rust 4 项、Vitest 27 项。守卫只在 macOS 实测，Windows 为 NOT TESTED。

## 3. 误启动事件评估

2026-11-24 16:41:34–16:44:20，PID 89110。根因：我的脚本改写了 Info.plist，但 debug 二进制内编译的仍是 `com.billieweather.client`。只读依据是系统日志（只留计数）、当时记录的文件时间、代码路径、开发服务日志。本阶段没有访问已安装应用的数据目录，也没有查询钥匙串。

| 对象 | 评估 | 依据 |
| --- | --- | --- |
| 钥匙串 | **发生过两次查找**，按代码应为 `com.billieweather.client.dev`，不是已发布应用的条目。是否读到令牌无法由日志判定 | 两次 `SecKeychainFindGenericPassword`；debug 服务名带 `.dev` |
| :1420 开发页面 | **确实加载**（上次报告只写“不能排除”）。日志隐去主机名，地址由构建类型推断 | 1 次页面完成，142 次 HTTP 200 |
| 令牌被使用 | 未见证据 | 读到令牌就会请求 :3000，而该开发日志最后一条是 11 月 23 日 21:36 |
| 账本内容 | 未见打开的证据 | 登录后才会打开账本；`-shm` 仍停在 11 月 23 日 00:33:56，且当时无其他应用进程 |
| 账本元数据 | **读取过**：文件是否存在，以及 1 字节的 `.schema` | 启动代码必经 |
| 写入 | 未见 | 当时记录的目录与文件时间均早于事件 |

不能声称“没有访问任何敏感信息”。没有证据支持大范围轮换凭据。如想完全排除，可修改该开发账号的密码，这会使其全部应用令牌失效。

## 4. 最终 RC 构建标识：PASS

| 项目 | 值 |
| --- | --- |
| 源提交 | `929c23aa72886b433e9a0c92c0a0ecb4174fedcf`（写入二进制） |
| 二进制 SHA-256 | `adedcfc2c5edc3c3433248d0a6d37c35387ac0d4567f0fb74266019fd65b8ae2` |
| 架构、大小 | arm64，18 MB（含 Tesseract 资源） |
| SQLite | 3.54.1（运行时自报） |
| 签名 | ad hoc，校验通过；`spctl` rejected，未公证 |
| 启动 | 锁屏下以首个构建（`10837d8`，原生代码相同）启动过一次：进程正常，数据目录 0700，未打开生产文件。未登录，未建库 |

**来源核对**：此前通过 GUI 的 `phase52` 包不含 `040a904`、`ca506cc`，`phase56rc` 从未通过 GUI，两者都不是本 RC。`929c23a` 是 `4cf57e7` 的后代，包含 Phase 5.2–5.6 全部提交。已安装的 BillieWeather 未被改动。RC 副本在 `ClaudeGenerated/BillieWeather QA.app`（仓库外）。

## 5. 原生 GUI 验收结果：BLOCKED

| 项目 | RC 界面 | 独立旁证（不算 GUI 验收） |
| --- | --- | --- |
| 登录、退出 | BLOCKED | 隔离后端 API：错误密码 401，登录 201，退出 204 |
| 功能库、跨设备偏好 | BLOCKED | 隔离后端：设备 2 可见设备 1 的改动，重放无副作用，过期改动报冲突，另一账号不可见 |
| Default / Manual、深浅主题、中英文 | BLOCKED | Playwright WebKit 2388与 Chromium 扫描，见第 10 节 |
| 收据、扫描 PDF、CSV、重启 | BLOCKED | 见第 6–8 节 |

## 6. 收据导入证据

RC 界面 **BLOCKED**。旁证 PASS：RC 自己的 OCR worker 接同一提交的导入服务，写入 SQLite 文件再重新打开。COFFEE CORNER 5.75 判为已有交易；QA SYNTHETIC MARKET 10.25 确认后新增 1 笔 −1,025 分；同一收据再次读取判为已有；损坏图片被拒绝，0 写入。

## 7. 扫描 PDF 证据

RC 界面 **BLOCKED**。旁证 PASS：两页 8/8 行日期与金额正确，1 行待审阅时不可提交，确认后 8 笔合计 28,604 分，重复文件被拒绝。旁证用的是该 PDF 的两页图像；PDF 渲染由 Chromium 真实测试覆盖。

## 8. CSV 证据

RC 界面 **BLOCKED**。旁证 PASS：预览 0 写入，确认 2 笔 9,575 分，重复文件被拒绝。

## 9. Apple Vision 可靠性：PASS（无界面）

| 项目 | 次数 | 结果 |
| --- | --- | --- |
| 冷准备，未中断 / 中断后重做 / 并发请求时 | 各 1 | 34.3 / 48.4 / 62.4 秒 |
| 热准备 | 20 | 最大 0.26 秒 |
| 首次识别（准备后） | 1 | 0.45 秒 |
| 顺序单图 / 两页文档 / 三路并发 | 60 / 30 / 45 | 全部正确，p50 0.55 / 0.46 / 0.76 秒，最大 1.23 秒 |
| 取消后识别 / 异常输入 | 20 / 20 | 全部受控 |
| 卡住的 worker / 父进程退出 | 1 / 1 | 20.1 秒自行结束 / 3 秒内结束 |
| 残留进程 | – | 0 |
| 应用更新近似（同标识、不同二进制） | 1 | 首次识别 0.84 秒，准备 0.31 秒 |

未中断前的冷身份请求在 18 秒按设计超时。上限未放宽（准备 180 秒、识别 18 秒）。Tesseract 回退：真实引擎在 Chromium 通过，RC 的 WKWebView 内为 NOT TESTED。RC 自身标识的首次准备留给真人首启，NOT TESTED。**系统更新后的冷启动 NOT TESTED。**

## 10. 无障碍

自动检查用 axe-core 4.14.1（WCAG 2.2 A/AA 加最佳实践），另有键盘遍历、320/768 像素、减少动态效果。

| 发现 | 处理 |
| --- | --- |
| 启动时 `<html lang>` 恒为 en，中文登录页会被按英语朗读 | 已修，有回归 |
| 登录失败、选文件、导入完成、切换页面后焦点丢失（含 WebKit 特有情形） | 已修，有回归 |
| 对话框不接管焦点、无 Escape；新建表单不移入焦点 | 已修，有回归 |
| 无跳过导航；单选组不支持方向键 | 已修，有回归 |
| 5 组对比度不足（3.37–4.47:1），含深色主题系统默认按钮 | 已修，图表文字与强调色已列入令牌对比度测试，其余由复扫核对 |
| 空表头 | 已修 |

修复前 26 处违规，修复后 0（Playwright WebKit 2388，深浅 × 中英；其余模块在 Chromium 深浅各 0）。16 个界面的可聚焦控件全部可达，无陷阱。网页端 16 个页面深浅各 0。VoiceOver 真人朗读 **NOT TESTED**。

## 11. 财务数据完整性：PASS（无界面）

- 重新打开后 11 笔、37,154 分不变，`integrity_check` ok，外键违规 0，暂存 0，与 Phase 5.2 手算一致。
- **已修：清空回收站不经确认就永久删除。** Tauri 的 dialog 插件把 `window.confirm` 换成返回 Promise 的版本，条件恒真。旧代码实测：确认框回答“否”，2 笔仍全部删除。现在整库清空和单条永久删除都在页面内确认，默认焦点在取消。
- **已修：撤销可能清掉本人修改的保护标记。** 由一次偶发测试失败追到：以毫秒时间戳相等判断“没人动过”。现逐字段比较，并有冻结时钟回归（旧代码必败）。
- PostgreSQL 162/162，未验证约束 0，无效索引 0。

## 12. 安全审计

| 项目 | 结果 |
| --- | --- |
| RustSec / npm / Ruby / Python（identity、forecast） | 0 漏洞。RustSec 保留 6 条既有告警（5 unmaintained、1 unsound） |
| Yarn（网站资产） | 3 条弃用提示，无漏洞公告 |
| **退出登录后的服务端吊销** | **FAIL（既有设计，未改）** |

退出登录后，同一令牌仍可访问账户与网站财务接口，最长 30 天，改密码才失效。代码注释写明令牌无状态；另一处注释称令牌不可用于财务数据，与现状不符（`/finance` 返回 200）。本机退出会删除本地令牌，所以只在令牌已泄露时有影响。修复需新表与迁移，属产品决定，未擅自实施。

## 13. Render / Neon 部署准备

仅审阅代码与隔离库演练，未接触线上资源。

| 检查 | 状态 |
| --- | --- |
| Render 构建、启动、容器入口均不迁移；自动部署关闭；CI 的 Heroku 部署被注释 | PASS |
| 迁移须 `bin/billie-release` 加批准号，并由服务器回报库名、角色、标识、环境 | PASS |
| 开发配置拒绝非本地数据库（本分支） | PASS |
| 运行角色不得有建表权限 | PASS（代码）；线上 NOT TESTED |
| 环境变量、备份、回滚文档 | PASS（[运行手册](render-neon-release-runbook.md)、[发布清单](release-checklist.md)） |
| 健康检查 | identity `/health` 核对结构；Rails `/up` 只表示进程存活，数据库由启动检查保障 |
| 线上 Render、Neon 实际值 | BLOCKED |

注意：正在运行的本地开发服务来自主检出 `phase-1a-modular-shell`，不含上述守卫。

**Neon 隔离验收**：需要一个 7 天到期的分支（`neon.ts` 已设）、两个运行角色和合成数据。按 [Neon 文档](https://neon.com/docs/introduction/plans)，Free 含每项目 10 个分支、100 CU 小时、1 GB，恢复窗口 6 小时；Launch 为 0.106 美元/CU 小时、0.35 美元/GB·月。额度内预计 0 美元。Neon 自己的旧博文数字不同，以控制台为准。若要 7 天恢复窗口需付费，未启用。

**需要您逐项批准**

1. 创建 Neon 隔离分支并写入合成数据，确认套餐与上限。
2. 只读核对 Render 两个服务的构建、启动、健康检查、环境变量与自动部署。
3. 在 Neon 设置 `billie.environment` 与 `billie.target_id`，建立受限运行角色。
4. 备份、恢复点与恢复演练目标。
5. 生产迁移：变更号、负责人、时间窗、回滚人。
6. Apple Developer ID、公证与 stapling。
7. 令牌吊销方案（第 12 节）。
8. 推送、合并、部署各自单独批准。

## 14. 平台状态

| 平台 | 构建 | 运行 | 结论 |
| --- | --- | --- | --- |
| macOS Apple Silicon | PASS | GUI BLOCKED，无界面 PASS | 隔离 QA CONDITIONAL GO，生产 NO-GO |
| macOS Intel | BLOCKED（无 x86_64 标准库） | NOT TESTED | NO-GO |
| Windows | NOT TESTED | NOT TESTED | NO-GO |
| iOS | BLOCKED（仅命令行工具） | NOT TESTED | NO-GO |
| Android | BLOCKED（无 JDK、SDK） | NOT TESTED | NO-GO |
| Web / 后端 | 本地 PASS | 线上 BLOCKED | NO-GO |

## 15. 测试结果

| 套件 | 结果 |
| --- | --- |
| Universal（`929c23a`，含 Chromium 与真实 Vision） | 78 文件 982/982，0 跳过，连续 3 轮 |
| TypeScript | 0 错误 |
| Rust | 33/33（库 30，worker 3） |
| Rails（`10837d8`；其后未改 Rails 与 public） | 824 项，31,060 断言，0 失败，0 错误，2 既有跳过 |
| identity | 127 通过、1 跳过；跳过的 Rails 兼容项随后单独执行，通过 |

过程中的失败：默认浏览器版本不匹配使 13 项跳过，改用 `BILLIE_TEST_CHROMIUM_CHANNEL=chrome` 后通过；隐私测试拦下我写的打印宏，已改代码；第 11 节的偶发失败；我曾把含 1 个失败测试的改动提交，随即修正并 amend。

## 16. 本地提交

`a943ee3` 隔离守卫与预检 · `10837d8` 永久删除确认与无障碍 · `476df98` 撤销保护 · `929c23a` WebKit 焦点与按钮（**RC 源**）· 本报告的文档提交。

## 17. 剩余阻塞

1. RC 自身的原生 GUI 验收（真人，或一台空闲的 Mac）。
2. Developer ID、公证、stapling（本机 0 个签名身份）。
3. Render/Neon 实际环境验收。
4. 退出登录的令牌吊销决定。
5. 系统更新后的冷启动、VoiceOver、WKWebView 内的 Tesseract 回退。
6. 其他平台工具链。

**真人验收步骤**（约 20 分钟）。隔离后端已停止，`ROOT` 用第一条命令的输出：

```sh
cd billieweather-roadmap
ROOT=$(bin/billie-local init | tail -1); export BILLIE_LOCAL_ROOT=$ROOT BILLIE_MODULE_SYNC=1
bin/billie-local rails db:prepare && bin/billie-local identity -m identity_api.schema migrate
bin/billie-local rails server -p 33557 -b 127.0.0.1 &
bin/billie-local identity -m uvicorn identity_api.main:app --host 127.0.0.1 --port 38557 &
node clients/universal/scripts/qa.mjs launch "../ClaudeGenerated/BillieWeather QA.app"
```

在应用内注册合成账号（验证码在 `$ROOT/identity/outbox`），依次导入 `ClaudeGenerated/rc-fixtures` 中的合成 CSV、扫描 PDF、收据（先 PDF 再收据，匹配项才会出现）；各做一次取消和一次重复导入；退出重开后核对笔数与合计；切换主题、语言、Manual；在回收站确认“清空”会先询问。

## 18. 最终建议

**生产：NO-GO。** RC 自身的 GUI 验收未完成，签名、公证与线上环境未验证。
**macOS Apple Silicon 隔离 QA：CONDITIONAL GO**，条件是按上节完成真人验收。
