# BillieWeather 发布清单

数据库步骤以 [Render/Neon 运行手册](render-neon-release-runbook.md) 为准。每一步由负责人记录提交号、时间和结果。

1. **前置**：固定提交；Universal、Rust、Rails、identity 全套通过；RustSec、npm、Ruby 审计为 0 项漏洞。
2. **环境变量**：`DATABASE_URL`（运行角色）、`BILLIE_DB_ENV`、`BILLIE_DB_HOST`、`BILLIE_DB_NAME`、`BILLIE_DB_TARGET_ID`；发布时另注入 `DATABASE_URL_UNPOOLED` 与 `BILLIE_RELEASE_APPROVAL`，完成后撤回。
3. **备份**：记录恢复点与保留窗口，在隔离目标演练恢复并核对金额与归属。
4. **迁移**：`bin/billie-release rails`，再 `bin/billie-release identity`。构建与启动不执行迁移。
5. **冒烟**：`/up`、`/health`、Redis、合成账号的注册、登录、导入、退款与转账口径。
6. **监控**：5xx 率、登录失败率、导入失败率、数据库连接与锁等待、健康检查。客户端只上报错误代码，不含金额、描述或路径。
7. **回滚**：优先重新部署兼容的上一版本，保留结构与审计数据；数据恢复先在隔离目标核对。
8. **事故响应**：关闭 `BILLIE_MODULE_SYNC` 或暂停受影响写入；保全日志与备份；确认受影响账户；修复后核对交易、退款、转账、导入不变量；记录时间线。
9. **macOS**：Developer ID 签名、公证、stapling、`spctl` 通过、干净机器安装、旧版本升级、首次 OCR 准备、收据与扫描 PDF 导入、重启校验。不得以默认标识运行测试构建。
10. **其他平台**：Intel、Windows、iOS、Android 各自完成工具链构建、权限、签名和真机验收后才列入。
