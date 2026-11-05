# Shoho 视觉标识

## 方向

极简水滴轮廓，灰玉绿磨砂玻璃，轻微立体和新拟态光影；下缘弧形切口表达「小喝一口」。去除表情、气泡和装饰，兼顾桌面图标与小尺寸辨识。

- 主色：`#657B70`；暗部：`#445A50`；高光：`#A8B9AB`。
- `icon.png`：内置 image_gen 生成并按用户反馈降低亮度与饱和度，保留生成源文件的透明度。
- `logo.svg`：用于小尺寸或单色场景的简化矢量标识。
- `trayTemplate.png`：与标识相呼应的单色托盘模板，适应系统深浅主题。
- `src-tauri/icons/`：通过 `npm run tauri icon assets/icon.png` 导出的各平台图标。

## 生成方式

使用内置 image_gen 工具；未使用 CLI/API fallback。以下保留实际提示词。

### 初版生成提示

```text
Use case: logo-brand.
Asset type: production macOS and Windows desktop app icon for Shoho, a minimalist hydration reminder.
Primary request: create one premium minimalist icon combining a flat, instantly recognizable silhouette with restrained 3D depth, glassmorphism and soft neumorphic lighting.
Composition: square 1024 x 1024 image; one softly rounded square porcelain-frosted tile with transparent pixels outside the rounded tile, centered; an abstract single water droplet occupying about 60% of the tile. The droplet is sculpted from translucent pale jade and clear aqua glass, with a clean curved negative-space cut near the lower right suggesting a small sip. Simple geometric silhouette, generous breathing room, carefully balanced optical proportions, legible at 32 px.
Lighting and material: restrained glass refraction, delicate beveled edge, one broad soft highlight, very shallow soft contact shadow; subtle tactile relief rather than dramatic extrusion. Matte warm-white tile, slightly cool frosted center; muted jade/teal droplet. Front-facing icon with a hint of dimensionality, not an angled product mockup.
Constraints: no words, no letters, no wordmark, no face, no eyes, no cheeks, no mascot, no bubbles, no sparkles, no extra objects, no decorative framing, no rainbow sheen, no strong gradients in the backdrop, no heavy shadows, no dark outlines, no watermark. Refined, quiet, modern and minimal. This is a finished icon asset, not a presentation sheet or a collage.
```

### 根据用户反馈调整颜色

```text
Use case: precise-object-edit.
Edit target: the supplied Shoho app icon.
Change only color, lighting and edge cleanliness; preserve the exact rounded-square composition, water-drop silhouette and curved cut on its lower right.
The current mint/aqua is too bright. Replace it with a distinctly darker, muted gray-jade / smoky sage-green glass. Main body should be near #657B70 with shadow tones near #445A50 and restrained highlights near #A8B9AB. Lower overall luminance and saturation; remove bright cyan, luminous mint, emission, glowing edges and white-hot reflections. The glass should feel smoked and softly frosted, with a subtle broad highlight and gentle shallow 3D relief.
Keep the tile very pale warm gray, softly matte with subtle neumorphic shading. Outside the rounded tile must be completely transparent and visually clean: remove all the noisy speckles, isolated white pixels and fringe from the original. One clean icon, crisp silhouette, generous space; no text, no face, no extra symbols, no decorative additions.
```
