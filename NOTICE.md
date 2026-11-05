# 素材来源与许可 / Attribution

## 角色与美术

本插件使用的是 DeepSeek 社区二创形象「大肥鱼 / 鲸鱼娘」，不是 DeepSeek 官方形象，
也未获得 DeepSeek 官方认可或代言。

- **角色形象、立绘与逐帧动画：YunYueSama**
  - 仓库：<https://github.com/YunYueSama/codex-deepseek-pet>
  - 许可：大肥鱼项目署名许可 1.0（自定义许可，非标准 MIT），全文见同目录 `LICENSE`
- **鲸鱼娘原始角色形象：上善无形（上善）**
  - Bilibili：<https://space.bilibili.com/4456176>
- **加入 DeepSeek 元素的女仆鲸鱼娘二次设计：ZipZipPipe**
  - Bilibili：<https://space.bilibili.com/4168597>
  - Pixiv《AI娘化》：<https://www.pixiv.net/artworks/148186519>
- **社区设定图整理：xiaoweigen**
  - 仓库：<https://github.com/xiaoweigen/deepseek-dafeiyu-assets>（CC BY-NC-SA 4.0）

上游角色、前序设计和参考图的相关权利归各自权利人所有；本插件只使用
YunYueSama 仓库中由其授权的新增贡献。

## 本插件对素材的修改

1. 从 `codex-deepseek-pet/spritesheet-web.webp`（1536×1872，8 列 × 9 行，
   单元格 192×208）中截取三行动画：
   - 第 1 行 `idle`：6 帧
   - 第 4 行 `waving`：4 帧
   - 第 5 行 `jumping`：5 帧
2. 每格裁去四周透明留白（统一裁切框 `24,32,168,200`，单元格 144×168），
   按 6 列 × 3 行重新拼接为 `assets/pet-sheet.webp`（WebP，质量 90）。
3. 为适配 Harness Web 插件的单文件客户端，将该图集以 data URI 内嵌进
   `client.js`；运行时用 CSS `steps()` 逐帧播放，未改动角色本身。
4. 插件图标 `icon.png` 由同一仓库的 `build/icon.png` 缩放至 256×256 并压缩。
5. 立绘背景、角色设定、配色和服装均未改动。

## 许可要求

依据 `LICENSE`（大肥鱼项目署名许可 1.0）：

- 必须保留署名：作者 **YunYueSama** 与仓库地址
  <https://github.com/YunYueSama/codex-deepseek-pet>；
- 分发素材或其实质性部分时保留完整许可文本（本仓库 `LICENSE`）；
- 修改后注明经过修改（见上一节）。

参考署名：

```text
作者：YunYueSama
仓库：https://github.com/YunYueSama/codex-deepseek-pet
```
