# 大肥鱼 · 鲸鱼娘桌宠

一个挂在 Harness 界面上的桌面宠物式插件：DeepSeek 社区二创形象「大肥鱼 / 鲸鱼娘」——
蓝发、鲸鳍耳、女仆装、围裙上趴着一只小蓝鲸、身后一条大鲸尾——浮在窗口右下角，
覆盖在所有栏位之上，又不挡住下面的任何东西。

## 功能

- **逐帧动画桌宠。** 用社区精灵图集播放真实帧动画：6 帧待机循环、4 帧挥手、5 帧蹦跳，
  以 CSS `steps()` 每帧 140ms 播放。
- **会自己冒泡。** 没有其他交互时，每 9–16 秒挥手一次。
- **点击 / 轻触 / <kbd>Enter</kbd> / <kbd>Space</kbd>：** 她蹦一下（或挥手），
  飘起三颗爱心，并随机说一句六句本地化短句之一。
- **拖动：** 拎起来放到任意位置；位置记在 `localStorage` 里，窗口尺寸变化时会重新
  夹取边界，保证她不会跑到屏幕外找不回来。
- **首次加载：** 说一句欢迎气泡，每个浏览器只出现一次（v2 键）。
- **右键：** 弹出小菜单，含 **模型与供应商配置** 和 **OpenCode 模型监控** 两个子项，
  下面两节分别说明。
- 尊重 `prefers-reduced-motion`：关闭帧动画、爱心与气泡弹跳，角色和交互仍然保留。

## 右键菜单：AI 中转站配置

右键宠物（浏览器原生菜单已被屏蔽），选择 **模型与供应商配置**。这个对话框会把
供应商写进与 **设置 → 模型 → 添加模型供应商 → 自定义模型 API** 相同的
`llm-pi-ai` 设置命名空间，所以不用离开宠物，一个 OpenAI 或 Anthropic 兼容的中转站
就能被 Harness 使用。

字段说明：

| 字段 | 含义 |
|---|---|
| 供应商 ID | 小写路由键，例如 `my-relay`；同时是 `<ROUTE>_API_KEY` 凭据引用的前缀 |
| 显示名称 | 可选，显示在模型选择器里的标签 |
| 接口地址 | 中转站端点，例如 `https://relay.example.com/v1` |
| 接口协议 | OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages |
| 模型 | 点 **获取模型** 读取中转站暴露的全部模型；默认全选，可取消勾选，也可手动添加 ID |
| API Key | 通过凭据服务只写存储；留空则使用供应商默认认证 |

保存时发生的事：

1. **获取模型** 调用
   `llm.discoverModels('llm-pi-ai', { baseURL, api, apiKey? })`，带上端点、协议，以及
   已经填好的 API Key（如果有）。返回的目录会被列出并**默认全选**；不需要的取消勾选，
   用 **全选/清空** 批量调整，或在转运站不支持模型发现时手动添加 ID。
2. `settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route], value }], revision)`
   写入供应商配置（端点、协议、已选模型）。Harness 会即时应用设置，供应商立刻可用。
3. 如果填了 API Key，`credentials.set('<ROUTE>_API_KEY', key)` 只写存储；密钥永远不会
   进入设置文档，也不会留在本插件里。
4. 对话框显示成功状态，宠物说一句短话。打开输入框的模型选择器，选中新模型即可开始使用。

限制与边界：

- 这个表单只负责**新建**供应商。要编辑已有供应商的密钥、模型目录、上下文窗口、
  推理档位、重试策略，或删除它，请用 **设置 → 模型** —— 那些高级字段刻意不在这里重复。
- **模型发现是一次实时探测。** 中转站必须暴露兼容的 `/models` 端点；部分中转站调用
  它时要求带上密钥，所以请先填 Key 再获取。若中转站不支持发现，手动 ID 行仍能逐个添加模型。
- 表单会拒绝重复的供应商 ID、非 HTTP(S) 端点、非法路由，以及 HTTP 头承载不了的 API Key。
  只读设置文档会拒绝写入，对话框会说明原因。
- 设置写入携带打开对话框时读到的版本号；若另一个窗口并发改过，会显示 Host 的冲突提示，
  而不是直接覆盖。
- 点击外部、按 <kbd>Escape</kbd> 或选中菜单项后菜单收起；对话框可通过遮罩、
  <kbd>Escape</kbd> 或 **取消/完成** 关闭。

## 右键菜单：OpenCode Go 模型监控

右键宠物 → **OpenCode 模型监控** → 其一：

- **立即检查变动** —— 抓取一次新快照并与上一次对比。
- **查看最近变动记录** —— 列出最近的检查记录。

数据来源：

- `GET https://opencode.ai/zen/go/v1/models` —— 实时的 Included 模型列表。该端点目前
  也会返回价格与额度，监控优先使用它们，缺失时回退到文档表格。可选的 API Key 以
  `Authorization: Bearer ...` 形式发送。
- `https://opencode.ai/docs/go/` —— 文档里的价格/配额表，以及
  **Estimated requests**（`Requests per 5 hours`）表，按套餐分别解析
  （Go / Go Plus / Go Teams）。若页面结构变化或抓取失败，会沿用上次快照的配额与
  5h 请求估算，并给出警告；模型与 API 价格的差异照常比对。

每次检查都会把 JSON 快照原子写入
`$DSH_HOME/opencode-go-models-snapshots/`（未设 `DSH_HOME` 时为 `~/.dsh/...`），
按时间戳命名；保留最新 50 份，展示最新 20 份。差异会报告：

- 相对上次快照新增的模型；
- 相对上次快照移除的模型；
- 价格变化（输入、输出、缓存读、缓存写，另加全量计费规则的摘要，以便捕捉阶梯/峰谷倍率）；
- 三档套餐的月度配额变化；
- 文档估算的 5h 请求数变化（Go / Go Plus / Go Teams）。

检查后宠物会弹一句摘要；在打开监控/历史之前，宠物身上一直挂着提示点。API Key 通过
凭据服务以 `OPENCODE_GO_API_KEY` 只写存储，设置文档从不携带它。可选的自动检查在页面
可见时每 6 或 24 小时跑一次。

监控面板不只有差异，还把**当前状态**渲染成三标签页的图表：

- **配额图** —— 每个模型一行，Go、Go Plus、Go Teams 三组横条，按最大配额归一；∞ 表示不限量。
- **价格图** —— 输入价与输出价横条共享一个最大值，旁边标注精确的 $/1M 数值。
- **明细** —— 文字列表，含输入/输出/缓存读价格与三档配额。

图例每一项都可切换：点击 **Go**、**Go Plus**、**Go Teams**、**输入** 或 **输出**
即可隐藏该系列；剩余横条按可见最大值重新缩放，数值列也只列可见系列。再点一次恢复。
横条与数值列始终按模型对齐。图表上方的 **隐藏图例** 链接可整块收起图例，
**显示图例** 可重新展开。

单系列隐藏状态与整块图例显隐都保存在 `localStorage`，关掉面板或重载界面后仍保持
原样（键为 `dsh.deepseek-pet.opencode.hiddenSeries` 与
`dsh.deepseek-pet.opencode.showLegend`）。

**用量排序** 控件对两个图表和明细列表都生效，按所选套餐（Go / Go Plus / Go Teams）的
月度配额排序，默认配额高的在前，箭头可翻转方向。没有配额的模型始终排在最后，
`unlimited` 视为最高值。所选套餐与方向保存在 `localStorage`
（`dsh.deepseek-pet.opencode.sortField`、`dsh.deepseek-pet.opencode.sortDir`）。

它排的是面板里展示的**月度配额上限**，不读取已消耗用量或账户余额。

文档里的 **Estimated requests / 5 hr** 数值作为参考一并展示。配额图会在配额数值下方
显示一行紧凑的 `5h` 副值，跟随可见图例系列；明细页显示 Go、Go Plus、Go Teams 的精确
数字。这些是文档估算值，不是硬限制。5h 估算的变化也会像价格/配额那样参与差异比对。

图表上方的摘要标签显示模型数量、价格来自实时 API 还是文档、以及是否已配置 Key。
没有变化的检查会显示 **没有变动**，而不是 0/0/0 的计数，同时下方仍完整展示当前状态。

Host 半区通过 `ctx.connection.fetch.register` 注册了三个认证路由 ——
`/api/deepseek-pet/opencode/check`（POST）、
`/api/deepseek-pet/opencode/history`（GET）、
`/api/deepseek-pet/opencode/status`（GET）。所有网络与文件操作都在这里完成，
浏览器端因此不需要处理 CORS。Client 半区支持热更新；Host 半区的改动要等下一次插件重载
或 DSH 重启才生效。

## 与 Harness 界面的关系

- 在横跨整帧的 `shell.overlay` 插槽注册 `deepseek-pet` 条目。该层默认点击穿透，
  宠物只在自己的 144×168 命中区域重新接收指针事件，因此不会挡住输入框或其他控件。
- 文案注册为 `deepseek-pet` 语言命名空间（中英双语），通过插槽注入的 `t` 座位读取
  （回退到一个绑定的翻译函数）。
- 精灵图集以 data URI 内嵌在 `client.js`，因为客户端 bundle 只能提供自己的 `client.js`，
  无法加载同目录的图片文件。原始的 `assets/pet-sheet.webp` 仍随包保留，用于溯源。

## 文件

| 文件 | 用途 |
|---|---|
| `package.json` | bundle 清单：补丁、客户端入口、语言包与图标导出 |
| `cordis.patch.yml` | 插入 `deepseek-pet` 的 Host 条目 |
| `index.js` | Host 半区：OpenCode 监控认证路由与只写密钥存储 |
| `monitor.js` | Host 监控核心：抓取模型、解析文档/配额、差异引擎、原子快照 |
| `client.js` | 客户端模块：插槽注册、精灵动画、拖动/摸头、右键中转站配置与 OpenCode 监控界面、文案 |
| `assets/pet-sheet.webp` | 6×3 打包精灵图集（待机 / 挥手 / 蹦跳） |
| `locale/en.json`、`locale/zh.json` | 插件清单里显示的标题与描述（英文 / 中文） |
| `icon.png` | 插件图标，取自同一套角色画稿 |
| `LICENSE` | 大肥鱼项目署名许可 1.0（全文） |
| `NOTICE.md` | 署名链、修改说明、许可要求 |

## 素材与许可

这**不是** DeepSeek 官方产品，也未获 DeepSeek 认可。

角色与动画素材来自
[YunYueSama/codex-deepseek-pet](https://github.com/YunYueSama/codex-deepseek-pet)，
依「大肥鱼项目署名许可 1.0」使用。该许可允许使用、修改、分享与商用，但要求保留
作者与仓库地址、附带完整许可文本，并注明修改内容。

```text
作者：YunYueSama
仓库：https://github.com/YunYueSama/codex-deepseek-pet
```

上游角色署名：鲸鱼娘原案 上善无形（上善）；DeepSeek 元素女仆装改绘 ZipZipPipe。
完整署名链与对精灵图集做过的确切修改见 [NOTICE.md](NOTICE.md)。

## 安装

从 npm（已发布为 `dsh-dfy-pet`）：

```text
plugin_manager install_bundle  ->  target: dsh-dfy-pet
```

从本源码目录（本地开发）：

```text
plugin_manager install_bundle  ->  target: <this directory>
```

环境要求：DSH 版本在 `>=0.2.1-rc.2 <0.3.0` 区间，Node `>=18`。本 bundle 由 Host 半区
与 Client 半区组成；Client 半区按包名 `dsh-dfy-pet` 匹配，所以包名与 `client.js` 里的
模块 `id` 必须保持一致。

新 bundle 可通过热更新生效。替换已安装的客户端 bundle，可能需要重新加载界面后
才会载入新的动画版本。

### 发布新版本

```text
npm pack --dry-run     # 核对文件清单（12 个文件，不缺素材）
npm publish            # 需要 npm 登录并拥有该包名
```

`files` 清单是刻意写全的：`client.js`、`monitor.js`、语言包、精灵图集、图标和补丁
都必须随包发布，否则安装后界面会空白或加载失败。
