# BillieForecast

独立的 Python 现金流预测 API，使用 Amazon Chronos‑2 预测每日收入和支出，再从起始余额逐日累加。Rails 的 Cash Flow Forecast 页面已接入此服务，用户可以选择 Prophet、Chronos‑2 或历史平均值。`examples/rails_client.rb` 另提供可供其他 Ruby 项目使用的 HTTP 客户端示例。

## 本地启动

在本机安装 Python 3.11 和 [uv](https://docs.astral.sh/uv/getting-started/installation/) 后：

```bash
cd billieforecast
cp .env.example .env
uv sync --extra chronos
uv run --extra chronos billieforecast
```

默认地址为 `http://127.0.0.1:8000`，使用一个 Uvicorn worker，默认后端为 `chronos`、设备为 `cpu`。第一次预测时才加载模型；首次使用还需要联网下载权重，因此会明显慢于后续请求。权重默认缓存到项目的 `.cache/huggingface`，可用 `BILLIEFORECAST_CACHE_DIR` 修改位置。

浏览器打开 `http://127.0.0.1:8000/docs` 查看并试用接口。

只想先测试 HTTP 接口、暂不安装模型依赖时，可明确选择历史平均值后端：

```bash
uv sync --group dev
BILLIEFORECAST_BACKEND=average uv run billieforecast
```

`average` 是单独的基线算法。Python API 在 Chronos 加载或预测失败时返回 HTTP 503，不会自动切换成平均值算法。Rails 页面会捕获模型不可用等情况，显示历史平均值结果和原因提示；页面仍保留用户所选模型。

## 调用预测

```bash
curl --fail-with-body http://127.0.0.1:8000/v1/forecast \
  -H 'Content-Type: application/json' \
  -d '{
    "currency": "USD",
    "starting_balance": "1500.00",
    "days": 30,
    "income_adjustment": 0,
    "expense_adjustment": 0,
    "history": [
      {"date": "2026-11-01", "income": "100.00", "expenses": "25.00"},
      {"date": "2026-11-02", "income": "0.00", "expenses": "0.00"},
      {"date": "2026-11-03", "income": "0.00", "expenses": "40.00"}
    ]
  }'
```

这里的 `starting_balance` 是历史最后一天（例中为 2026-11-03）结束时的现金余额，预测从次日开始。实际接入时应使用用户的数据；上面的三天只是最小请求示例。

| 字段 | 要求 |
| --- | --- |
| `history` | 3–90 天，按日期升序且连续，每天包含 `date`、非负 `income` 和非负 `expenses` |
| `starting_balance` | 必填，历史最后一天结束时的余额，可以为负 |
| `days` | 预测天数，1–90 |
| `currency` | 默认 `USD`；服务不会转换币种 |
| `income_adjustment` / `expense_adjustment` | 默认 `0`，范围 -100 至 1000，单位为百分比 |

金额最多保留两位小数，总位数最多 16 位；请求中建议用十进制字符串表示金额。必须先确认历史日期范围内的数据完整，再将确实没有交易的日期补为零。没有导入的日期不能直接当作零交易日。

响应包含模型信息和仅含未来日期的 `points`。每个点有 `date`、`income`、`expenses`、`net_flow`、`balance`，金额以十进制字符串返回。余额按以下关系累加：

```text
当日净现金流 = 调整后的收入 − 调整后的支出
当日余额 = 前一日余额 + 当日净现金流
```

可运行合成数据检查，脚本生成 90 天示例历史，不读取私人财务数据：

```bash
uv run --extra chronos python scripts/smoke.py
```

运行脚本前需先启动服务；使用 Chronos 后端时，这也会触发首次模型加载。测试平均值后端时，命令可以省去 `--extra chronos`。脚本通过进程环境读取 API key；若服务的 `.env` 中设置了密钥，请在运行脚本的终端先设置同值的 `BILLIEFORECAST_API_KEY`。

## 配置与健康检查

Python 服务会读取当前项目目录下的 `.env`；这与现有 Rails 项目的配置加载方式不同。修改后重启服务。

| 环境变量 | 默认值 / 用途 |
| --- | --- |
| `BILLIEFORECAST_BACKEND` | `chronos`；可显式设为 `average` |
| `BILLIEFORECAST_MODEL_ID` | `amazon/chronos-2`；也可指向本地模型目录 |
| `BILLIEFORECAST_DEVICE` | `cpu`；有兼容 NVIDIA GPU 时可选 `cuda` |
| `BILLIEFORECAST_HOST` | `127.0.0.1` |
| `BILLIEFORECAST_PORT` | `8000` |
| `BILLIEFORECAST_API_KEY` | 可选；配置后调用方通过 `X-API-Key` 请求头传入 |
| `BILLIEFORECAST_CACHE_DIR` | `.cache/huggingface`，用于 Hugging Face 模型缓存 |

配置 API key 后，在请求中增加 `-H 'X-API-Key: 你的密钥'`。不要把实际密钥提交到仓库。

- `GET /health`：存活检查，返回 `model_loaded` 标记；HTTP 200 不代表模型已经加载。
- `GET /ready`：检查模型是否已加载；Chronos 尚未成功加载时返回 503。首次预测会触发加载；该接口自身不加载模型，也不保证后续推理成功。平均值后端启动后即返回 200。
- `GET /docs`：交互式接口文档。

## Rails 接入与部署

Rails 已按用户筛选交易、排除转账及已排除记录，再按天聚合收入和支出后调用本服务。只发送每日汇总，不发送交易描述。现有 Rails 项目无需复制示例客户端。

先启动 Python 服务并保留默认的 `BILLIEFORECAST_BACKEND=chronos`。然后在 Rails 进程环境中设置 `BILLIEFORECAST_URL=http://127.0.0.1:8000`，或在 Rails 的 `config/application.yml` 中使用 YAML：

```yaml
BILLIEFORECAST_URL: http://127.0.0.1:8000
# Python 配置 API key 时，取消注释并填写相同密钥：
# BILLIEFORECAST_API_KEY: your-key
# 可选服务器默认模型；用户在页面上的选择优先：
# FORECAST_ENGINE: chronos
```

重启 Rails，打开 `/app/forecast`，在 **Forecast model** 选择 **Chronos-2** 后点击 **Update forecast**。页面会显示实际使用的模型；历史不足、服务错误或不可用时，页面显示历史平均值与原因，同时保留 Chronos‑2 选项。选择 **Prophet** 则在 Rails 内通过 `prophet-rb` 运行，不会调用 Python 服务。可用 `FORECAST_ENGINE=prophet`、`chronos` 或 `linear` 修改服务器默认值，默认是 `prophet`。

Chronos 和历史平均值使用最近最多 90 天数据；Prophet 使用完整历史，需至少 60 个日历日和 10 个有交易的日期。应先确认所选日期范围内的导入数据完整，再理解模型补零后的日序列。

Rails 已将 API 的未来余额点映射到页面并补上起始点。起始余额是页面显示的现金余额，可能来自较旧账单，不能视为实时银行余额。首次模型下载可能超过 Rails 的 120 秒读取超时，可先用 smoke 脚本完成预热。

本机运行两个服务时，Rails 可以请求 `http://127.0.0.1:8000`。部署到 Render 等平台后，Rails 容器中的 `localhost` 指向 Rails 自身；应把 BillieForecast 单独部署，并使用该服务的实际可达地址。模型下载需要网络，权重缓存应根据部署环境配置持久存储；使用单 worker 可避免每个 worker 各加载一份模型。

起始余额需要由调用方提供，本服务不会连接银行，也不会把历史净流水当成当前余额。Chronos 逐日预测的中位数累加得到余额路径，不代表未来余额的概率区间；不能将每日分位数简单相加并声称是累计余额的置信区间。模型是否适合某位用户的数据，应通过历史回测评估，这里不作准确率保证。

## 开发检查

```bash
uv sync --group dev
uv run pytest
uv run ruff check
```

需要实际运行 Chronos 时，安装依赖使用 `uv sync --extra chronos --group dev`。

Ruby 内也有可直接使用的预测库，例如 [prophet-rb](https://github.com/ankane/prophet-ruby)，但它使用 Prophet 模型。本项目选择 Python，是为了沿用 [Amazon 官方 Chronos‑2 实现](https://github.com/amazon-science/chronos-forecasting)。
