# 使用本地 Laya 模型

扩展默认调用 TypeSafe 托管的 Jev 模型（需要 JEV 密钥，按请求计费）。本文说明另一种模型来源：在自己的 Mac 上运行 **Laya** 决策模型，由本仓库的 `tools/laya-server.py` 提供与 Jev 相同的接口，扩展切到「本地 Laya」即可使用。不需要密钥，不产生 API 费用。

- [它是什么](#它是什么)
- [环境要求](#环境要求)
- [第一步：准备模型仓库与权重](#第一步准备模型仓库与权重)
- [第二步：启动本地服务](#第二步启动本地服务)
- [第三步：在扩展中配置](#第三步在扩展中配置)
- [局域网共享](#局域网共享)
- [接口协议](#接口协议)
- [请求日志与离线分析](#请求日志与离线分析)
- [常见问题](#常见问题)
- [局限](#局限)

## 它是什么

```
游戏页（window.werhd）
   │ 战况 + 候选
   ▼
扩展后台 ──POST /v1/systemone──▶ 本地服务 tools/laya-server.py
   ▲                                 │ laya_mlx.Agent.predict
   │ 每组选中的候选 + 概率              ▼
   └──────────────────────────── Laya 模型（MLX，Apple 芯片 GPU）
```

| 组成 | 来源 | 说明 |
| --- | --- | --- |
| 模型运行库 `laya_mlx` | [virajbhartiya/laya-vs-jev](https://github.com/virajbhartiya/laya-vs-jev)（Apache-2.0） | 基于 [mizorewww/laya-mlx](https://github.com/mizorewww/laya-mlx)，即 [Laya](https://github.com/NandhaKishorM/laya) 的 MLX 移植版 |
| 模型权重 | Hugging Face [aac6fef/laya-multilingual-mlx](https://huggingface.co/aac6fef/laya-multilingual-mlx) | 多语言检查点，支持中文候选说明；权重单独下载，不在任何仓库里 |
| HTTP 服务 | 本仓库 `tools/laya-server.py`、`tools/laya-server.sh` | 把模型包装成 Jev 同款 `/v1/systemone` 接口；不打入扩展运行包 |

服务只做一件事：收到战况和候选，返回每组选了哪个。它不控制游戏、不主动连接外网（启动时强制 Hugging Face 离线模式）。

## 环境要求

- Apple 芯片 Mac（M1 及以后），macOS 14+
- Python 3.11+
- [uv](https://docs.astral.sh/uv/)（Python 包管理器）
- Node.js 20+（本仓库本身的要求，用于 `npm run laya`）
- 约 1 GB 空闲内存；首次需要联网下载权重

Intel Mac、Windows、Linux 无法运行 MLX，只能用 Jev 云端，或连接局域网内另一台已启动服务的 Mac（见 [局域网共享](#局域网共享)）。

## 第一步：准备模型仓库与权重

把 `laya-vs-jev` 克隆到 **本仓库旁边**（同一个父目录下），启动脚本默认在那里找它：

```sh
cd ..                       # 回到 jev-helper 的上一级目录
git clone https://github.com/virajbhartiya/laya-vs-jev.git
cd laya-vs-jev
uv sync --extra demo
uv run --extra demo hf download aac6fef/laya-multilingual-mlx \
  --local-dir models/hub/laya-multilingual-mlx
```

完成后目录应当是：

```
父目录/
├── jev-helper/
└── laya-vs-jev/
    ├── .venv/                              ← uv sync 生成
    └── models/hub/laya-multilingual-mlx/   ← 模型权重
```

放在别处也可以，启动时用环境变量 `LAYA_REPO=/path/to/laya-vs-jev` 指定。

## 第二步：启动本地服务

在 **jev-helper** 目录运行：

```sh
npm run laya
```

`tools/laya-server.sh` 会使用 `laya-vs-jev/.venv` 里的 Python（没有时退回 `uv run`）启动 `tools/laya-server.py`。正常输出：

```
Loading Laya checkpoint /…/laya-vs-jev/models/hub/laya-multilingual-mlx (float16, gpu)…
Model ready in 1.1s (warm-up answer: ok)
Laya decision server listening on http://127.0.0.1:8742/v1/systemone
Extension setting: model source = Local Laya, local server URL = http://127.0.0.1:8742/v1
```

最后一行就是要填进扩展的地址。服务在前台运行，`Ctrl+C` 停止。默认只监听本机 `127.0.0.1:8742`，不需要令牌。

检查服务是否在线：

```sh
curl http://127.0.0.1:8742/health
# {"ok": true, "model": "laya-multilingual-mlx", "requests": 0, "uptime_seconds": 3.2, "protocol": "systemone", "auth": false}
```

### 启动参数

参数写在 `npm run laya --` 之后，例如 `npm run laya -- --lan --log laya.jsonl`。

| 参数 | 环境变量 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `--port <端口>` | `LAYA_PORT` | `8742` | 监听端口 |
| `--lan` | | 关 | 监听所有网卡，供局域网使用，强制要求令牌 |
| `--host <地址>` | | `127.0.0.1` | 监听地址；非本机地址同样强制要求令牌 |
| `--token <令牌>` | `LAYA_TOKEN` | 空 | 手动指定访问令牌；`--lan` 未指定时自动生成 |
| `--model <目录>` | | laya-vs-jev 内的检查点 | 使用其他检查点目录 |
| `--repo <目录>` | `LAYA_REPO` | 本仓库旁边的 `laya-vs-jev` | laya-vs-jev 所在位置 |
| `--dtype` | | `float16` | `float16` / `float32` / `bfloat16` |
| `--device` | | `gpu` | `gpu` / `cpu` |
| `--raw-state` | | 关 | 战况原样交给模型，不重新排序（见 [局限](#局限)） |
| `--log <文件>` | `LAYA_LOG` | 空 | 每次决策追加一行 JSON 到该文件 |
| `--quiet` | | 关 | 终端不逐条打印请求 |

## 第三步：在扩展中配置

1. 打开扩展弹窗 → 「设置」，顶部「模型来源」选 **本地 Laya**。
2. 填写：

   | 设置项 | 填什么 |
   | --- | --- |
   | 本地服务地址 | 本机：`http://127.0.0.1:8742/v1`（默认值，不用改）；局域网：服务启动时打印的地址，如 `http://10.0.25.215:8742/v1` |
   | 本地访问令牌（可选） | 本机模式留空；局域网模式填服务打印的令牌 |
   | 本地模型名称 | 默认 `laya` 即可。服务不看这个字段，实际模型名以服务返回的为准 |

   地址写到 `/v1` 为止，扩展会自动补 `/systemone`；直接写完整的 `/v1/systemone` 也可以。
3. 点「保存设置」，浏览器会请求访问该地址的权限，点允许。
4. 点「测试模型连接」。按钮变绿并显示来源、耗时和模型名（例如 `laya-multilingual-mlx`）即成功。
5. 进入对局，照常「开启托管」。悬浮窗和弹窗会显示当前来源为 Laya。

两种来源的地址、密钥 / 令牌、模型名各自保存，切回「Jev 云端」不会丢失本地配置。切换来源或修改当前来源的配置会停止正在进行的托管。

**地址规则**：本机（`localhost`、`127.0.0.1`）和私有网段（`10.x`、`172.16–31.x`、`192.168.x`、`*.local`）允许 HTTP；其他地址必须 HTTPS。地址里不能带账号、查询参数或 `#`。

## 局域网共享

一台 Mac 跑服务，同一局域网的其他电脑（包括 Windows）都能用：

```sh
npm run laya -- --lan
```

输出会多出局域网地址和令牌：

```
Laya decision server listening on http://127.0.0.1:8742/v1/systemone
Laya decision server listening on http://10.0.25.215:8742/v1/systemone
Extension setting: model source = Local Laya, local server URL = http://127.0.0.1:8742/v1, http://10.0.25.215:8742/v1
Extension setting: local access token = <令牌>
```

- 令牌首次自动生成，保存在服务端 `~/.laya-server-token`（权限 600），之后每次启动都相同；删除该文件即可更换。
- 其他电脑的扩展填 `http://10.0.25.215:8742/v1` 和该令牌，点「保存设置」后浏览器会弹一次站点访问授权，同意即可（没同意也不丢已填内容，顶部会出现「授权访问」按钮）。

### 用哪个地址

地址由你自己决定，不限于下面列出的几种。规则只有一条：本机、局域网、Tailscale 等私有网络地址和所有 https 地址默认可用；其他 IP 或域名走明文 http 时，先在扩展设置的「允许的外部地址」里把它加进去（点一次「允许」，浏览器会申请一次该地址的访问权），之后再填到地址栏。服务启动时会把本机所有可用地址打印出来并标明类型，方便挑选：

| 情形 | 填什么 | 说明 |
| --- | --- | --- |
| 同一局域网 / 同一 Wi-Fi | `http://10.x.x.x:8742/v1`、`http://192.168.x.x:8742/v1` 或 `http://172.16–31.x.x:8742/v1` | 启动输出里标 `LAN` 的那一行 |
| 不在同一网络，两台都装了 Tailscale | `http://100.x.x.x:8742/v1`（标 `Tailscale / CGNAT`）或 MagicDNS 名 `http://<主机名>.<tailnet>.ts.net:8742/v1` | Tailscale 自身加密，走 HTTP 即可；防火墙对 Tailscale 网卡同样要放行 |
| 局域网内用主机名 | `http://<Mac 名>.local:8742/v1`（Bonjour），或 `nas.lan`、`box.home.arpa` 之类内网域名，或不带点的单段主机名 | 需要对方能解析这个名字 |
| 其他 VPN、内网穿透、公网 IP、自己的域名 | 先在「允许的外部地址」加入该 IP 或域名，再填 `http://<它>:8742/v1`；https 地址不用加 | 想走 HTTPS 就在前面加一层反向代理 |

已允许的公网地址走明文 http 时，输入框下方会有一行橙色提醒（令牌会明文传输），但不会拦你。授权按你填的那个地址精确申请，不会给扩展整个网络的访问权；从允许列表移除某个地址后，正在进行的托管会立即停止使用它。

### 分发给别人用

把打包好的扩展 ZIP 给对方（或让对方从 Release 下载），对方在 `chrome://extensions` 加载后，在设置里选「本地 Laya」，地址填你这台机器打印出来的地址、令牌填你给的令牌，保存并授权即可。对方不需要 Jev 密钥、不需要装 Python。你这边保持 `npm run laya -- --lan` 运行；换令牌就删掉 `~/.laya-server-token` 重启。
- 请求没带令牌或令牌错误返回 HTTP 401，扩展会停止托管并提示检查密钥。
- 服务端同一时间只跑一个推理，多台电脑同时托管会排队，响应变慢。
- macOS 首次监听所有网卡时可能弹出防火墙提示，需允许 Python 接受传入连接。

## 接口协议

本地服务实现的就是 Jev 的 systemone 候选选择协议，扩展对两种来源发送完全相同的请求。自己实现兼容服务时照此即可。

### 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/v1/systemone`（也接受 `/systemone`） | 决策 |
| `GET` | `/health`、`/v1/health`、`/` | 健康检查 |

### 请求

```http
POST /v1/systemone
Content-Type: application/json
Authorization: Bearer <令牌>        ← 仅在设置了令牌时发送
```

```json
{
  "model": "laya",
  "state": {
    "tick": 1200,
    "credits": 3500,
    "forceReadiness": { "ready": false, "reason": "…", "threshold": 8 },
    "units": [ … ]
  },
  "questions": {
    "vehicles": {
      "type": "choice",
      "instructions": "Pick the next vehicle to build.",
      "criteria": {
        "wait": "Build nothing now",
        "build_mtnk": "Build a Grizzly tank",
        "build_harv": "Build an ore miner"
      }
    },
    "tactics": {
      "type": "choice",
      "instructions": "Choose army posture.",
      "criteria": { "hold": "Hold near base", "attack": "Attack the enemy base" }
    }
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `model` | 扩展设置里的模型名；本地服务忽略 |
| `state` | 由扩展策略生成的战况对象，只含当前玩家视野内的信息（资金、电力、部队、生产队列、出击就绪状态等）；本局目标写在对应决策组的 `instructions` 里 |
| `questions` | 决策组，键为组名（小写字母和下划线，目前会出现 `construction`、`defenses`、`vehicles`、`infantry`、`tactics`、`scouting`、`deployment`、`engineering`、`garrison`、`transport`、`salvage`），每次 1–8 组 |
| `questions.*.type` | 固定 `choice` |
| `questions.*.instructions` | 这一组要决定什么 |
| `questions.*.criteria` | 候选：键为候选 ID，值为说明文字；每组 1–255 个 |

整个请求体不超过 256 000 字节。

### 响应（HTTP 200）

以下是实际服务对上面请求的返回：

```json
{
  "model": "laya-multilingual-mlx",
  "answers": {
    "vehicles": {
      "type": "choice",
      "choice": "build_mtnk",
      "confidence": 0.9778,
      "probabilities": { "wait": 0.0011, "build_mtnk": 0.9967, "build_harv": 0.0022 },
      "action": { "act_probability": 1.0 }
    },
    "tactics": {
      "type": "choice",
      "choice": "attack",
      "confidence": 0.7826,
      "probabilities": { "hold": 0.0347, "attack": 0.9653 },
      "action": { "act_probability": 1.0 }
    }
  },
  "usage": { "input_tokens": 174, "output_tokens": 0 },
  "latency_ms": 146.17
}
```

| 字段 | 扩展如何使用 |
| --- | --- |
| `model` | 显示在测试结果、悬浮窗、决策日志和战绩中 |
| `answers.<组名>.type` | 必须是 `choice` |
| `answers.<组名>.choice` | **必须是该组 `criteria` 里的某个键**，否则整次回答被拒绝、不执行任何动作 |
| `answers.<组名>.confidence` | 0–1，写入决策日志 |
| `answers.<组名>.probabilities` | 各候选概率；不在候选里的键被丢弃，写入决策日志 |
| `usage` | 计入会话统计；Laya 的 `output_tokens` 恒为 0 |
| `latency_ms`、`action` | 本地服务附带，扩展不依赖 |

每个请求的组都必须在 `answers` 里有回答。

### 错误

| 状态码 | 场景 | 扩展的处理 |
| --- | --- | --- |
| 401 | 需要令牌但未带或不对 | 显示原因并**停止托管** |
| 402 / 403 | （Jev 云端的额度 / 权限问题） | 显示原因并**停止托管** |
| 404 | 路径不对 | 记为请求失败，托管继续 |
| 400 / 413 | 请求体为空或超过 256 000 字节 | 记为请求失败，托管继续 |
| 422 | JSON 无效、缺 `state`、`questions` 为空、缺 `instructions` | 记为请求失败，托管继续 |
| 500 | 模型推理异常（服务本身继续运行） | 记为请求失败，托管继续 |

错误体格式为 `{"error": "原因"}`。扩展单次请求超时 8 秒，拒绝重定向，响应超过 256 000 字节也会拒绝。

## 请求日志与离线分析

排查「有回答但不造东西」这类问题时，给服务加 `--log`：

```sh
npm run laya -- --log laya.jsonl
```

每次决策追加一行，含时间、耗时、输入 token 数、战况长度、战况中的标量字段，以及每组的候选、选择、置信度和概率。用本仓库脚本汇总：

```sh
node tools/analyze-log.mjs laya.jsonl
```

扩展设置页的「决策日志」导出的 JSON 也能用同一个脚本分析，见 [README 决策日志](../README.md#决策日志)。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `laya-vs-jev repository not found at …` | 仓库不在本仓库旁边。移过去，或 `LAYA_REPO=/path/to/laya-vs-jev npm run laya`。在 git worktree 里运行时尤其要指定 |
| `No Python environment found. Run 'uv sync' …` | 进 laya-vs-jev 执行 `uv sync --extra demo` |
| `No Laya checkpoint found …` | 权重没下载，执行第一步的 `hf download`，或用 `--model` 指向已有目录 |
| `laya_mlx is not importable` | 用了系统 Python。请通过 `npm run laya` 启动，或直接用 `laya-vs-jev/.venv/bin/python tools/laya-server.py` |
| 端口被占用 | 已有服务在跑（`lsof -iTCP:8742 -sTCP:LISTEN`），复用它或换 `--port` |
| 扩展保存时提示地址须使用 HTTPS | 地址不是本机或私有网段；局域网请用私有 IP 或 `*.local` |
| 扩展提示 API 访问权限已被撤销 | 重新点「保存设置」并允许访问该地址 |
| 测试返回 401 | 局域网模式需要令牌；检查服务端 `~/.laya-server-token` |
| 其他电脑连不上 | 确认用了 `--lan`、两台机器在同一网段、macOS 防火墙允许 Python 传入连接 |

## 局限

- Laya 的上下文只有约 1024 个 token，而一局的战况描述通常更长。服务默认把数字、计数和标志等短字段排在前面，单位清单、队列等长数组排在后面，模型从末尾截断，先丢掉的是细节（`--raw-state` 关闭此重排）。
- 因此本地模型的决策质量明显弱于 Jev，实测在生产类决策组偏向选择「等待」。属实验用途，不保证胜率。
- 候选校验、请求上限、停止规则与 Jev 完全一致，扩展只信任设置里保存的地址和令牌，网页无法改变请求去向。
