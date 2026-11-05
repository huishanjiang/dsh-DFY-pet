# 大肥鱼 · 鲸鱼娘桌宠 (DeepSeek Whale Girl)

A desktop-pet-style plugin for the Harness Web UI: the DeepSeek community fan
character「大肥鱼 / 鲸鱼娘」— blue hair, whale-fin ears, maid dress, a little blue
whale on her apron and a big whale tail — floats in the bottom-right corner of
the window, above every column, without blocking anything underneath.

## What it does

- **Animated sprite pet.** Real frame animation from the community sprite
  atlas: a 6-frame idle loop, a 4-frame wave and a 5-frame jump, played with CSS
  `steps()` at 140 ms per frame.
- **Alive on her own.** Every 9–16 seconds, when nothing else is happening, she
  waves once.
- **Click / tap / <kbd>Enter</kbd> / <kbd>Space</kbd>:** she jumps (or waves),
  three hearts float up, and she says one of six short localized lines.
- **Drag:** pick her up and put her anywhere; the corner is remembered in
  `localStorage`, and the position is re-clamped on window resize so she can
  never be lost off-screen.
- **First load:** a short greeting bubble, once per browser (v2 key).
- **Right-click:** a small menu with **模型与供应商配置 / Model & provider settings**
  and an **OpenCode 模型监控 / OpenCode model monitor** submenu; the two sections
  below describe them.
- Respects `prefers-reduced-motion`: frame animation, hearts and the bubble pop
  are disabled, while the character and interactions remain.

## 右键菜单：AI 中转站配置

Right-click the pet (the browser context menu is suppressed) and choose **模型与
供应商配置**. The dialog writes a provider into the same `llm-pi-ai` settings
namespace that **Settings → Models → Add model provider → Custom model API**
uses, so an OpenAI- or Anthropic-compatible relay becomes available to Harness
without leaving the pet.

Fields:

| Field | Meaning |
|---|---|
| 供应商 ID / Provider ID | Lowercase route key, e.g. `my-relay`; also the stem of the `<ROUTE>_API_KEY` credential reference |
| 显示名称 / Display name | Optional label shown in the model picker |
| 接口地址 / Base URL | Relay endpoint, e.g. `https://relay.example.com/v1` |
| 接口协议 / API protocol | OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages |
| 模型 / Models | Click **获取模型 / Fetch models** to read every model the relay exposes; all are selected by default, and you can uncheck entries or add an ID manually |
| API Key | Stored write-only through the credentials service; leave blank to use the provider's default auth |

What happens on save:

1. **获取模型 / Fetch models** calls
   `llm.discoverModels('llm-pi-ai', { baseURL, api, apiKey? })` with the
   endpoint, protocol, and the API key if one is already typed. The returned
   catalog is listed with **every model selected**; uncheck what you do not
   want, use **全选/清空** for bulk changes, or add an ID manually if the relay
   does not implement model discovery.
2. `settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route], value }], revision)`
   adds the provider profile (endpoint, protocol, the selected models). Harness
   applies settings live, so the provider becomes available immediately.
3. If an API key was entered, `credentials.set('<ROUTE>_API_KEY', key)` stores it
   write-only; the key never lands in the settings document or in this plugin.
4. The dialog shows a success state, and the pet says a short line. Open the
   composer's model selector and choose one of the new models to start using it.

Notes and boundaries:

- This form **creates** a provider. To edit an existing provider's key, catalog,
  context window, reasoning levels, retry policy, or to delete it, use
  **Settings → Models** — those advanced fields are deliberately not duplicated
  here.
- **Model discovery is a live probe.** The relay must expose a compatible
  `/models` endpoint; some relays require the API key for that call, so type the
  key before fetching. If discovery is unsupported, the manual ID row still adds
  models one by one.
- The form refuses duplicate Provider IDs, non-HTTP(S) endpoints, invalid routes,
  and API keys that an HTTP header cannot carry. A read-only settings document
  refuses writes and the dialog reports why.
- Settings writes carry the revision read when the dialog opened; a concurrent
  change from another window surfaces the Host's conflict message instead of
  overwriting it.
- The menu closes on an outside click, on <kbd>Escape</kbd>, or after choosing
  the item; the dialog closes on the mask, <kbd>Escape</kbd>, or **取消/完成**.

## 右键菜单：OpenCode Go 模型监控

Right-click the pet → **OpenCode 模型监控 / OpenCode model monitor** → one of:

- **立即检查变动 / Check for changes now** — fetches a fresh snapshot and diffs it
  against the previous one.
- **查看最近变动记录 / View recent changes** — lists the recent checks.

Data sources:

- `GET https://opencode.ai/zen/go/v1/models` — the live Included models. The
  endpoint currently also returns prices and limits; the monitor uses them when
  present and falls back to the docs table. An optional API key is sent as
  `Authorization: Bearer ...`.
- `https://opencode.ai/docs/go/` — the docs pricing/quota tables plus the
  **Estimated requests** tables (`Requests per 5 hours`), parsed per plan
  (Go / Go Plus / Go Teams). If the page structure changes or the fetch fails,
  the previous snapshot's quotas and 5h request estimates are carried forward and
  a warning is shown; model and API-price diffs still run.

Each check writes an atomic JSON snapshot to
`$DSH_HOME/opencode-go-models-snapshots/` (`~/.dsh/...` when `DSH_HOME` is unset),
named by timestamp; the newest 50 are kept and the newest 20 are shown. The diff
reports:

- models added since the previous snapshot;
- models removed since the previous snapshot;
- price changes (input, output, cache read, cache write, plus a digest of the
  full cost rules so tier/peak multipliers are caught);
- monthly quota changes for all three plans;
- changes to the docs' estimated requests per 5 hours (Go / Go Plus / Go Teams).

The pet shows a summary bubble after a check, and a warning dot stays on the pet
until the monitor/history is opened. The API key is stored write-only through the
credentials service as `OPENCODE_GO_API_KEY`; the settings document never carries
it. An optional auto-check runs every 6 or 24 hours while the page is visible.

The monitor panel also renders the **current state** — not just the diff — as
charts with three tabs:

- **配额图 / Quota chart** — grouped horizontal bars for Go, Go Plus and Go Teams
  per model, normalized to the largest quota; ∞ marks unlimited plans.
- **价格图 / Price chart** — input and output price bars per model on one shared
  maximum, with the exact $/1M values beside them.
- **明细 / Details** — the textual list with input/output/cache-read prices and
  all three quotas.

Every legend item is a toggle: click **Go**, **Go Plus**, **Go Teams**, **输入**
or **输出** to hide that series; the remaining bars rescale to the visible
maximum, and the value column only lists the visible series. Click again to show
it. Bars and the value column stay aligned per model. The **隐藏图例 / Hide
legend** link above the chart collapses the whole legend; **显示图例 / Show
legend** brings it back.

Both the per-series hidden set and the whole-legend visibility are saved in
`localStorage`, so closing the panel or reloading the page keeps them as you left
them (keys `dsh.deepseek-pet.opencode.hiddenSeries` and
`dsh.deepseek-pet.opencode.showLegend`).

The **用量排序 / Usage sort** control applies to both charts and the details
list. It sorts by the monthly quota of the selected plan — Go, Go Plus, or Go
Teams — with the highest quota first by default; the arrow flips the direction.
Models without a quota stay last, and `unlimited` counts as the highest value.
The selected plan and direction are saved in `localStorage`
(`dsh.deepseek-pet.opencode.sortField`, `dsh.deepseek-pet.opencode.sortDir`).

This sorts the monthly **quota limits** shown in the panel; it does not read
consumed usage or the account balance.

The docs' **Estimated requests / 5 hr** values are included as a reference. The
quota chart shows a compact `5h` subline under the quota values, following the
visible legend series; the details tab shows the exact numbers for Go, Go Plus
and Go Teams. These are docs estimates, not a hard limit. Changes to the 5h
estimates are also diffed like price/quota changes.

The summary chips above the chart show the model count, whether prices came from
the live API or the docs, and whether a key is configured. A check with no
changes shows **没有变动** instead of a 0/0/0 counter, while the full state stays
visible below it.

The Host half serves three authenticated routes —
`/api/deepseek-pet/opencode/check` (POST),
`/api/deepseek-pet/opencode/history` (GET), and
`/api/deepseek-pet/opencode/status` (GET) — registered through
`ctx.connection.fetch.register`. All network and filesystem work happens there,
so the browser never needs CORS access. The Client half hot-reloads; a change to
the Host half takes effect at the next plugin reload or DSH restart.

## How it fits the Harness UI

- Registers the `deepseek-pet` entry in the frame-wide `shell.overlay` slot.
  That layer is click-through; the pet opts back into pointer events only on
  its own 144×168 hit area, so it never blocks the composer or other controls.
- Copy is registered as the `deepseek-pet` locale namespace (English + Chinese)
  and read through the slot's injected `t` seat (falling back to a bound
  translator).
- The sprite atlas is embedded as a data URI in `client.js`, because a client
  bundle serves only its own `client.js` and cannot load sibling image files.
  The original `assets/pet-sheet.webp` is kept in the package for provenance.

## Files

| File | Purpose |
|---|---|
| `package.json` | Bundle manifest: patch, client entry, locale and icon exports |
| `cordis.patch.yml` | Inserts the `deepseek-pet` Host row |
| `index.js` | Host half: authenticated OpenCode monitor routes and write-only key storage |
| `monitor.js` | Host monitor core: model fetch, docs/quota parser, diff engine, atomic snapshots |
| `client.js` | Client module: slot registration, sprite animation, drag/poke, right-click relay config and OpenCode monitor UI, copy |
| `assets/pet-sheet.webp` | Packed 6×3 sprite atlas (idle / wave / jump) |
| `locale/en.json`, `locale/zh.json` | Inventory title and description |
| `icon.png` | Plugin icon, derived from the same character artwork |
| `LICENSE` | 大肥鱼项目署名许可 1.0 (full text) |
| `NOTICE.md` | Attribution chain, modifications, license requirements |

## Artwork and license

This is **not** a DeepSeek official product, and it is not endorsed by DeepSeek.

The character and animation artwork come from
[YunYueSama/codex-deepseek-pet](https://github.com/YunYueSama/codex-deepseek-pet),
used under the「大肥鱼项目署名许可 1.0」. The license allows use, modification,
sharing and commercial use, but requires keeping the author and repository URL,
including the full license text, and noting modifications.

```text
作者：YunYueSama
仓库：https://github.com/YunYueSama/codex-deepseek-pet
```

Upstream character credits: original whale-girl character by 上善无形（上善）;
DeepSeek-element maid redesign by ZipZipPipe. See [NOTICE.md](NOTICE.md) for the
full attribution chain and the exact modifications made to the sprite atlas.

## Installing

From npm (published as `dsh-dfy-pet`):

```text
plugin_manager install_bundle  ->  target: dsh-dfy-pet
```

From this source directory (local development):

```text
plugin_manager install_bundle  ->  target: <this directory>
```

Requirements: a DSH build within `>=0.2.1-rc.2 <0.3.0` and Node `>=18`. The
bundle is a Host half plus a Client half; the Client half is matched by the
package name `dsh-dfy-pet`, so the package name and the module `id` in
`client.js` must stay in sync.

A new bundle can activate through HMR. Replacing an installed client bundle may
require a page reload before the new animation generation is loaded.

### Publishing a new version

```text
npm pack --dry-run     # verify the file list (12 files, no missing assets)
npm publish            # requires npm login and ownership of the name
```

The `files` list is intentionally explicit: `client.js`, `monitor.js`, the
locale files, the sprite atlas, the icon and the patch must all ship, or the
installed bundle renders blank or fails to load.
