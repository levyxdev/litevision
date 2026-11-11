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
2. **Add Models**: an Alias your Agent will use (e.g. `gpt-image-cheap`), the Provider's model id, the Protocol it speaks, and whether it makes images or videos (filled in for you when the Provider's model list says):

   | Protocol | For |
   | --- | --- |
   | `openai-images` | OpenAI's Images API, and relays that copy it |
   | `gemini` | Google's Gemini API (Interactions API) |
   | `venice` | Venice |
   | `apimart` | APIMart |
   | `together` | Together AI, images and videos. Models Together passes through to their makers (FLUX, Google, Qwen, …) work only once you turn on "Passthrough models" in Together's organization settings, which sends your prompts for them to those makers. |

3. **Pick a default image Model** (and a default video Model) and, optionally, write Model Notes ("photoreal, cheap, bad at Chinese text") so the Agent knows when to choose each one.
4. **Optionally, set Standing Options** on a Model: a JSON object of the Provider's own request fields, such as `{ "quality": "high" }`, that every Job on it sends. The Agent's `provider_options` override them for one Job.

The page also shows the Job history, with the images and videos and any Ratings you gave, and lets you rate a Job or one of its results. Each Model shows its Option Statuses read-only: what litevision has learned about the `provider_options` values sent to it.

## Tools

| Tool | What it does |
| --- | --- |
| `generate_image` | Generates `n` images from a prompt, optionally with reference images. Size, quality and every other setting are the Model's own fields in `provider_options`, passed to the Provider as they are; without them the Provider's defaults apply. Saves the images, named after the optional `name`, and returns the file paths, with the size the request asked for and the size each image actually came out at. |
| `generate_video` | Generates a video from a prompt, optionally with a first and last frame and reference images. Shape, resolution and length are the Model's own fields in `provider_options`. Saves it, named after the optional `name`, and returns the file path, with what the request asked for and the video's actual size and length. |
| `generate_comparison` | Starts 2 to 4 Jobs of one Modality together, differing in prompt, Model or both, each with its own `provider_options` and `name`, so you can choose among the results. The Agent starts one only when you ask for it or agree to it. |
| `get_job` | Waits for, or reports on, a Job that was still running when `generate_image`, `generate_video` or `generate_comparison` returned. |
| `list_models` | Lists the configured Models with their Modality, Model Notes, Standing Options, a summary of their Parameter Guide, docs link and the Option Status of each `provider_options` value sent to it; for one Model, also its full Parameter Guide (each parameter's values, default and price effect, with sources and the date they were checked) or the Provider's own parameter schema where it publishes one, each Option Status with its values, date and Job, its five most recent Ratings, and the Picks of up to five Comparisons it took part in (most recently picked first). |
| `pick_result` | Records your Pick when you choose among a Comparison's results; choosing again replaces it. A Pick says which you prefer, not that it is good, so it changes no Option Status. You can also pick in the settings page's Job history, which shows a Comparison's Jobs together. |
| `rate_job` | Records your verdict on a Job or on one of its results (good or bad, plus a reason) when you state one. A Rating judges the result, never the options that produced it, so it changes no Option Status. |
| `update_model_notes` | Replaces a Model's Notes, only with text you agreed to. You can undo it in the settings page. |
| `open_settings` | Opens the settings page. |

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
| Providers, Models (`config.json`) and Credentials (`credentials.json`, mode 600) | `~/.config/litevision/` |
| Job history (`jobs.jsonl`) and the cached parameter descriptions Providers give (`capabilities.json`) | `~/.local/share/litevision/` |
| Generated images and videos, unless the Agent passes `output_path` | `~/litevision/outputs/<date>/` |

A saved file is named after the `name` the Agent passes, in any language, with only the characters a path cannot hold removed: `张三.png`, or `张三-1.png`, `张三-2.png` for a Job with several results. Without `name` it is named after the time the Job started, e.g. `140500.png`. A name already taken in the folder gets the next free number, `张三-2.png`, `张三-3.png`. The Job history records which files each Job saved.

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
