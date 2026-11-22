# litevision

Let an AI agent generate images and videos through models you already pay for.

litevision is a local [MCP](https://modelcontextprotocol.io) server. You configure your own Providers (OpenAI, Gemini, Venice, APIMart, Together AI, or any compatible relay) once, in a settings page on your own machine. Your Agent (Claude Code, Codex, …) then generates images and videos with them and gets back file paths. Your API keys never pass through the conversation.

## Install

Requires Node.js 22 or later.

Claude Code:

```bash
claude mcp add litevision -- npx -y litevision
```

Any other MCP client: run `npx -y litevision` as a stdio server, for example:

```json
{
  "mcpServers": {
    "litevision": { "command": "npx", "args": ["-y", "litevision"] }
  }
}
```

### The litevision Skill

The server tells your Agent the rules it must keep. How to get good results (writing prompts, checking each result against your request, when to suggest a Comparison or new Model Notes) is in the litevision Skill, [`skills/litevision/SKILL.md`](skills/litevision/SKILL.md), drafted from the Model makers' own prompting guides. Install it with [`skills`](https://github.com/vercel-labs/skills):

```bash
npx skills add levyxdev/litevision
```

Add `-g` to install it for your user instead of the current project, and `-a` to choose which Agents get it. The Skill changes only with a litevision release: run `npx skills update` after upgrading litevision. Without it, your Agent still keeps the rules, but writes prompts its own way.

## Set up

Ask your Agent to generate an image. While nothing is configured, it calls `open_settings`, which opens the settings page in your browser. You can also ask your Agent to open litevision's settings, or open the page yourself from a terminal:

```bash
npx -y litevision settings
```

The page listens on `127.0.0.1` only, behind a one-time token, and shuts down after a few idle minutes. On it you:

1. **Add a Provider**: a name, a base URL, and its API key (the Credential). "Test connection" checks the key.
2. **Add Models**: an Alias your Agent will use (e.g. `gpt-image-cheap`; suggested from the Provider id and model id, such as `together-google-flash-image-3.1`), the Provider's model id, the Protocol it speaks, and whether it makes images or videos (filled in for you when the Provider's model list says):

   | Protocol | For |
   | --- | --- |
   | `openai-images` | OpenAI's Images API, and relays that copy it |
   | `gemini` | Google's Gemini API (Interactions API) |
   | `venice` | Venice |
   | `apimart` | APIMart |
   | `together` | Together AI, images and videos. Models Together passes through to their makers (FLUX, Google, Qwen, …) work only once you turn on "Passthrough models" in Together's organization settings, which sends your prompts for them to those makers. |
   | `sdcpp` | Local Models, which only `litevision local install` adds (see below), with no API key or base URL. The model id is a recipe in the Runtime's model folder that names the weight files. |

3. **Pick a default image Model** (and a default video Model) and, optionally, write Model Notes ("photoreal, cheap, bad at Chinese text") so the Agent knows when to choose each one.
4. **Optionally, set Standing Options** on a Model: a JSON object of the Provider's own request fields, such as `{ "quality": "high" }`, that every Job on it sends, or let the Agent set them once you agree. The Agent's `provider_options` override them for one Job.

### Local Models

On a Mac with Apple Silicon (16 GB of memory or more) or a Windows PC with an NVIDIA GPU (8 GB of VRAM or more, CUDA 12), litevision runs open-weight image Models on your own machine, with no API key:

```bash
npx -y litevision local install flux-3-klein
```

The Models are `flux-3-klein`, `z-image-turbo`, `qwen-image-2.1` and `qwen-image-2.1-turbo`; `list_models` shows each one's Parameter Guide.

It prints the Model's licence, the quantisation chosen for your memory and what it will download, then asks; `--yes` skips the question, `--quant` picks another quantisation, and `--force` installs a Model that will likely not fit. It downloads stable-diffusion.cpp's `sd-server` and the weights, checks every file against its pinned SHA-256, and adds the `local` Provider and the Model. Weights you already have, for example in ComfyUI, are reused instead of downloaded when `config.json` names their folder: `"localModelFolders": ["/path/to/ComfyUI/models"]`. `npx -y litevision local remove flux-3-klein` deletes the Model's weights, except files another installed Model uses. Installing again after upgrading litevision replaces an outdated `sd-server`.

On the settings page, the `local` Provider's "Test connection" checks that `sd-server`, each local Model's weights and, on Windows, the NVIDIA driver are in place, and names whatever is missing.

litevision starts its `sd-server` when a local Job needs it and shares it between all your Agent sessions; it does not use an `sd-server` you run yourself, so you can remove yours and keep only litevision's.

The page also shows the Job history, with the images and videos and any Ratings you gave, and lets you rate a Job or one of its results. Each Model shows its Option Statuses read-only: what litevision has learned about the `provider_options` values sent to it.

## Tools

| Tool | What it does |
| --- | --- |
| `generate_image` | Generates `n` images from a prompt, optionally with reference images. Size, quality and every other setting are the Model's own fields in `provider_options`, passed to the Provider as they are; without them the Provider's defaults apply. Saves the images, named after the optional `name`, and returns the file paths, with the size the request asked for and the size each image actually came out at. With `wait: false` it returns the Job's id at once and the Job runs in the background, so several Jobs run at the same time and `get_job` collects each. |
| `generate_video` | Generates a video from a prompt, optionally with a first and last frame and reference images. Shape, resolution and length are the Model's own fields in `provider_options`. Saves it, named after the optional `name`, and returns the file path, with what the request asked for and the video's actual size and length. Takes `wait: false` like `generate_image`. |
| `generate_comparison` | Starts 2 to 4 Jobs of one Modality together, differing in prompt, Model or both, each with its own `provider_options` and `name`, so you can choose among the results. The Agent starts one only when you ask for it or agree to it. |
| `get_job` | Waits for, or reports on, a Job that was still running when `generate_image`, `generate_video` or `generate_comparison` returned, as one started with `wait: false` always is. Also shows the Job's Source Jobs: the earlier Jobs whose results it was given as reference images. |
| `cancel_job` | Cancels a running Job. A local one stops at the Runtime's next step, or never starts if it is still waiting for its turn; on a cloud Model litevision only stops waiting, and the Provider may still bill for it. |
| `list_models` | Lists the configured Models with their Modality, Model Notes, Standing Options, a summary of their Parameter Guide, docs link and the Option Status of each `provider_options` value sent to it; for one Model, also its full Parameter Guide (each parameter's values, default and price effect, with sources and the date they were checked) or the Provider's own parameter schema where it publishes one, each Option Status with its values, date and Job, its five most recent Ratings with each Job's Source Jobs, and the Picks of up to five Comparisons it took part in (most recently picked first). |
| `pick_result` | Records your Pick when you choose among a Comparison's results; choosing again replaces it. A Pick says which you prefer, not that it is good, so it changes no Option Status. You can also pick in the settings page's Job history, which shows a Comparison's Jobs together. |
| `rate_job` | Records your verdict on a Job or on one of its results (good or bad, plus a reason) when you state one. A Rating judges the result, never the options that produced it, so it changes no Option Status. |
| `update_model_notes` | Replaces a Model's Notes, only with text you agreed to. You can undo it in the settings page. |
| `update_standing_options` | Replaces a Model's Standing Options, only with ones you agreed to. You can undo it in the settings page. |
| `delete_jobs` | Deletes Jobs for good, when you ask: their records, Ratings, Picks and saved files, by Job, by Comparison or all at once. Your reference images are never deleted, a file you changed since is left, and a Job still running is left alone until it ends or is cancelled; one whose session ended before it finished can be deleted. What litevision learnt about each Model's options is kept. You can also delete in the settings page's Job history. |
| `open_settings` | Opens the settings page, on its Providers, Models or Job history tab when the Agent names one. |

## Option Status

For each `provider_options` value sent to a Model, litevision keeps an Option Status from facts alone, never from your Ratings:

- **Honoured**: the result was checked against the request (its shape; its pixel size, where the request names exact dimensions or a tier the Parameter Guide sizes; its file format; a video's length) and matched.
- **Ignored**: the result was checked and did not match, so the Provider may have ignored the value.
- **Rejected**: the Provider's error named it; its message is kept.
- **Accepted**: the Provider did not reject it, but nothing can check its effect (`quality`, `seed`, …).

Fields checked together, such as `width` and `height`, share one; a nested field a check reads, such as Gemini's `response_format.image_size`, has its own. The latest evidence wins and is shown with its date and Job, so the Agent can tell when to read the docs again.

## Where things are kept

| What | Where |
| --- | --- |
| Providers, Models (`config.json`), Credentials (`credentials.json`, mode 600), Job history (`jobs.jsonl`), the cached parameter descriptions Providers give (`capabilities.json`), and for local Models `sd-server` (`runtime/`) and the weights, in ComfyUI's folder layout, with a recipe for each Model (`models/`) | `~/.litevision/`, or `LITEVISION_HOME` |
| Generated images and videos, unless the Agent passes `output_path` | `~/litevision/outputs/<date>/` |

A saved file is named after the `name` the Agent passes, in any language, with only the characters a path cannot hold removed, and any image or video extension it ends in (the file gets its own): `张三.png`, or `张三-1.png`, `张三-2.png` for a Job with several results. Without `name` it is named after the time the Job started, e.g. `140500.png`. A name already taken in the folder gets the next free number, `张三-2.png`, `张三-3.png`. The Job history records which files each Job saved, with a hash of each file's content. When a later Job is given one of them, or a copy of it anywhere, as a reference image or video frame, litevision finds the earlier Job by that hash and records it as a Source Job, so a chain of edits and its Ratings can be read in order. It never reads old files again: delete the ones you don't want, and a deleted one is shown as deleted.

## Develop

litevision is developed with [Bun](https://bun.sh) and ships plain JavaScript for Node (see `docs/adr/`).

```bash
bun install
```

```bash
bun test
```

```bash
bun run build
```

## License

Apache-2.0
