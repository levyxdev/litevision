# Provider image and video parameters (researched 2026-11-05)

> **Temporary: delete this file once the built-in Parameter Guide (ADR 0010) has been written from it.** It is raw research input, not documentation, and is not kept up to date. Facts in it have not all been checked against the sources yet.

Primary sources only (provider docs, provider model-list APIs, model vendor docs). Every section names its source URLs. "Not documented" means the cited provider docs say nothing about it. **⚠** marks conflicts, doc errors or points I am unsure of.

Notes on sources:
- OpenAI's `platform.openai.com` docs now live at `developers.openai.com` (markdown by appending `.md`); `platform.openai.com/docs/api-reference/images/create` returned 403 to the fetcher but redirects to the same content.
- `ai.google.dev/gemini-api/docs/*` redirects (301) to `aistudio.google.com/docs/*`.
- Venice per-model constraints and prices come from Venice's public, unauthenticated model list `GET https://api.venice.ai/api/v1/models?type=image|inpaint|video` (fetched 2026-11-05), which the Venice docs name as the source of truth for per-model sizing.
- APIMart prices are not on the docs pages; the only per-tier numbers come from `https://apimart.ai/pricing` (a rendered page read through a summariser, account-tier dependent, low confidence).

---

# Part 1: Images

## 1. OpenAI Images API

Sources:
- Create image: https://developers.openai.com/api/reference/resources/images/methods/generate (= platform.openai.com/docs/api-reference/images/create)
- Create image edit: https://developers.openai.com/api/reference/resources/images/methods/edit
- Guide: https://developers.openai.com/api/docs/guides/image-generation
- Model pages: https://developers.openai.com/api/docs/models/gpt-image-2 , .../gpt-image-1.5 , .../gpt-image-2.5-flare , .../gpt-image-2.6-sunburst , .../dall-e-3 , .../dall-e-2

### Model status (as of 2026-11-05)
| Model | Status |
| - | - |
| `gpt-image-2.6-sunburst`, `gpt-image-2.6-flare` | Current (newest). Add complexity, markup edits, SVG and GIF output. |
| `gpt-image-2.5-sunburst`, `gpt-image-2.5-flare` (+ `-2026-09-08` snapshots) | Current. Recommended; edit endpoint default model is `gpt-image-2.5-sunburst`. |
| `gpt-image-2` (snapshot `gpt-image-2-2026-04-21`) | Available ("state-of-the-art" page, no deprecation shown). |
| `gpt-image-1.5` | **Deprecated** (model page). |
| `gpt-image-1-mini`, `chatgpt-image-latest` | Listed as accepted model values. |
| `gpt-image-1` | **Shut down 2026-10-23** (generate/edit reference). |
| `dall-e-3`, `dall-e-2` | **Shut down**, "deprecated and removed from the API" (model pages). |

### Size (`size`, string)
- Default: `"auto"` (generate and edit). When no size is sent, the model picks.
- Standard enum: `auto`, `1024x1024`, `1536x1024`, `1024x1536` ("supported by the GPT image models"). The generate enum also still lists the retired DALL·E sizes `256x256`, `512x512`, `1792x1024`, `1024x1792`.
- **Arbitrary `WIDTHxHEIGHT`** for `gpt-image-2`, `gpt-image-2-2026-04-21`, `gpt-image-2.5-sunburst/flare` (+ snapshots):
  - width and height multiples of **16**
  - long:short edge ratio ≤ **3:1** (ratio between 1:3 and 3:1)
  - max edge **3840** px; max resolution `3840x2160`
  - total pixels **655,360 – 8,294,400**
  - above `2560x1440` is "experimental"
- Popular sizes listed for `gpt-image-2`: `1024x1024`, `1536x1024`, `1024x1536`, `2048x2048`, `2048x1152`, `3840x2160`, `2160x3840`, `auto`.
- ⚠ GPT Image 2.6: the `size` description names only gpt-image-2 and 2.5 for arbitrary sizes; the guide says 2.6 GIF `size` is `auto` or `WIDTHxHEIGHT` multiples of 16. Whether 2.6 still images take arbitrary sizes is **not stated explicitly**. (APIMart's 2.6 page says the 2.5 size rules apply to 2.6.)
- `gpt-image-1.5`, `gpt-image-1-mini`: only `1024x1024`, `1536x1024`, `1024x1536`, `auto` (the arbitrary-size rule does not name them).
- No aspect-ratio or tier parameter; aspect ratio is implied by the pixel size, so any ratio between 1:3 and 3:1 works on gpt-image-2/2.5 (e.g. 21:9 → `2016x864`, 4:5 → `1024x1280`).

### References and image count
- Edit endpoint (`POST /images/edits`): `images` array (JSON) **1–16** items, each `{file_id}` or `{image_url}` (URL or base64 data URL, ≤ 20,971,520 chars). The guide says multipart uploads are still accepted. `mask` (applies to first image); `markup` (GPT Image 2.5/2.6, transparent PNG over the first image, ≤ 16,777,216 px, ≤ 50 MB, not with `mask`).
- `n`: **1–10** (generate and edit), default 1. SVG requires `n=1`.

### Price shape
- Token-based. GPT Image 2.5/2.6: $30 per 1M image output tokens (Batch $15 for 2.5), $8/1M image input. Output tokens depend on size and quality; the guide's calculator is the reference.
- `gpt-image-2` per-image table (1024×1024 / 1024×1536 / 1536×1024): low $0.006 / $0.005 / $0.005; medium $0.053 / $0.041 / $0.041; high $0.211 / $0.165 / $0.165. **The 3:2 sizes cost less than the square**; the guide notes "A larger non-square resolution can sometimes produce fewer output tokens".
- `gpt-image-1.5`: low $0.009 / $0.013 / $0.013; medium $0.034 / $0.05 / $0.05; high $0.133 / $0.2 / $0.2 (portrait/landscape ≈ 1.5× square).
- `gpt-image-1-mini`: low $0.005/$0.006/$0.006; medium $0.011/$0.015/$0.015; high $0.036/$0.052/$0.052.
- Partial images: +100 output tokens each. Complexity: no separate fee.
- No published price for sizes above 1536 px; it scales with tokens (not documented as a table).

### Other parameters
- `quality`: `auto` (default), `low`, `medium`, `high`; `xhigh`, `max` only on gpt-image-2.5 (and 2.6 per the guide). `standard`/`hd` are legacy DALL·E values.
- `background`: `auto` (default), `opaque`, `transparent` (transparent needs `png`/`webp`; preview on gpt-image-2).
- `output_format`: `png` (default), `jpeg`, `webp`, `gif`, `svg` (`svg` generate only; GIF/SVG need preview access). `output_compression` 0–100 (jpeg/webp), default 100.
- `moderation`: `auto` (default) / `low`. `partial_images` 0–3 with `stream`. `complexity` `low`/`medium`/`high` (2.6 default `high`). `frame_count` 2–16 (default 9) and `frame_duration_ms` ≥ 20 (default 200) for GIF. `input_fidelity` `high`/`low` on gpt-image-1.5 (1-mini `low` only; omit for gpt-image-2). `safety_identifier`. `response_format` and `style` are legacy, unsupported on GPT image models (always base64).
- No `seed`, `negative_prompt`, `steps`.

---

## 2. Google Gemini API (Interactions API)

Sources:
- Image generation guide: https://ai.google.dev/gemini-api/docs/image-generation (→ https://aistudio.google.com/docs/image-generation.md)
- Interactions create reference (`ImageResponseFormat`): https://aistudio.google.com/api-reference/interactions-api/create-interaction.md
- Model pages: https://ai.google.dev/gemini-api/docs/models/gemini-nano-banana-2.1 , .../gemini-3.1-flash-image , .../gemini-3.1-flash-lite-image , .../gemini-3-pro-image , .../gemini-2.5-flash-image
- Pricing: https://ai.google.dev/gemini-api/docs/pricing (→ https://aistudio.google.com/docs/pricing.md)

### Current image models
| Model id | Alias | Notes |
| - | - | - |
| `gemini-nano-banana-2.1` | Nano Banana 2.1 | Newest Flash workhorse; recommended for new projects. 1K/2K/4K (no 512). Thinking levels `minimal`/`medium` (default)/`high`. |
| `gemini-3.1-flash-image` | Nano Banana 2 | Previous gen; 512/1K/2K/4K. |
| `gemini-3.1-flash-lite-image` | Nano Banana 2 Lite | 1K only. "Not optimized for multiple reference inputs". |
| `gemini-3-pro-image` | Nano Banana Pro | 1K/2K/4K, thinking. |
| `gemini-2.5-flash-image` | Nano Banana | Legacy; one size per ratio. `gemini-2.5-flash-image-preview` deprecated. |
| Imagen | | Shut down. |

### Size
- Fields: `response_format: { type: "image", aspect_ratio, image_size, mime_type, delivery }`.
- `aspect_ratio` enum (API reference): `1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, 1:8, 8:1, 1:4, 4:1`. Per guide: 1:4, 4:1, 1:8, 8:1 only on Nano Banana 2.1 and 3.1 Flash Image.
- `image_size` enum: `512`, `1K`, `2K`, `4K`. Uppercase K required ("Lowercase parameters (e.g., 1k) will be rejected"). ⚠ The guide calls the small tier "512px (0.5K)" / "05.K"; the enum value is `"512"`.
- Default when nothing is sent: "the model matches the output image size to that of your input image, or otherwise generates 1:1 squares"; Gemini 3 models "generate 1K images by default".
- `mime_type` enum in the reference lists only `image/jpeg`. `delivery`: `inline` / `uri`.

### Pixel tables (guide)
**Nano Banana 2.1** (`gemini-nano-banana-2.1`), and **3.1 Flash Image** (same 1K/2K/4K, plus 512):
| Ratio | 512 (3.1 Flash only) | 1K | 2K | 4K |
| - | - | - | - | - |
| 1:1 | 512x512 | 1024x1024 | 2048x2048 | 4096x4096 |
| 1:4 | 256x1024 | 512x2048 | 1024x4096 | 2048x8192 |
| 1:8 | 192x1536 | 384x3072 | 768x6144 | 1536x12288 |
| 2:3 | 424x632 | 848x1264 | 1696x2528 | 3392x5056 |
| 3:2 | 632x424 | 1264x848 | 2528x1696 | 5056x3392 |
| 3:4 | 448x600 | 896x1200 | 1792x2400 | 3584x4800 |
| 4:1 | 1024x256 | 2048x512 | 4096x1024 | 8192x2048 |
| 4:3 | 600x448 | 1200x896 | 2400x1792 | 4800x3584 |
| 4:5 | 464x576 | 928x1152 | 1856x2304 | 3712x4608 |
| 5:4 | 576x464 | 1152x928 | 2304x1856 | 4608x3712 |
| 8:1 | 1536x192 | 3072x384 | 6144x768 | 12288x1536 |
| 9:16 | 384x688 | 768x1376 | 1536x2752 | 3072x5504 |
| 16:9 | 688x384 | 1376x768 | 2752x1536 | 5504x3072 |
| 21:9 | 792x168 ⚠ | 1584x672 | 3168x1344 | 6336x2688 |

⚠ 21:9 at 512 is printed as `792x168`, which is not 21:9 (half of 1584x672 would be 792x336). Likely a doc typo.

**Gemini 3 Pro Image**: same 1K/2K/4K pixels as above for 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9 (no 1:4/4:1/1:8/8:1, no 512).

**Gemini 2.5 Flash Image** (single size): 1:1 1024x1024; 2:3 832x1248; 3:2 1248x832; 3:4 864x1184; 4:3 1184x864; 4:5 896x1152; 5:4 1152x896; 9:16 768x1344; 16:9 1344x768; 21:9 1536x672.

**3.1 Flash Lite Image**: no table in the guide. Model page: `image_size` "`1024px` (1K)", "2K and 4K are unsupported"; aspect ratios listed `1:1, 3:2, 2:3, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9`. ⚠ The same page also says "a discrete set of 14 aspect ratios" but lists only 10.

### References and image count
- Guide: "Up to 14 reference images". Nano Banana 2.1 & 3.1 Flash: up to 10 object images + up to 4 character images. 3 Pro: up to 6 objects + 5 characters + 3 style references. Limitations: `gemini-2.5-flash-image` "works best with up to 3 images as input"; 3 Pro "supports 5 images with high fidelity, and up to 14 images in total".
- Nano Banana 2.1, 3.1 Flash, 3.1 Flash Lite also accept video and PDF input.
- Images per request: **no count parameter** documented; "The model won't always follow the exact number of image outputs that the user explicitly asks for."

### Price shape (pricing page, Standard tier)
| Model | 0.5K | 1K | 2K | 4K |
| - | - | - | - | - |
| Nano Banana 2.1 ($30/1M image tokens) | n/a | $0.0336 (1120 tok) | $0.0504 (1680 tok) | $0.113 (3780 tok) ⚠ |
| 3.1 Flash Image ($60/1M) | $0.045 (747 tok) | $0.067 (1120) | $0.101 (1680) | $0.151 (2520) |
| 3.1 Flash Lite Image ($30/1M) | n/a | $0.0336 (1120) | n/a | n/a |
| 3 Pro Image ($120/1M) | n/a | **$0.134** | **$0.134 (same as 1K)** | $0.24 |
| 2.5 Flash Image | | $0.039 per image (Batch $0.0195) | | |
- Batch is half (Nano Banana 2.1 $15/1M: $0.0168 / $0.0252 / $0.0567).
- **2K costs the same as 1K on Gemini 3 Pro Image** (both 1120 tokens).
- ⚠ Nano Banana 2.1 4K tokens: the image-generation guide table says **2520** tokens; the pricing page says **3780** tokens / $0.113 (3780 × $30/1M = $0.113). They disagree.
- Aspect ratio does not change token count (guide tables: same token count for every ratio within a tier).

### Other parameters
- Thinking (3 Pro, 3.1 Flash; Nano Banana 2.1 has `minimal`/`medium`/`high` levels). Interim "thought images" are not charged.
- Google Search grounding (web; Nano Banana 2.1 and 3.1 Flash also Image Search).
- No `seed`, `negative_prompt`, `steps`, `quality`, `background` for images (not documented).

---

## 3. Venice

Sources:
- Generate: https://docs.venice.ai/api-reference/endpoint/image/generate
- Edit: https://docs.venice.ai/api-reference/endpoint/image/edit
- Multi-edit: https://docs.venice.ai/api-reference/endpoint/image/multi-edit
- Image models page: https://docs.venice.ai/models/image
- Model pages, e.g. https://docs.venice.ai/models/gpt-image-2 , https://docs.venice.ai/models/nano-banana-pro
- Model list API (public): https://api.venice.ai/api/v1/models?type=image and ?type=inpaint

### `/image/generate` sizing (three styles; docs "Sizing Options")
1. **Pixel models**: `width`, `height` ints, each `0 < x ≤ 1280`, default **1024** each; must be divisible by the model's `widthHeightDivisor` (16 or 8). Today these are `venice-sd35` (÷16), `wai-Illustrious` (÷16), `lustify-sdxl`, `lustify-v7`, `lustify-v8`, `z-image-turbo`, `chroma` (÷8).
2. **Aspect-ratio models**: `aspect_ratio` string; per-model list in `constraints.aspectRatios`, default `constraints.defaultAspectRatio` (always `1:1`, or `auto` for flux-2-max). The Qwen Image family "**rejects** `width` and `height` with a `400`".
3. **Resolution-tier models**: `aspect_ratio` + `resolution` (`1K`/`2K`/`4K`, per model `constraints.resolutions`, default `constraints.defaultResolution` = `1K`).
- Venice publishes **no pixel dimensions** for ratio/tier models.
- `variants`: **1–4** images per request (only when `return_binary` is false).
- References on generate: only `style_references` (models with `supportsStyleReferences`, `maxStyleReferences` = 3 for krea-v2-*, luma-uni-1*). Other generate models take no reference image.
- Other: `quality` `low`/`medium`/`high` (only models listing `qualities`; default `high` for gpt-image-2), `format` `jpeg`/`png`/`webp` (default `webp`), `transparent_background` (models with `supportsTransparentBackground`, png/webp), `negative_prompt`, `cfg_scale` (0–20), `seed` (±999,999,999), `steps` (per model `constraints.steps`, e.g. sd35 default 25 max 30), `style_preset`, `lora_strength`, `safe_mode` (default true), `hide_watermark`, `embed_exif_metadata`, `enable_web_search`, `enhance_prompt`, `disable_prompt_optimization_thinking`, `return_binary`.

### Generate models (from `GET /models?type=image`, 2026-11-05)
| Model | Sizing | Aspect ratios | Resolutions | Qualities | Price (USD) |
| - | - | - | - | - | - |
| `venice-sd35` | width/height (÷16, ≤1280) |  |   |  | $0.01 |
| `grok-imagine-image-2-0` | aspect_ratio + resolution | 1:1, 16:9, 9:16, 3:4, 3:2, 2:3 | 1K, 2K (def 1K) | low/medium | 1K $0.07, 2K $0.1 |
| `krea-2-turbo` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K (def 1K) |  | 1K $0.04, 2K $0.06 |
| `flux-2-pro` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.03 |
| `flux-2-max` | aspect_ratio | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.09 |
| `flux-3-image` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K (def 1K) |  | 1K $0.12, 2K $0.29, 4K $0.98 |
| `gpt-image-2-5-flare` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K (def 1K) | low/medium/high | 1K $0.07, 2K $0.15, 4K $0.23 |
| `gpt-image-2-5-sunburst` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K (def 1K) | low/medium/high | 1K $0.07, 2K $0.15, 4K $0.23 |
| `gpt-image-2` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K (def 1K) | low/medium/high | 1K $0.27, 2K $0.51, 4K $0.84 |
| `gpt-image-1-5` | aspect_ratio | 1:1, 3:2, 2:3 |   |  | $0.26 |
| `hunyuan-image-v3` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.09 |
| `ideogram-v4` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.06 |
| `ideogram-v4-5` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K (def 1K) | low/medium/high | 1K $0.26, 2K $0.26 |
| `krea-v2-large` | aspect_ratio | 1:1, 3:2, 16:9, 2:3, 9:16 |   |  | $0.07 |
| `krea-v2-medium` | aspect_ratio | 1:1, 3:2, 16:9, 2:3, 9:16 |   |  | $0.04 |
| `luma-uni-1` | aspect_ratio | 1:1, 3:2, 16:9, 9:16, 2:3 |   |  | $0.05 |
| `luma-uni-1-max` | aspect_ratio | 1:1, 3:2, 16:9, 9:16, 2:3 |   |  | $0.12 |
| `muse-image` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4 |   |  | $0.02 |
| `nano-banana-2` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K (def 1K) |  | 1K $0.1, 2K $0.14, 4K $0.19 |
| `nano-banana-2-1` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K (def 1K) |  | 1K $0.1, 2K $0.14, 4K $0.19 |
| `nano-banana-pro` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K (def 1K) |  | 1K $0.18, 2K $0.23, 4K $0.35 |
| `nano-banana-2-lite` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.06 |
| `recraft-v4` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.05 |
| `recraft-v4-pro` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.29 |
| `seedream-v4` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.05 |
| `seedream-v5-lite` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5, 4:3 |   |  | $0.05 |
| `seedream-v5-pro` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 9:16, 2:3, 3:4, 4:3 | 1K, 2K (def 1K) |  | 1K $0.06, 2K $0.11 |
| `qwen-image-2` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.05 |
| `qwen-image-2-pro` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.1 |
| `wan-2-7-text-to-image` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.0375 |
| `wan-2-7-pro-text-to-image` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.09375 |
| `grok-imagine-image` | aspect_ratio + resolution | 1:1, 16:9, 9:16, 3:4, 3:2, 2:3 | 1K, 2K (def 1K) |  | 1K $0.03, 2K $0.04 |
| `lustify-sdxl` | width/height (÷8, ≤1280) |  |   |  | $0.01 |
| `lustify-v7` | width/height (÷8, ≤1280) |  |   |  | $0.01 |
| `lustify-v8` | width/height (÷8, ≤1280) |  |   |  | $0.01 |
| `qwen-image` | aspect_ratio | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |   |  | $0.03 |
| `wai-Illustrious` | width/height (÷16, ≤1280) |  |   |  | $0.01 |
| `z-image-turbo` | width/height (÷8, ≤1280) |  |   |  | $0.01 |
| `chroma` | width/height (÷8, ≤1280) |  |   |  | $0.01 |
| `qwen-image-3` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K (def 1K) |  | 1K $0.04, 2K $0.04 |
| `qwen-image-3-pro` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K (def 1K) |  | 1K $0.05, 2K $0.09 |
| `qwen-image-2-1-turbo` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K (def 1K) |  | 1K $0.02, 2K $0.02 |
| `qwen-image-2-1-pro` | aspect_ratio + resolution | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K (def 1K) |  | 1K $0.05, 2K $0.05 |

Notes:
- `4:3` is missing from almost every Venice generate model (only `seedream-v5-lite`, `seedream-v5-pro`); `4:5` and `21:9` are common; `grok-imagine-*` lack `4:3` and `21:9`.
- **2K costs the same as 1K** on: `ideogram-v4-5` ($0.26), `qwen-image-2-1-pro` ($0.05), `qwen-image-2-1-turbo` ($0.02), `qwen-image-3` ($0.04). Per-quality tables (docs models page): gpt-image-2 low 1K/2K/4K $0.02/$0.03/$0.05, medium $0.07/$0.13/$0.21, high $0.26/$0.50/$0.83; gpt-image-2.5 flare/sunburst low $0.03/$0.04/$0.05, medium $0.04/$0.05/$0.07, high $0.07/$0.15/$0.23; ideogram-v4-5 low/medium/high $0.04/$0.07/$0.26 at both 1K and 2K.
- ⚠ The docs table's gpt-image-2 headline prices ($0.27/$0.51/$0.84) differ by $0.01 from the per-quality "high" row ($0.26/$0.50/$0.83). Both appear in the model list (`pricing.resolutions` vs `pricing.quality`).
- When no size field is sent: pixel models 1024×1024; ratio models `defaultAspectRatio`; tier models `defaultResolution` 1K.

### Edit endpoints
- `/image/edit` (single image, "experimental"): `image` (file, base64 or URL; 65,536 – 33,177,600 px; < 25 MB), `aspect_ratio` enum `auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:3, 4:5` (per-model subset), `resolution` (default "1K"), `output_format` jpeg/png/webp (default: PNG at 1K, JPEG at 2K/4K, PNG if transparent). **No `quality`** (sending one returns 400; billed at the model default tier). Default model `firered-image-edit`.
- `/image/multi-edit`: `images` 1..`maxInputImages` (first is the base), same `aspect_ratio` enum, `resolution`, `quality`, `output_format`, `transparent_background`. "When the field is absent, the cap is 3, or 1 when `combineImages` is `false`."
- ⚠ The multi-edit docs point at `capabilities.maxInputImages`; the live model list puts it in `constraints.maxInputImages` (capabilities is empty).

| Edit model | Aspect ratios | Resolutions | Max input images | Qualities | Price (USD) |
| - | - | - | - | - | - |
| `firered-image-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |  | 3 (field absent → default) |  | $0.04 |
| `qwen-edit-uncensored` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |  | 3 (field absent → default) |  | $0.04 |
| `grok-imagine-edit` | auto, 1:1, 16:9, 9:16, 3:4, 3:2, 2:3 | 1K, 2K | 3 (field absent → default) |  | 1K $0.03, 2K $0.04 |
| `grok-imagine-image-2-0-edit` | auto, 1:1, 16:9, 9:16, 3:4, 3:2, 2:3 | 1K, 2K | 3 (field absent → default) | low/medium | 1K $0.07, 2K $0.1 |
| `qwen-image-2-edit` | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |  | 3 (field absent → default) |  | $0.05 |
| `qwen-image-2-pro-edit` | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |  | 3 (field absent → default) |  | $0.1 |
| `wan-2-7-pro-edit` | auto | 1K, 2K | 6 |  | $0.094 |
| `flux-2-max-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |  | 6 |  | $0.12 |
| `flux-3-image-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K | 6 |  | 1K $0.12, 2K $0.29, 4K $0.98 |
| `gpt-image-2-5-flare-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K | 6 | low/medium/high | 1K $0.08, 2K $0.15, 4K $0.24 |
| `gpt-image-2-5-sunburst-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K | 6 | low/medium/high | 1K $0.08, 2K $0.15, 4K $0.24 |
| `gpt-image-2-edit` | 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K | 6 | low/medium/high | 1K $0.34, 2K $0.52, 4K $0.84 |
| `gpt-image-1-5-edit` | auto, 1:1, 3:2, 2:3 |  | 6 |  | $0.31 |
| `ideogram-v4-5-edit` | auto, 1:1, 3:2, 16:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K | 5 | low/medium/high | 1K $0.26, 2K $0.26 |
| `nano-banana-2-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K | 6 |  | 1K $0.1, 2K $0.14, 4K $0.19 |
| `nano-banana-2-1-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K | 6 |  | 1K $0.1, 2K $0.14, 4K $0.19 |
| `nano-banana-pro-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K, 4K | 6 |  | 1K $0.18, 2K $0.23, 4K $0.35 |
| `nano-banana-2-lite-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 |  | 6 |  | $0.06 |
| `luma-uni-1-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:3, 4:5 |  | 1 (combineImages false) |  | $0.06 |
| `luma-uni-1-max-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:3, 4:5 |  | 1 (combineImages false) |  | $0.13 |
| `muse-image-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4 |  | 6 |  | $0.02 |
| `seedream-v5-lite-edit` | auto, 1:1, 3:2, 16:9, 9:16, 2:3, 3:4, 4:5, 4:3 |  | 6 |  | $0.05 |
| `seedream-v5-pro-edit` | auto, 1:1, 3:2, 16:9, 9:16, 2:3, 3:4, 4:3 | 1K, 2K | 6 |  | 1K $0.06, 2K $0.11 |
| `seedream-v4-edit` | auto, 1:1, 3:2, 16:9, 9:16, 2:3, 3:4, 4:5 |  | 6 |  | $0.05 |
| `qwen-image-3-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K | 3 (field absent → default) |  | 1K $0.04, 2K $0.04 |
| `qwen-image-3-pro-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K | 3 (field absent → default) |  | 1K $0.05, 2K $0.09 |
| `qwen-image-2-1-turbo-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K | 6 |  | 1K $0.02, 2K $0.02 |
| `qwen-image-2-1-pro-edit` | auto, 1:1, 3:2, 16:9, 21:9, 9:16, 2:3, 3:4, 4:5 | 1K, 2K | 10 |  | 1K $0.05, 2K $0.05 |

---

## 4. APIMart

Sources (all `https://docs.apimart.ai/en/api-reference/images/<page>`):
`gpt-image-1/generation`, `gpt-image-2/generation`, `gpt-image-2/official`, `gpt-image-2.5/generation`, `gpt-image-2.5-ext/generation`, `gpt-image-2.6/generation`, `gpt-image-2.6-ext/generation`, `gemini-nano-banana-2.1/generation`, `gemini-3.1-flash/generation`, `gemini-3.1-flash/generation-lite`, `gemini-3-pro/generation`, `gemini-2.5-flash/generation`, `seedream-4/generation`, `seedream-4.5/generation`, `seedream-5-lite/generation`, `seedream-5-0-pro/generation`, `seedream-5-0-flash/generation`, `flux-kontext/generation`, `flux-2/generation`, `flux-3-image/generation`. Index: https://docs.apimart.ai/_llms/en/api-manual.txt . Prices: https://apimart.ai/pricing (⚠ low confidence, see top).

All are `POST /v1/images/generations` (async task). Common: `size` is an **aspect ratio** (some accept pixels too), `resolution` is a tier, `image_urls` holds references, `n` is images per task, `nsfw_check` (default false).

APIMart also lists, not researched in detail: Imagen 4.0 apimart, Hy-Image-3.5 Preview, Muse Image Ext, MAI-Image-2.6, Qwen Image 2.0 / 3.0, Z-Image-Turbo, Grok Imagine (+2.0 Ext), wan2.7 image, Midjourney, FLUX 3 Klein.

### GPT Image family
| Model ids | `size` | `resolution` | Refs (`image_urls`) | `n` | Notes |
| - | - | - | - | - | - |
| `gpt-image-1-official`, `gpt-image-1.5-official` | `1:1` (default), `3:2`, `2:3` → 1024x1024, 1536x1024, 1024x1536 | none | up to **15**; "Must be publicly accessible, stable image URLs" | 1–4 (≤0→1, >4→4) | quality, background, moderation, output_format png/jpeg, output_compression, mask_url. ⚠ Only `-official` ids listed; OpenAI shut gpt-image-1 down 2026-10-23. |
| `gpt-image-2` (alias `gpt-image-2-ext`) | 15 ratios + `auto` (=1:1) or pixels: `1:1, 3:2, 2:3, 4:3, 3:4, 5:4, 4:5, 16:9, 9:16, 2:1, 1:2, 3:1, 1:3, 21:9, 9:21`; default `1:1` | `1k` (default) / `2k` / `4k` | up to **15**, URL or base64 data URI, ≤20 MB each, 256 MB total | **1** only | Without `size`, output = input image resolution. `official_fallback`. |
| `gpt-image-2-official` | same 15 ratios / pixels; default `1:1` | `1k`/`2k`/`4k` (default 1k) | up to **16**, public URLs | 1–4 | quality (auto ≈ low), moderation, output_format png/jpeg/webp, output_compression, mask_url. |
| `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` | same 15 ratios, exact pixels, or `auto` (default `auto`) | `1k` (default) / `2k` / `4k`, ignored for exact pixels | up to **16**, "Only publicly accessible HTTP(S) URLs" (upload local files first) | 1–4 | quality low…max/auto, background, moderation (APIMart default `low`), mask_url. Exact-pixel rules = OpenAI's (÷16, ≤3840, ≤3:1, 655,360–8,294,400 px). |
| `gpt-image-2.6-flare`, `gpt-image-2.6-sunburst` | as 2.5 | as 2.5 (lowercase) | up to 16, public URLs | 1–4 | + complexity, markup_url, GIF (`frame_count` 2–16, auto size 512x512), SVG, safety_identifier. |
| `gpt-image-2.5-ext` (+ `version` flare/sunburst) | 10 ratios + `auto`: `1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9` | `1K` (default) / `2K` / `4K` | up to 16, URL or data URL | 1–4 | Billed by version × resolution × images delivered. |
| `gpt-image-2.6-ext` (+ `version`) | same 10 ratios + `auto`; **no pixels** (400) | **only `1k`** today (2k/4k → 403 `model_price_not_configured`) | up to 16, URL or data URL | **1** (2–4 fail later, refunded) | Per-image price; quality/format/complexity do not change price. |

GPT Image `size × resolution` pixels (APIMart tables; 2.5/2.6/official agree):
| size | 1k | 2k | 4k |
| - | - | - | - |
| 1:1 | 1024×1024 | 2048×2048 | 2880×2880 |
| 3:2 | 1536×1024 | 2048×1360 | 3520×2336 |
| 2:3 | 1024×1536 | 1360×2048 | 2336×3520 |
| 4:3 | 1024×768 | 2048×1536 | 3312×2480 |
| 3:4 | 768×1024 | 1536×2048 | 2480×3312 |
| 5:4 | 1280×1024 | 2560×2048 | 3216×2576 |
| 4:5 | 1024×1280 | 2048×2560 | 2576×3216 |
| 16:9 | 1536×864 | 2048×1152 | 3840×2160 |
| 9:16 | 864×1536 | 1152×2048 | 2160×3840 |
| 2:1 | 2048×1024 | 2688×1344 | 3840×1920 |
| 1:2 | 1024×2048 | 1344×2688 | 1920×3840 |
| 3:1 | 1536×512 | 3072×1024 | 3840×1280 |
| 1:3 | 512×1536 | 1024×3072 | 1280×3840 |
| 21:9 | 2016×864 | 2688×1152 | 3840×1648 |
| 9:21 | 864×2016 | 1152×2688 | 1648×3840 |

⚠ The `gpt-image-2` (non-official) page gives two values for many 1k cells, e.g. 1:1 "1024×1024 / 1254×1254", 16:9 "1536×864 / 1672×941", 3:1 "1881×836 / 1536×512". The official page has the same ambiguity only for 3:1 and 1:3. Exact 1k output for `gpt-image-2` is uncertain.

GPT Image prices: 2.5 is token-billed ($30/1M image output; 1024×1024 output tokens low 196, medium 439, high 1756, xhigh 3122, max 7024 → $0.0059 … $0.211). ⚠ From the pricing page (low confidence, "Gold" tier): `gpt-image-2` per image 1K ~$0.0085, 2K ~$0.015, 4K ~$0.022; `gpt-image-2.5-ext` 1K ~$0.0085, 2K ~$0.03, 4K ~$0.04.

### Gemini / Nano Banana family
| Model ids | `size` (ratios) | `resolution` | Refs | `n` | Notes |
| - | - | - | - | - | - |
| `gemini-nano-banana-2.1`, `gemini-nano-banana-2.1-ext` | `1:4, 4:1, 1:8, 8:1, 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9`; `auto`/omitted = model decides (I2I follows reference) | `1K` (default) / `2K` / `4K`; `0.5K`/`512` → 400; unknown (e.g. 3K) → 1K | "no fixed reference image count limit"; URL or data URL; ≤20 MB each (Ext 50 MB total) | official 1–4; Ext 1 only | Official token-billed; Ext per tier × images. Pixel table = Google's 1K/2K/4K (rows for 1:4…8:1 not printed). |
| `gemini-3.1-flash-image-preview` (alias `nano-banana-2-ext`), `-official` (alias `nano-banana-2`) | `auto`, `1:1, 3:2, 2:3, 4:3, 3:4, 16:9, 9:16, 5:4, 4:5, 21:9, 1:4, 4:1, 1:8, 8:1` | `0.5K`, `1K` (default), `2K`, `4K` ("4K costs more than 1K") | max **14** (≤10 MB each) | **1** | `google_search`, `google_image_search`. ⚠ `0.5K` here vs Google's enum `512`. |
| `gemini-3.1-flash-lite-image` (alias `nano-banana-2-lite`), `-ext` | `auto`, 10 ratios (no 1:4/4:1/1:8/8:1) | 1K only; 2K/4K/0.5K **silently downgraded** to 1K | max **14** | 1–4 (parallel upstream calls) | Token-billed, ~$0.0336 per 1K image. |
| `gemini-3-pro-image-preview` (alias `nano-banana-pro-ext`), `-official` (alias `nano-banana-pro`) | `auto`, `1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9` | `1K` (default) / `2K` / `4K` | max **14** (≤30 MB each) | **1** | `auto` T2I default "1:1 or 16:9". |
| `gemini-2.5-flash-image-preview` (alias `nano-banana-ext`), `-official` (alias `nano-banana`) | `auto` + same 10 ratios | `1K` only | max **14** (≤10 MB) | **1** | Prompt ≤ 1000 chars. ⚠ 14 refs here vs Google's "works best with up to 3". |

⚠ Prices (pricing page, low confidence): `gemini-nano-banana-2.1-ext` 1K ~$0.012, 2K ~$0.014, 4K ~$0.018 ("Default" listed as ~$0.02, oddly above 1K).

### Seedream family (ByteDance, via APIMart)
| Model | `size` ratios | `resolution` | Pixels | Refs | `n` |
| - | - | - | - | - | - |
| `seedream-4.0` | `1:1` (default), `4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 2:1, 1:2, 21:9, 9:21`, `auto` (needs refs) | `1K`, `2K` (default), `4K` | 1K: 1024², 1152x864, 864x1152, 1280x720, 720x1280, 1248x832, 832x1248, 1440x720, 720x1440, 1512x648, 648x1512 | refs + n ≤ 15; jpeg/png, ratio 1/3–3, ≤10 MB, ≤6000×6000 | 1–15 |
| `seedream-4.5` | same as 4.0 | `2K` (default), `4K`; **no 1K** | 2K: 2048², 2304x1728, 1728x2304, 2560x1440, 1440x2560, 2496x1664, 1664x2496, 2880x1440, 1440x2880, 3024x1296, 1296x3024. 4K: 4096², 4694x3520, 3520x4694, 5404x3040, 3040x5404, 4992x3328, 3328x4992, 5760x2880, 2880x5760, 6198x2656, 2656x6198 | refs + n ≤ 15 | 1–15 (n>1 switches to sequential mode; "Pure text-to-image … cannot generate multiple images") |
| `seedream-5-0-lite` | as 4.0 but **no 9:21** | `2K` (default), `3K`, `4K`; no 1K | 2K: 2048², 2304x1728, 1728x2304, 2848x1600, 1600x2848, 2496x1664, 1664x2496, 2880x1440, 1440x2880, 3136x1344. 3K: 3072², 3456x2592, 2592x3456, 4096x2304, 2304x4096, 3744x2496, 2496x3744, 4320x2160, 2160x4320, 4704x2016. 4K: 4096², 4704x3520, 3520x4704, 5504x3040, 3040x5504, 4992x3328, 3328x4992, 5760x2880, 2880x5760, 6240x2656 | refs + n ≤ 15 | 1–15 |
| `seedream-5-0-pro`, `seedream-5-0-flash` | `1:1, 4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 2:1, 1:2, 21:9`, `auto` (default); or exact pixels (921,600–4,624,220 px, ratio 1/16–16) | `1K` (default), `1.5K`, `2K`; 3K/4K → 400 | 1K: 1024², 1152x864, 864x1152, 1312x736, 736x1312, 1248x832, 832x1248, 1440x720, 720x1440, 1568x672. 1.5K: 1536², 1792x1344, 1344x1792, 2048x1152, 1152x2048, 1872x1248, 1248x1872, 2176x1088, 1088x2176, 2352x1008. 2K: as Seedream 4.5 2K | up to **10**; first free, each extra a fixed surcharge | **1** only |

- ⚠ Seedream 5.0 Lite page header says "Supports 2K / 3K resolution" while the field lists 2K/3K/4K.
- ⚠ Seedream 5.0 Flash page says "Also accepted: `seedream-5.0-pro`" (probably a copy error for `seedream-5.0-flash`).
- **1.5K costs the same as 1K** on Seedream 5.0 Pro/Flash ("same price as 1K, better quality").
- Seedream 5.0 Pro/Flash extras: `background` opaque/transparent, `layer_decomposition`, `watermark`, `output_format` jpeg/png, `optimize_prompt_options`. Seedream 4.x: `optimize_prompt_options`, `sequential_image_generation`.
- ⚠ Prices (pricing page, low confidence): seedream-5-0-pro 1K ~$0.029, 2K ~$0.059; seedream-4.5 single price ~$0.026.

### FLUX family (via APIMart)
| Model | Size control | Ratios | Refs | `n` | Other |
| - | - | - | - | - | - |
| `flux-2-flex`, `flux-2-pro`, `flux-2-max` | `resolution` `1MP` / `2MP` (default) / `3MP` / `4MP` (aliases 1K→2MP, 2K→3MP, 4K→4MP) + `size` ratio, or `size` pixels, or `width`+`height` (≥64 each, ≤4,194,304 px; output+refs ≤ 9 MP) | `1:1` (default), `4:3, 3:4, 16:9, 9:16, 3:2, 2:3, 21:9, 9:21`, `auto` | up to **8** | 1 | seed, prompt_upsampling (default false), safety_tolerance 0–5, steps 1–50 and guidance 1.5–10 (flex only), output_format jpeg/png/webp |
| `flux-kontext-pro`, `flux-kontext-max` | `size` ratio only (~1 MP); pixels mapped to nearest ratio; width/height fail | same 9 + `auto` | up to **4** | 1 | 1:1 1024², 4:3 1184x880, 3:4 880x1184, 16:9 1392x752, 9:16 752x1392, 3:2 1248x832, 2:3 832x1248, 21:9 1568x672, 9:21 672x1568 |
| `flux-3-image` | `aspect_ratio` (or `size`) ratio; `resolution` `768sq`, `1k` (default), `1.5k`, `2k`, `4k`; pixels → 400 | `21:9, 2:1, 16:9, 3:2, 7:5, 4:3, 5:4, 1:1, 4:5, 3:4, 5:7, 2:3, 9:16, 1:2, 9:21`, `auto` | up to **10** | 1 | grounding, safety_tolerance 0–4; seed/steps/guidance/negative_prompt → 400. Tiers ≈ 0.6/1/2/4/16 MP. |

FLUX.2 tier pixels (APIMart): 1MP/2MP/3MP/4MP — 1:1 1024²/1440²/1536²/2048²; 4:3 1152x864/1664x1248/1824x1360/2336x1760; 16:9 1344x752/1920x1072/2048x1152/2720x1536; 3:2 1248x832/1728x1152/1872x1248/2496x1664; 21:9 1504x640/2176x928/2304x992/3072x1312 (portrait = transposed).

⚠ Prices (pricing page, low confidence): flux-2-pro 1/2/3/4 MP ~$0.024/$0.036/$0.048/$0.06; flux-3-image 768sq ~$0.033, 1K ~$0.038, 1.5K ~$0.056, 2K ~$0.08, 4K ~$0.49.

---

## 5. Together AI

Sources:
- Image parameters: https://docs.together.ai/docs/inference/images/parameters
- Reference images: https://docs.together.ai/docs/inference/images/reference-images
- Image overview: https://docs.together.ai/docs/inference/images/overview
- FLUX quickstart: https://docs.together.ai/docs/quickstart-flux
- Serverless catalog (models + prices): https://docs.together.ai/docs/serverless/models
- Billing: https://docs.together.ai/docs/serverless/overview#how-image-models-bill
- OpenAPI: https://docs.together.ai/openapi.yaml (`/v1/images/generations`)
- Vendor: BFL FLUX.2 https://docs.bfl.ml/flux_2/flux2_overview , https://docs.bfl.ml/flux_2/flux2_image_editing

### Request (OpenAPI `/v1/images/generations`)
`prompt`, `model`, `width` (default **1024**), `height` (default **1024**), `n` (default 1; docs: range 1–4), `steps` (default 20), `seed`, `negative_prompt`, `guidance_scale` (default 3.5), `response_format` `base64`/`url` (default url), `output_format` `jpeg` (default)/`png`, `image_url` (single image), `reference_images` (string[] URLs), `image_loras` (no longer available), `disable_safety_checker`.
- Sizes: "Both values should be multiples of `8`"; "Available combinations differ by model". No tier or megapixel parameter. Max size per model **not documented** except FLUX.2 (below).
- ⚠ `aspect_ratio` is documented for FLUX.1 Kontext (and the docs also say FLUX Schnell) but is **absent from the OpenAPI schema**. The parameters page contradicts itself: the note says "FLUX Schnell … use `aspect_ratio`", the compatibility table marks FLUX.1 Schnell `width/height ✓`, `aspect_ratio —`.

### Per model
| Model id | Size | Refs | Notes |
| - | - | - | - |
| `black-forest-labs/FLUX.2-pro`, `-flex`, `-dev` | `width`/`height` **256–1920**, default 1024 × **768** (quickstart) ⚠ vs API default 1024×1024 | `reference_images` (array); pro/flex also `image_url`; **count not documented by Together** (BFL: "multi-reference support for up to 10 images", up to 4 MP output) | `prompt_upsampling` (default true), `steps`/`guidance` on dev & flex. Quickstart says [pro] "Up to 9 MP output" ⚠ (BFL says up to 4 MP). |
| `black-forest-labs/FLUX.2-max` | width/height (assumed same) | refs not documented on Together | megapixel-billed $0.07/MP at 50 steps |
| `black-forest-labs/FLUX.1-kontext-pro`, `-max` | `aspect_ratio` ("1:1", "16:9", "9:16", "4:3", "3:2" given as examples) or `width`/`height` | `image_url` (1) | steps default 28 |
| `black-forest-labs/FLUX.1.1-pro` | width/height | none | |
| `google/gemini-3-pro-image` | width/height; Together lists supported sizes (below) | `reference_images` only; count **not documented by Together** | |
| `google/flash-image-2.5` | not documented | `reference_images` only; count not documented | |
| `google/flash-image-3.1` | **not documented** (only "$0.04657 at 512×512" in the catalog) | **not documented** (the reference-images page names only Gemini 3 Pro Image and Flash Image 2.5) | |
| `google/flash-image-3.1-lite` | not documented | not documented | new in catalog |
| `openai/gpt-image-2`, `openai/gpt-image-1.5`, `ideogram/*`, `Qwen/Qwen-Image*`, `ByteDance-Seed/Seedream-3.0/4.0`, `ByteDance/Seedream-5.0-lite`, `Wan-AI/Wan2.6-image`, `stabilityai/stable-diffusion-xl-base-1.0`, `Rundiffusion/*`, `prunaai/p-image-ideogram` | not documented per model | not documented | listed in the catalog only |

Together's Gemini 3 Pro Image sizes (catalog): 1K: 1024×1024 (1:1), 1264×848 (3:2), 848×1264 (2:3), 1200×896 (4:3), 896×1200 (3:4), 928×1152 (4:5), 1152×928 (5:4), 768×1376 (9:16), 1376×768 (16:9), "1548×672 or 1584×672" (21:9). 2K: 2048², 2528×1696, 1696×2528, 2400×1792, 1792×2400, 1856×2304, 2304×1856, 1536×2752, 2752×1536, 3168×1344. 4K: 4096², "5096×3392 or 5056×3392", "3392×5096 or 3392×5056", 4800×3584, 3584×4800, 3712×4608, 4608×3712, 3072×5504, 5504×3072, 6336×2688. ⚠ the "or" pairs are Together's own ambiguity; Google says 1584×672 and 5056×3392.

### Price shape
- `megapixel` models (FLUX.1 Kontext max $0.08/MP, Kontext pro $0.04/MP, FLUX1.1 pro $0.04/MP, FLUX.2 max $0.07/MP at 50 steps): Cost = MP × price × (steps ÷ default steps), steps only above default. Doubling pixels doubles cost.
- `image` models: provider pass-through, catalog gives an estimate: FLUX.2 dev $0.0154+, flex/pro $0.03+; Seedream 3.0 $0.018+, 4.0 $0.03+, 5.0 Lite $0.035+; Flash Image 2.5 $0.039+; **Gemini 3 Pro Image $0.134 at 1K or 2K (same), ~$0.24 at 4K**; Flash Image 3.1 $0.04657 at 512×512; Flash Image 3.1 Lite $0.069+; GPT Image 1.5 $0.034+, GPT Image 2 $0.053+; Qwen Image $0.0058+, 2.0 $0.035+, 2.0 Pro $0.075+; SDXL $0.0019+; Wan 2.6 Image $0.03+.

---

# Part 2: Video

Only the Together adapter does video in litevision today.

## 6. OpenAI (Sora)
Source: https://developers.openai.com/api/reference/resources/videos/methods/create
- "The Sora 2 models and Videos API were **shut down on September 24, 2026** and are no longer available. No one-to-one replacement API is available."
- Historical: `model` `sora-2` (default) / `sora-2-pro`; `seconds` `4` (default) / `8` / `12`; `size` `720x1280` (default), `1280x720`, `1024x1792`, `1792x1024`; one `input_reference` image.

## 7. Google Gemini API: Gemini Omni Flash (Veo is shut down here)
Sources: https://aistudio.google.com/docs/video.md , https://aistudio.google.com/docs/omni.md , https://aistudio.google.com/docs/models/gemini-omni-flash.md , Interactions `VideoResponseFormat` in https://aistudio.google.com/api-reference/interactions-api/create-interaction.md , pricing https://aistudio.google.com/docs/pricing.md
- **Veo 3.1 Preview** (`veo-3.1-generate-preview`, `-fast-`, `-lite-`) in the Gemini API was **shut down 2026-10-22**; GA Veo only via Gemini Enterprise Agent Platform (Vertex), not researched.
- Model: `gemini-omni-1.2-flash` (stable; `gemini-omni-1.1-flash` routes to 1.2 on 2026-12-03; `gemini-omni-flash-preview` shut down). Interactions API.
- `response_format: { type: "video", aspect_ratio, resolution, duration, delivery }`.
  - `aspect_ratio`: `16:9` (default) / `9:16`.
  - `resolution`: `360p`, `720p` (default), `1080p` (upscaled), `4k` (upscaled). 24 FPS.
  - `duration`: whole seconds **3–15** as a string like `"15s"`; default **10 s**. First+last frame interpolation and per-turn extension: 3–10 s (extension up to 30 s total, 10 s lookback).
- References: up to **6** reference images (up to 3 per character, 2 characters). Reference videos: up to 3 for 3–10 s outputs, 1 (≤3 s) for 11–15 s outputs. First/last frame supported. Video editing of uploads ≤15 s.
- Price (1.2): $12 per 1M video output tokens. 5,792 tokens/s at 720p ≈ **$0.07/s**; 360p 1,931 tok/s ≈ $0.023/s; 1080p 8,688 tok/s ≈ $0.104/s; 4K 17,376 tok/s ≈ $0.209/s. Price ∝ duration × resolution factor (1080p = 1.5×, 4K = 3× 720p). Omni 1.1: $17.50/1M, ≈ $0.10/s at 720p.

## 8. Venice video
Sources: https://docs.venice.ai/api-reference/endpoint/video/queue , https://docs.venice.ai/models/video , model list https://api.venice.ai/api/v1/models?type=video
- Flow: `/video/quote` (price), `/video/queue`, poll `/video/retrieve`.
- Request fields: `model`, `prompt` (default limit 2,500 chars, up to 32,000), `negative_prompt`, `duration` (string enum `1s`…`30s`, `-1`, `auto`, per model), `aspect_ratio` (enum `1:1, 2:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 9:21, 16:9, 21:9, adaptive, auto`, per model), `resolution` (enum `256p … 4k`, per model), `audio` (bool, default true where configurable), `image_url` (first frame; URL or data URL), `end_image_url` (end frame where supported), `image_strength` 0–1, `reference_image_urls` (**max 30**, models with reference support), `reference_video_urls`, `reference_audio_urls`, `audio_url`, `video_url`, `elements`, `scene_image_urls`, `keyframes`, `camera_trajectory`, plus upscaler/enhancer fields.
- Price: every video model is "Variable — use Video Quote API"; no per-resolution/duration price table is published.
- Not documented in the model list: per-model max reference images, end-frame support. The model list does give `reference_image_min_short_side_pixels` and min/max aspect ratio (e.g. Seedance 300 px, 0.4–2.5).
- Per-model constraints (138 models). Columns: id, type, aspect ratios (empty = follows input image), resolutions, durations in seconds, audio by default:

| Model | Type | Aspect ratios | Resolutions | Durations (s) | Audio |
| - | - | - | - | - | - |
| `gemini-omni-flash-1-1-text-to-video` | text-to-video | 16:9, 9:16 | 360p, 720p, 1080p, 4k | 4,6,8,10 | no |
| `gemini-omni-flash-1-1-image-to-video` | image-to-video |  | 360p, 720p, 1080p, 4k | 4,6,8,10 | no |
| `gemini-omni-flash-1-1-reference-to-video` | image-to-video | 16:9, 9:16 | 360p, 720p, 1080p, 4k | 4,6,8,10 | no |
| `gemini-omni-flash-1-1-video-to-video` | video |  | 360p, 720p, 1080p, 4k | Auto | no |
| `seedance-1-5-pro-text-to-video-basic` | text-to-video | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 1080p, 720p, 480p | 4,5,6,7,8,9,10,11,12 | yes |
| `seedance-1-5-pro-image-to-video-basic` | image-to-video |  | 1080p, 720p, 480p | 4,5,6,7,8,9,10,11,12 | yes |
| `seedance-2-0-text-to-video-basic` | text-to-video | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 4k, 1080p, 720p, 480p | 4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `seedance-2-0-image-to-video-basic` | image-to-video |  | 4k, 1080p, 720p, 480p | 4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `seedance-2-0-reference-to-video-basic` | image-to-video | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 4k, 1080p, 720p, 480p | 4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `seedance-2-0-fast-text-to-video-basic` | text-to-video | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 720p, 480p | 4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `seedance-2-0-fast-image-to-video-basic` | image-to-video |  | 720p, 480p | 4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `seedance-2-0-fast-reference-to-video-basic` | image-to-video | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 720p, 480p | 4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `seedance-2-0-mini-text-to-video-basic` | text-to-video | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 720p, 480p | 4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `seedance-2-0-mini-image-to-video-basic` | image-to-video |  | 720p, 480p | 4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `seedance-2-0-mini-reference-to-video-basic` | image-to-video | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 720p, 480p | 4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `seedance-2-5-text-to-video-basic` | text-to-video | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 1080p, 720p, 480p | 4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30 | yes |
| `seedance-2-5-image-to-video-basic` | image-to-video |  | 1080p, 720p, 480p | 4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30 | yes |
| `seedance-2-5-reference-to-video-basic` | image-to-video | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | 1080p, 720p, 480p | 4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30 | yes |
| `seedance-2-5-edit-video-basic` | video |  | 1080p, 720p, 480p | Auto | yes |
| `wan-3-0-text-to-video` | text-to-video | 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 720p, 480p | 2,5,10,15,20,25,30 | yes |
| `wan-3-0-image-to-video` | image-to-video | adaptive, 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 720p, 480p | 2,5,10,15,20,25,30 | yes |
| `wan-3-0-reference-to-video` | image-to-video | adaptive, 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 720p, 480p | 2,5,10,15,20,25,30 | yes |
| `wan-3-0-prime-text-to-video` | text-to-video | 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 720p, 480p | 2,5,10,15,20,25,30 | yes |
| `wan-3-0-prime-image-to-video` | image-to-video | adaptive, 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 720p, 480p | 2,5,10,15,20,25,30 | yes |
| `wan-3-0-prime-reference-to-video` | image-to-video | adaptive, 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 720p, 480p | 2,5,10,15,20,25,30 | yes |
| `wan-3-0-pro-text-to-video` | text-to-video | 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 2k, 4k | 2,5,10,15,20,25,30 | yes |
| `wan-3-0-pro-image-to-video` | image-to-video | adaptive, 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 2k, 4k | 2,5,10,15,20,25,30 | yes |
| `wan-3-0-pro-reference-to-video` | image-to-video | adaptive, 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 2k, 4k | 2,5,10,15,20,25,30 | yes |
| `wan-3-0-prime-pro-text-to-video` | text-to-video | 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 2k, 4k | 2,5,10,15,20,25,30 | yes |
| `wan-3-0-prime-pro-image-to-video` | image-to-video | adaptive, 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 2k, 4k | 2,5,10,15,20,25,30 | yes |
| `wan-3-0-prime-pro-reference-to-video` | image-to-video | adaptive, 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 2k, 4k | 2,5,10,15,20,25,30 | yes |
| `wan-2-7-text-to-video` | text-to-video | 16:9, 9:16, 1:1 | 1080p, 720p | 5,10,15 | no |
| `wan-2-7-image-to-video` | image-to-video |  | 1080p, 720p | 5,10,15 | no |
| `wan-2-7-reference-to-video` | image-to-video |  | 1080p, 720p | 5,10 | yes |
| `wan-2-7-video-to-video` | video |  | 1080p, 720p | Auto | no |
| `wan-2-7-enhanced-image-to-video` | image-to-video |  | 1080p, 720p | 5,10,15 | yes |
| `wan-2-7-enhanced-text-to-video` | text-to-video | 16:9, 9:16, 1:1 | 1080p, 720p | 5,10,15 | yes |
| `wan-2-2-enhanced-image-to-video` | image-to-video |  | 720p, 480p | 5,8 | no |
| `happyhorse-1-1-text-to-video` | text-to-video | 16:9, 9:16, 1:1, 4:3, 3:4, 21:9, 9:21, 5:4, 4:5 | 1080p, 720p | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `happyhorse-1-1-image-to-video` | image-to-video |  | 1080p, 720p | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `happyhorse-1-1-reference-to-video` | image-to-video | 16:9, 9:16, 1:1, 4:3, 3:4, 21:9, 9:21, 5:4, 4:5 | 1080p, 720p | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `happyhorse-1-0-text-to-video` | text-to-video | 16:9, 9:16, 1:1 | 1080p, 720p | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `happyhorse-1-0-image-to-video` | image-to-video |  | 1080p, 720p | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `happyhorse-1-0-reference-to-video` | image-to-video | 16:9, 9:16, 1:1, 4:3, 3:4 | 1080p, 720p | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `happyhorse-1-0-video-to-video` | video |  | 1080p, 720p | Auto | yes |
| `wan-2.6-image-to-video` | image-to-video |  | 1080p, 720p | 5,10,15 | yes |
| `wan-2.6-flash-image-to-video` | image-to-video |  | 1080p, 720p | 5,10,15 | yes |
| `wan-2.6-text-to-video` | text-to-video | 16:9, 9:16, 1:1 | 1080p, 720p | 5,10,15 | yes |
| `wan-2.5-preview-image-to-video` | image-to-video |  | 1080p, 720p, 480p | 5,10 | yes |
| `wan-2.5-preview-text-to-video` | text-to-video | 16:9, 9:16, 1:1 | 1080p, 720p, 480p | 5,10 | yes |
| `grok-imagine-text-to-video-private` | text-to-video | 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16 | 480p, 720p | 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `grok-imagine-image-to-video-private` | image-to-video |  | 480p, 720p | 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `grok-imagine-reference-to-video-private` | image-to-video | 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16 | 480p, 720p | 1,2,3,4,5,6,7,8,9,10 | no |
| `grok-imagine-video-to-video-private` | video |  | 480p, 720p | 5,10,15 | yes |
| `grok-imagine-1-5-text-to-video-private` | text-to-video | 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16 | 480p, 720p, 1080p | 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `grok-imagine-1-5-image-to-video-private` | image-to-video |  | 480p, 720p, 1080p | 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `grok-imagine-1-5-reference-to-video-private` | image-to-video | 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16 | 480p, 720p | 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `grok-imagine-1-5-lite-text-to-video` | text-to-video | 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16 | 480p, 720p, 1080p | 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `grok-imagine-1-5-lite-image-to-video` | image-to-video |  | 480p, 720p, 1080p | 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `ltx-2-v2-3-fast-image-to-video` | image-to-video | 16:9, 9:16 | 1080p, 1440p, 2160p | 6,8,10,12,14,16,18,20 | yes |
| `ltx-2-v2-3-fast-text-to-video` | text-to-video | 16:9, 9:16 | 1080p, 1440p, 2160p | 6,8,10,12,14,16,18,20 | yes |
| `ltx-2-v2-3-full-image-to-video` | image-to-video | 16:9, 9:16 | 1080p, 1440p, 2160p | 6,8,10 | yes |
| `ltx-2-v2-3-full-text-to-video` | text-to-video | 16:9, 9:16 | 1080p, 1440p, 2160p | 6,8,10 | yes |
| `ltx-2-5-fast-image-to-video` | image-to-video | auto, 16:9, 9:16 | 720p, 1080p, 1440p, 2160p | 6,8,10,12,14,16,18,20 | yes |
| `ltx-2-5-fast-text-to-video` | text-to-video | 16:9, 9:16 | 720p, 1080p, 1440p, 2160p | 6,8,10,12,14,16,18,20 | yes |
| `ltx-2-5-pro-image-to-video` | image-to-video | auto, 16:9, 9:16 | 720p, 1080p | 6,8,10 | yes |
| `ltx-2-5-pro-text-to-video` | text-to-video | 16:9, 9:16 | 720p, 1080p | 6,8,10 | yes |
| `ovi-image-to-video` | image-to-video |  |  | 5 | yes |
| `minimax-h3-max-text-to-video` | text-to-video | 16:9, 21:9, 4:3, 1:1, 3:4, 9:16 | 480P, 768P, 1080P | 5,6,7,8,9,10,11,12,13,14,15 | yes |
| `minimax-h3-max-image-to-video` | image-to-video |  | 480P, 768P, 1080P | 5,6,7,8,9,10,11,12,13,14,15 | yes |
| `minimax-h3-max-multi-angle` | image-to-video |  | 480P, 768P, 1080P | 5,6,7,8,9,10,11,12,13,14,15 | yes |
| `minimax-h3-max-reference-to-video` | image-to-video | adaptive, 16:9, 21:9, 4:3, 1:1, 3:4, 9:16 | 480P, 768P, 1080P | 5,6,7,8,9,10,11,12,13,14,15 | yes |
| `minimax-h3-max-recast` | video |  | 768P, 1080P | Auto | no |
| `minimax-h3-max-turbo-text-to-video` | text-to-video | 16:9, 21:9, 4:3, 1:1, 3:4, 9:16 | 480P, 768P, 1080P | 5,6,7,8,9,10,11,12,13,14,15 | yes |
| `minimax-h3-max-turbo-image-to-video` | image-to-video |  | 480P, 768P, 1080P | 5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-2.6-pro-text-to-video` | text-to-video | 16:9, 9:16, 1:1 |  | 5,10 | yes |
| `kling-2.6-pro-image-to-video` | image-to-video |  |  | 5,10 | yes |
| `kling-2.5-turbo-pro-text-to-video` | text-to-video | 16:9, 9:16, 1:1 |  | 5,10 | no |
| `kling-2.5-turbo-pro-image-to-video` | image-to-video |  |  | 5,10 | no |
| `kling-v3-4k-text-to-video` | text-to-video | 16:9, 9:16, 1:1 |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-v3-4k-reference-to-video` | image-to-video |  |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-o3-4k-text-to-video` | text-to-video | 16:9, 9:16, 1:1 |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-o3-4k-image-to-video` | image-to-video |  |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-o3-4k-reference-to-video` | image-to-video | 16:9, 9:16, 1:1 |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-o3-pro-text-to-video` | text-to-video | 16:9, 9:16, 1:1 |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-o3-pro-image-to-video` | image-to-video |  |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-o3-pro-reference-to-video` | image-to-video | 16:9, 9:16, 1:1 |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-o3-standard-text-to-video` | text-to-video | 16:9, 9:16, 1:1 |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-o3-standard-image-to-video` | image-to-video |  |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-o3-standard-reference-to-video` | image-to-video | 16:9, 9:16, 1:1 |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-v3-pro-motion-control` | video |  |  | Auto | no |
| `kling-v3-pro-text-to-video` | text-to-video | 16:9, 9:16, 1:1 |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-v3-pro-image-to-video` | image-to-video |  |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-v3-standard-motion-control` | video |  |  | Auto | no |
| `kling-v3-standard-text-to-video` | text-to-video | 16:9, 9:16, 1:1 |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-v3-standard-image-to-video` | image-to-video |  |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | yes |
| `kling-v3-turbo-pro-text-to-video` | text-to-video | 16:9, 9:16, 1:1 |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | no |
| `kling-v3-turbo-pro-image-to-video` | image-to-video |  |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | no |
| `kling-v3-turbo-standard-text-to-video` | text-to-video | 16:9, 9:16, 1:1 |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | no |
| `kling-v3-turbo-standard-image-to-video` | image-to-video |  |  | 3,4,5,6,7,8,9,10,11,12,13,14,15 | no |
| `kling-v4-text-to-video` | text-to-video | 16:9, 9:16, 1:1, 21:9 | 720p, 1080p | 3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30 | yes |
| `kling-v4-image-to-video` | image-to-video |  | 720p, 1080p | 3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30 | yes |
| `kling-v4-reference-to-video` | image-to-video | auto, 16:9, 9:16, 1:1, 21:9 | 720p, 1080p | 3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30 | yes |
| `longcat-distilled-image-to-video` | image-to-video |  | 720p | 5,10,15,20,30 | no |
| `longcat-distilled-text-to-video` | text-to-video | 16:9, 9:16, 1:1 | 720p | 5,10,15,20,30 | no |
| `longcat-image-to-video` | image-to-video |  | 720p | 5,10,15,20,30 | no |
| `longcat-text-to-video` | text-to-video | 16:9, 9:16, 1:1 | 720p | 5,10,15,20,30 | no |
| `veo3.1-fast-text-to-video` | text-to-video | 16:9, 9:16 | 720p, 1080p, 4k | 4,6,8 | yes |
| `veo3.1-fast-image-to-video` | image-to-video |  | 720p, 1080p, 4k | 4,6,8 | yes |
| `veo3.1-full-text-to-video` | text-to-video | 16:9, 9:16 | 720p, 1080p, 4k | 4,6,8 | yes |
| `veo3.1-full-image-to-video` | image-to-video |  | 720p, 1080p, 4k | 4,6,8 | yes |
| `gemini-omni-flash-text-to-video` | text-to-video | 16:9, 9:16 |  | 4,6,8,10 | no |
| `gemini-omni-flash-image-to-video` | image-to-video | 16:9, 9:16 |  | 4,6,8,10 | no |
| `gemini-omni-flash-reference-to-video` | image-to-video | 16:9, 9:16 |  | 4,6,8,10 | no |
| `flux-3-text-to-video` | text-to-video | auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16, 9:21 | 720p, 1080p, 1440p, 2160p | 5,10,15,20 | yes |
| `flux-3-image-to-video` | image-to-video | auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16, 9:21 | 720p, 1080p, 1440p, 2160p | 5,10,15,20 | yes |
| `flux-3-first-last-frame-to-video` | image-to-video | auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16, 9:21 | 720p, 1080p, 1440p, 2160p | 5,10,15,20 | yes |
| `flux-3-extend-video` | video | auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16, 9:21 | 720p, 1080p, 1440p, 2160p | 5,10,15,20 | yes |
| `flux-3-max-text-to-video` | text-to-video | auto, 21:9, 2:1, 16:9, 4:3, 1:1, 3:4, 9:16 | 720p, 1080p | 5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20 | yes |
| `flux-3-max-image-to-video` | image-to-video | auto, 21:9, 2:1, 16:9, 4:3, 1:1, 3:4, 9:16 | 720p, 1080p | 5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20 | yes |
| `pixverse-v5.6-text-to-video` | text-to-video | 16:9, 9:16, 1:1, 4:3, 3:4 | 360p, 540p, 720p, 1080p | 5,8 | yes |
| `pixverse-v5.6-image-to-video` | image-to-video |  | 360p, 540p, 720p, 1080p | 5,8 | yes |
| `pixverse-v5.6-transition` | image-to-video | 16:9, 9:16, 1:1, 4:3, 3:4 | 360p, 540p, 720p, 1080p | 5,8 | yes |
| `pixverse-c1-text-to-video` | text-to-video | 16:9, 4:3, 1:1, 3:4, 9:16, 2:3, 3:2, 21:9 | 360p, 540p, 720p, 1080p | 3,5,8,10,15 | yes |
| `pixverse-c1-image-to-video` | image-to-video |  | 360p, 540p, 720p, 1080p | 3,5,8,10,15 | yes |
| `pixverse-c1-reference-to-video` | image-to-video | 16:9, 4:3, 1:1, 3:4, 9:16, 2:3, 3:2, 21:9 | 360p, 540p, 720p, 1080p | 3,5,8,10,15 | yes |
| `pixverse-c1-transition` | image-to-video | 16:9, 4:3, 1:1, 3:4, 9:16, 2:3, 3:2, 21:9 | 360p, 540p, 720p, 1080p | 3,5,8,10,15 | yes |
| `vidu-q3-text-to-video` | text-to-video | 16:9, 9:16, 4:3, 3:4, 1:1 | 360p, 540p, 720p, 1080p | 3,5,8,10,12,14,16 | yes |
| `vidu-q3-image-to-video` | image-to-video |  | 360p, 540p, 720p, 1080p | 3,5,8,10,12,14,16 | yes |
| `runway-gen4-5` | image-to-video | 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 |  | 2,3,4,5,6,7,8,9,10 | no |
| `runway-gen4-5-text` | text-to-video | 16:9, 9:16 |  | 2,3,4,5,6,7,8,9,10 | no |
| `runway-gen4-turbo` | image-to-video | 16:9, 9:16, 1:1, 4:3, 3:4, 21:9 |  | 2,3,4,5,6,7,8,9,10 | no |
| `topaz-video-upscale` | video |  | 2x, 4x | Auto | no |
| `minimax-h3-enhanced-text-to-video` | text-to-video | 16:9, 21:9, 4:3, 1:1, 3:4, 9:16 | 768P, 2K | 5,6,7,8,9,10,11,12,13,14,15 | yes |
| `minimax-h3-enhanced-reference-to-video` | image-to-video | 16:9, 21:9, 4:3, 1:1, 3:4, 9:16 | 768P, 2K | 5,6,7,8,9,10,11,12,13,14,15 | yes |
| `minimax-h3-text-to-video` | text-to-video | 16:9, 21:9, 4:3, 1:1, 3:4, 9:16 | 768P, 2K | 5,6,7,8,9,10,11,12,13,14,15 | yes |
| `minimax-h3-image-to-video` | image-to-video |  | 768P, 2K | 5,6,7,8,9,10,11,12,13,14,15 | yes |
| `minimax-h3-reference-to-video` | image-to-video | 16:9, 21:9, 4:3, 1:1, 3:4, 9:16 | 768P, 2K | 5,6,7,8,9,10,11,12,13,14,15 | yes |

## 9. APIMart video
Sources: `https://docs.apimart.ai/en/api-reference/videos/<page>`: `veo3/generation`, `veo3/generation-official`, `gemini-omni-1.1-flash/generation`, `seedance-2-5/generation`, `seedance-2-0/generation`, `kling-v4/generation`, `wan2.7/generation`, `wan3.0-video/generation`, `minimax-hailuo-2.3/generation`, `vidu-q3/generation`, `happyhorse-1.1/generation`. 43 video pages exist (index https://docs.apimart.ai/_llms/en/api-manual.txt); the rest (Kling 2.6/3/O1/Omni, Hailuo 02, MiniMax H3, PixVerse v6, SkyReels v4, Vidu Q3 Pro/Q4, Wan 2.5/2.6/2.7 R2V/VideoEdit, Grok Imagine, Flux 3 video, Muse, Doubao, Seedance 1.5 Pro) were not read.

| Model | Durations (s) | Resolution | Aspect ratio | Frames / refs | Notes |
| - | - | - | - | - | - |
| `veo3.1-fast` / `-quality` / `-lite` (+`-ext` aliases) | fixed **8** | `720p` (default) / `1080p` / `4k` | `16:9` / `9:16` | `image_urls` ≤ 3 (frame mode: 1st = start, 2nd = end; reference mode: quality model not supported); lite takes no images | `generation_type` frame/reference, `enable_gif` (not with 1080p/4k) |
| `veo3.1-fast-official`, `veo3.1-quality-official` | 4 / 6 / **8** (default) | `720p` (default) / `1080p` / `4K` | `16:9` (default) / `9:16` | `first_frame_image`, `last_frame_image` | negative_prompt, seed, sample_count 1–4, generate_audio (default false), person_generation, resize_mode, enhance_prompt |
| `gemini-omni-1.1-flash` | 3–10 | `360p`, `720p` (default), `1080p`, `4k` | `16:9` (default) / `9:16` | `image_urls` + frames ≤ 10 total; first/last frame; `image_with_roles` | resolution sets the deposit tier and cost |
| `seedance-2.5` | 4–30, `-1` = model picks (pre-charged at 30 s); default **5** | `480p`, `720p` (default), `1080p` | `16:9, 4:3, 1:1, 3:4, 9:16, 21:9`, `adaptive` (default) | up to 30 images + 10 videos + 10 audios; first/last frame via `image_with_roles` | mp4/mov |
| `seedance-2.0`, `-fast` (and `-mini`) | 4–15, default 5 | `480p`, `720p` (default), `1080p` and `4k` (2.0 only) | `16:9` (default), `9:16, 1:1, 4:3, 3:4, 21:9`, `adaptive` | max 9 reference images, 3 reference videos (1.8–15.2 s total), 3 audios (≤15 s) | |
| `kling-v4` | 3–30, default 5 | `720p` (default) / `1080p` | `16:9` (T2V default), `9:16, 1:1, 21:9`; `auto` for reference mode | I2V: ≤ 2 images (first, last); reference/edit: ≤ 10 images | always stereo audio |
| `wan2.7` | 2–15, default 5 | `720P` / `1080P` (default) | `size` `16:9` (default), `9:16, 1:1, 4:3, 3:4` (T2V only) | 1 image = first frame, 2 = first+last; `video_urls` continuation | T2V and I2V billed the same |
| `wan3.0-video`, `wan3.0-video-prime` | 2–30, `-1` = model picks; default 5 | `480P`, `720P`, `1080P` (default, "highest price") | `adaptive` (default), `16:9, 4:3, 1:1, 3:4, 9:16` | images, video, audio, documents, web pages as references | |
| `MiniMax-Hailuo-2.3`, `-Fast` | `6` (default) / `10` | `768p` (default) / `1080p` (6 s only) | not documented on the page excerpt | first-frame image | camera commands, prompt optimisation |
| `viduq3-mix`, `viduq3` (reference-to-video) | mix 1–16, q3 3–16; default 5 | mix 720p (default)/1080p; q3 540p/720p (default)/1080p | `16:9` (default) / `9:16` | **1–7** reference images (required) | |
| `happyhorse-1.1` | 3–15, default 5 | `720P` / `1080P` (default) | `16:9` (default), `9:16`, … | R2V `image_urls` 1–9 (URL or base64); or `first_frame_image` | "Billed by resolution × duration (seconds) only" |

Price: APIMart video docs give no per-resolution/duration price numbers. The pricing page only shows starting prices (e.g. seedance-2.0 "$0.04/sec") ⚠ low confidence.

## 10. Together video
Sources: https://docs.together.ai/docs/inference/videos/parameters , https://docs.together.ai/docs/inference/videos/reference-and-keyframes , https://docs.together.ai/docs/wan2.7-quickstart , https://docs.together.ai/docs/seedance2.5-quickstart , catalog https://docs.together.ai/docs/serverless/models#video-models , OpenAPI `CreateVideoBody` https://docs.together.ai/openapi.yaml
- Generic fields (`POST /v2/videos`): `prompt` (≤32,000), `width`/`height` (typical default **1366×768**), `resolution`, `ratio`, `seconds` (string, generic range "1"–"10", default "6"), `fps` (default 24, some up to 60), `steps` 10–50, `guidance_scale`, `seed`, `negative_prompt`, `output_format` `MP4`/`WEBM`, `output_quality` (default 20, lower = better), `generate_audio` (default false), `media { frame_images[{input_image, frame: "first"|"last"|number}], frame_videos, reference_images, reference_videos, source_video, audio_inputs }`. Frame number = seconds × fps. Without `frame`: 1 image = first, 2 = first+last, 3+ = evenly spaced.
- ⚠ Kling: the parameters page says "Kling requires keyframe images via `media.frame_images` instead of a `prompt`", but no Kling model appears in the serverless video catalog.

### Wan 2.7 (`Wan-AI/wan2.7-t2v`, `-i2v`, `-r2v`, `-videoedit`)
- `resolution` `720P` / `1080P` (default **1080P**); `ratio` `16:9` (default), `9:16`, `1:1`, `4:3`, `3:4`; 30 fps MP4.
- `seconds`: T2V and I2V 2–15; R2V and Video Edit 2–10; default "5".
- Pixels: 16:9 1280x720 / 1920x1080; 9:16 720x1280 / 1080x1920; 1:1 960x960 / 1440x1440; **4:3 1104x832 / 1648x1248; 3:4 832x1104 / 1248x1648**.
- Media: I2V first and/or last frame, one continuation clip, one audio; R2V "Multiple" reference images/videos (**no number documented**); Video Edit one source video (required) + one reference image; T2V one audio. Audio WAV/MP3, 3–30 s, ≤15 MB. Prompt ≤5,000 chars, negative ≤500, seed 0–2,147,483,647.
- Price: catalog $0.10 for each of T2V/I2V/R2V ("Price per video", no resolution/duration given).

### Seedance 2.5 (`ByteDance/Seedance-2.5`)
- `resolution` `480p` / `720p` (default **720p**); no `ratio`, `width`, `height`, no 1080p/4k; audio always on.
- `seconds` 4–30 (integer), default "5".
- `frame_images` up to 2 (first, last); `reference_images` up to 30, `reference_videos` up to 10, `reference_audios` up to 10. `frame_images` cannot be combined with references.
- Price: **480p $0.115/second; 720p "from $0.249/second"**.
- ⚠ The catalog lists Seedance 2.5 at "$0.115" under "Price per video" while the quickstart says $0.115 per second; the serverless overview says video bills "Per second of output". Treat catalog figures as per-second at the lowest tier (unsure).

### Other Together video models (catalog only; parameters not documented per model)
HappyHorse 1.0/1.1 I2V/R2V/T2V ($0.24 / $0.14), FLUX 3 ($0.17), Seedance 1.0 Lite ($0.143, 720p/5s), Seedance 1.0 Pro ($0.57, 1080p/5s), Seedance 2.0 ($0.16; supports `ratio`, `width`, `height`, 1080p, 4k and `settings.audio` per the Seedance 2.5 page), **Veo 3.1 (`google/veo-3.1`, $0.08) and Veo 3.1 Lite ($0.05)**, MiniMax 01 Director ($0.28, 720p/5s), MiniMax H3 ($0.1391, 2k/1s), Hailuo 02 ($0.49, 768p/10s), PixVerse v5 ($0.30, 1080p/5s), v5.6 ($0.1326), v6 ($0.09), Vidu Q1 ($0.22, 1080p/5s), Q3 ($0.0975), Q3 Turbo ($0.195).

---

# Conflicts and uncertainties (summary)
1. Gemini Nano Banana 2.1 4K: 2520 tokens (image guide) vs 3780 tokens / $0.113 (pricing page).
2. Gemini 3.1 Flash 512 tier, 21:9 printed as 792x168 (not 21:9).
3. Gemini 3.1 Flash Lite: "14 aspect ratios" but 10 listed; `image_size` written as "1024px (1K)".
4. Gemini small tier: guide says "512px (0.5K)", API enum value is `512`; APIMart uses `0.5K`.
5. OpenAI GPT Image 2.6: arbitrary-size support for still images not explicitly stated.
6. APIMart `gpt-image-2` 1k table has two pixel values per ratio (e.g. 1024×1024 / 1254×1254).
7. APIMart Seedream 5.0 Lite header "2K / 3K" vs 2K/3K/4K field; Seedream 5.0 Flash "also accepted: seedream-5.0-pro".
8. APIMart prices are from a rendered pricing page via a summariser and depend on account tier.
9. Together: `aspect_ratio` in the docs, absent from the OpenAPI; FLUX Schnell listed as both `aspect_ratio` and `width/height`; FLUX.2 default 1024×768 (quickstart) vs 1024×1024 (API); FLUX.2 [pro] "up to 9 MP" (Together) vs "up to 4MP" (BFL).
10. Together Gemini 3 Pro sizes give "or" alternatives (1548/1584×672, 5096/5056×3392).
11. Together video catalog "Price per video" vs per-second billing (Seedance 2.5 $0.115/s).
12. Venice gpt-image-2 headline price vs per-quality "high" price differ by $0.01.
13. Venice multi-edit docs say `capabilities.maxInputImages`; the live model list uses `constraints.maxInputImages`.
