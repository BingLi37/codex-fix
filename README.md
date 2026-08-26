# Codex ID 修复代理

**中文** · [English](README.en.md)

修复并预防 Codex 会话被中转站的 id 校验卡死，同时把「换中转站」变成点一下的事。

## 一句话原理

中转站有时会给 `custom_tool_call` 发 `fc_` 或 `item_` 开头的 id，而 Responses API 要求 `ctc_`。
Codex 原样存进历史，之后每轮都重放这段历史，于是每轮都被 400 拒掉，会话彻底卡死。

这个代理插在 Codex 和中转站之间，双向把 id 改对：

```
Codex ──► 127.0.0.1:7801/v1 (代理) ──► 系统代理 7897 ──► 当前中转站
              ▲ 出站修历史 / 入站修响应
```

- **出站**：修掉重放历史里的坏 id，所以已经存坏的会话也能继续用。
- **入站**：在 SSE 流里就地改掉，Codex 内存里从一开始就是干净的，不会再写出新的坏数据。

## 环境要求

- **Windows**。控制面板用 `netstat` 找代理进程、用 `.vbs` 无窗口启动，这两处是 Windows 专用的。
  代理本体（`id-sanitizing-proxy.mjs`）本身跨平台。
- **Node 20+**。改界面需要 20.19+（Vite 8 的要求）。
- **Codex CLI**，且当前经由某个中转站访问模型。

## 安装

```bash
git clone https://github.com/BingLi37/codex-fix.git
cd codex-fix
```

界面构建产物 `ui/dist` 已经在仓库里，**开箱即用，不需要 npm install**。
只有要改界面时才需要 `cd ui && npm install`。

然后三步：

**1. 填中转站**：双击 `启动控制面板.cmd`，浏览器打开 <http://127.0.0.1:7800>，
点「中转站」→「添加」，填你现在用的那个地址和 key。

**2. 改 Codex 的 base_url**：把 `~/.codex/config.toml` 里的 `base_url` 指向代理：

```toml
[model_providers.custom]
base_url = "http://127.0.0.1:7801/v1"
```

改之前先备份一份。面板顶部的「Codex 接入状态」会告诉你这行对不对得上。

**3.（可选）开机自启**：`Win+R` 输入 `shell:startup`，把 `autostart-hidden.vbs` 的
快捷方式丢进去。它会自己定位项目目录和 node，不含任何绝对路径。
这样不打开界面，代理也在后台跑。

## 用法

双击 `启动控制面板.cmd`，浏览器会打开 <http://127.0.0.1:7800>。

界面上可以：启动/停止/重启代理、换中转站、看它是否在工作、看实时工作流（每次修正都显示
`坏id → 好id`）、看错误详情（含中转站返回的原文）、运行自检、扫描或修复历史会话文件。

## 换中转站

**Codex 的 `base_url` 从此固定为 `http://127.0.0.1:7801/v1`，再也不用动 `config.toml`。**

真正的中转站地址记在 `relays.json` 里（首次保存时生成，已在 `.gitignore` 中），由代理转发。
界面上点「中转站」按钮：

- **切换**：点一下即生效，不用重启代理，也不用重启 Codex。
- **添加**：只保存，不会自动启用。要用再点「切换」。
- **API Key**：留空就沿用 Codex 自己的 key（`auth.json`）；填了就用它覆盖，这样换站不用改 `auth.json`。
- **测试**：真发一次请求到该中转站的 `/models`，走和真实流量一样的通道。401 表示能连通但 key 不对——
  如果这个站留空 key、由 Codex 提供 key，那 401 是正常的。

Base URL 的路径会自动映射：Codex 请求 `/v1/responses`，若中转站是 `https://x.com/api/v3`，
实际会发到 `https://x.com/api/v3/responses`。

**所以 Base URL 要带上路径前缀。** 填 `https://x.com` 会发到 `https://x.com/responses`（少了 `/v1`），
大多数中转站会拒。照抄它给你的那个完整地址就对了。

## 其他报错怎么看

面板会把中转站返回的原文完整显示出来。三种常见报错：

| 报错 | 含义 | 怎么办 |
| --- | --- | --- |
| `Expected an ID that begins with 'ctc'` | id 前缀错 | 自动修，不用管 |
| `was provided without its required 'reasoning' item` | 中转站拒绝了某个工具调用的 id | 自动换新 id 重试并记住，不用管 |
| `No tool output found for function call` | 工具调用缺对应输出 | 历史组装问题，代理不介入 |

第二种（reasoning 项）的实测结论，报错信息本身是误导性的：

- 它说“缺少 reasoning 项”，但**那个 reasoning 项就在请求里**，位置正确、带着 encrypted_content。
- 只把 reasoning 的 id 换掉 → 仍然被拒。
- 只把那个**工具调用自己的 id** 换成新的（reasoning id 和 `call_id` 都不动）→ **通过**。

所以问题不在本地历史，是中转站上游针对那个 id 存了一条坏记录。`function_call` 和
`custom_tool_call` 都会中招，各自要保持 `fc_` / `ctc_` 前缀。

代理的处理分两步：

1. **被拒时**自动给那个调用换新 id 重试（最多 8 次）。中转站一次只报一个坏 id，
   而一段坏历史里可能有好几个（实测某个会话有 5 个可换的工具调用），所以要能连续换。
2. **记住这些 id**，之后的请求在发出前就直接换掉，不再走重试。这个黑名单存在
   `logs/poisoned-ids.json`，重启也不丢。

实测效果：第一轮 4 次上游请求（1 次原始 + 3 次重试）把坏 id 找出来，第二轮起
**只需 1 次**。重启后仍然是 1 次。

**这些限制不是每次都触发**：中转站背后接了多个上游，只有落到严格校验的那个才报错。
同一段历史可能时好时坏，所以黑名单只会越攒越准。

## 前缀这件事比想象的复杂

一开始只修 `custom_tool_call` 的前缀，理由是历史上 2280 次前缀报错**全部**要求 `ctc`。
后来中转站开始拒绝别的类型，这个理由就失效了。现在按类型分别处理：

| 类型 | 需要的前缀 |
| --- | --- |
| `custom_tool_call` / 其输出 | `ctc_` / `ctco_` |
| `function_call` / 其输出 | `fc_` / `fco_` |
| `message` | `msg_` |
| `reasoning` | 见下 |

`reasoning` 是个例外，因为两个后端要求互相矛盾：

- 一个拒绝 `item_` 前缀：`Expected an ID that begins with 'rs'`
- 改成 `rs_` 之后另一个又拒绝：`Item with id 'rs_…' not found. Items are not
  persisted when store is set to false`

同一个 id 两种改法都不行。区别在于这个项有没有 `encrypted_content`：

- **有** → 是个真实项，前缀改成 `rs_`
- **没有** → 服务端根本没有它的记录，`rs_` 必然查不到，所以**直接去掉 id**

去掉 id 两个错误都不会触发：没有前缀可校验，也没有 id 可查。实测那个引发两种报错的
真实项（无 encrypted_content）现在能正常通过。

## 事件流里的「历史异常」

被拒时代理会额外记一条，给出事实而不是猜测：中转站要的那个 reasoning id 在不在请求里、
排第几项、有没有 encrypted_content。四种情况分别对应不同结论，都有测试覆盖。

## 连接不稳定（和 id 无关）

日志里会看到 `ECONNRESET — socket hang up`，那不是 id 问题，是系统代理或中转站的连接被掐断。
实测统计：

| 请求大小 | 出现 ECONNRESET |
| --- | --- |
| <100KB | 2% |
| 100KB–1MB | 4–5% |
| >1MB | 6% |

代理的应对是断了以后改直连重试一次，实测能救回约 **三分之二**（328 次里 210 次最终成功）。

另外加了**空闲超时**（默认 120 秒）：曾经有一个请求挂了 5847 秒（97 分钟）才结束，
因为上游连接死了但没人断开它。超时计的是“多久没有任何数据”，不是总时长，
所以慢但活着的流不受影响（实测 10.6 秒的流在 3 秒预算下正常跑完）。

想调整：`CODEX_ID_PROXY_IDLE_MS=180000`。

## 性能开销

用本地假上游实测（每档 25 次取中位数，只算代理自身开销，不含中转站延迟）：

| 场景 | 直连总耗时 | 经代理 | 开销 |
| --- | --- | --- | --- |
| 8KB 请求 / 100 个 token | 1.9ms | 5.4ms | +3.5ms |
| 200KB 请求 / 400 个 token | 5.8ms | 14.7ms | +8.9ms |
| 680KB 请求 / 1500 个 token | 14.4ms | 36.0ms | +21ms |

对照真实一次请求实测 5–7 秒，**开销约 0.4%**，感知不到。

出站请求现在一律解析（不再走快速路径预筛），因为漏掉一个前缀就会卡死会话——
这比省下那几毫秒重要。快速路径只留给 SSE 流，那里每秒有成百上千个 token delta。

`node bench.mjs` 可自己复测。

## 文件

| 文件 | 作用 |
| --- | --- |
| `id-sanitizing-proxy.mjs` | 代理本体，改 id 的逻辑都在这里 |
| `relay-config.mjs` | 中转站配置读写、路径映射、`CODEX_HOME` 定位 |
| `relay-probe.mjs` | 连通性测试用的一次性探测 |
| `id-sanitizing-proxy.test.mjs` | 代理自检，45 个用例 |
| `repair-ctc-ids.mjs` | 批量修复已存坏的 rollout 文件 |
| `control-panel.mjs` | 控制面板服务（7800），也负责拉起代理 |
| `bench.mjs` | 性能压测 |
| `ui/` | HeroUI + React 界面源码，`ui/dist` 是构建产物（已入库） |
| `ui/src/App.test.jsx` | 界面交互测试，24 个用例 |
| `ui/src/promo-card.js` | 右下角的推广卡片。不想要就删掉这个文件和 `ui/src/main.jsx` 里的那行 import |
| `dashboard-fallback.*` | 无依赖的简易界面，`ui/dist` 缺失时自动启用 |
| `启动控制面板.cmd` | 入口：面板没起就先起，再开浏览器 |
| `autostart-hidden.vbs` | 无窗口启动面板，自己定位项目目录和 node |

运行时生成、**不入库**（见 `.gitignore`）：

| 文件 | 作用 |
| --- | --- |
| `relays.json` | 中转站列表和当前启用的那个（含 API Key，明文） |
| `logs/events.jsonl` | 结构化事件，界面读的就是它 |
| `logs/poisoned-ids.json` | 中转站拒绝过的 id 黑名单，发请求前直接换掉 |

## 命令行

```bash
node id-sanitizing-proxy.test.mjs        # 代理自检（45 个用例）
node repair-ctc-ids.mjs                  # 扫描历史会话，不改文件
node repair-ctc-ids.mjs --apply          # 修复，原文件先备份到 ~/.codex/backups
node bench.mjs                           # 性能压测
curl http://127.0.0.1:7801/__id_proxy_health

cd ui && npm test                        # 界面测试（24 个用例）
cd ui && npm run build                   # 改完界面后必须重新构建
```

环境变量：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex 数据目录，读 `config.toml` 和 `sessions/` 用 |
| `CODEX_PANEL_PORT` | `7800` | 控制面板端口 |
| `CODEX_ID_PROXY_PORT` | `7801` | 代理端口 |
| `CODEX_RELAY_CONFIG` | `./relays.json` | 中转站配置文件位置 |
| `CODEX_ID_PROXY_IDLE_MS` | `120000` | 上游空闲超时 |
| `HTTPS_PROXY` | `http://127.0.0.1:7897` | 上游走的系统代理 |
| `CODEX_NODE_EXE` | 自动探测 | `autostart-hidden.vbs` 用哪个 node |

## 注意

- **代理不跑，Codex 就连不上模型。** 界面上的「Codex 接入状态」会显示 `config.toml` 里的
  `base_url` 是否还对得上。
- **切换中转站会立刻影响正在进行的对话。** 切错了会看到一串错误，切回来就好。
- `relays.json` 里的 API Key 是明文存的，和 `auth.json` 一样。这台机器上的其他程序能读到它。
- 系统代理（7897）挂了不会导致 Codex 不可用，代理会自动降级成直连重试一次。
- 前缀按类型分别修，`reasoning` 视有无 `encrypted_content` 决定改前缀还是去掉 id。
- 想彻底退回原状：把 `config.toml` 的 `base_url` 改回中转站地址，删掉 Startup 里的快捷方式。
- `ui/node_modules` 约 300MB，只有改界面才需要装。
