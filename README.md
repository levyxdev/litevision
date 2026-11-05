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

## Set up

Ask your Agent to generate an image. While nothing is configured, it calls `open_settings`, which opens the settings page in your browser. You can also open it yourself, from your Agent's prompt menu (in Claude Code, the `/mcp__litevision__settings` command) or from a terminal:

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

The page also shows the Job history, with the images and videos and any Ratings you gave, and lets you rate a Job or one of its results.

## Tools

| Tool | What it does |
| --- | --- |
| `generate_image` | Generates images from a prompt, optionally with reference images, an aspect ratio and Provider-specific `provider_options`. Saves them and returns the file paths, with the size each image actually came out at. |
| `generate_video` | Generates a video from a prompt, optionally with a first and last frame, reference images, an aspect ratio, a duration and a resolution. Saves it and returns the file path, with its actual size and length. |
| `generate_comparison` | Starts 2 to 4 Jobs of one Modality together, differing in prompt, Model or both, so you can choose among the results. The Agent starts one only when you ask for it or agree to it. |
| `get_job` | Waits for, or reports on, a Job that was still running when `generate_image`, `generate_video` or `generate_comparison` returned. |
| `list_models` | Lists the configured Models with their Modality, capabilities, Model Notes, docs link and Known-good Options (the `provider_options` that worked); for one Model, also their values, options made suspect by a bad Rating or a result that did not match, its five most recent Ratings, the Picks of the five Comparisons it most recently took part in, and the Provider's parameter schema. |
| `pick_result` | Records your Pick when you choose among a Comparison's results; choosing again replaces it. A Pick says which you prefer, not that it is good, so it does not change Known-good Options. You can also pick in the settings page's Job history, which shows a Comparison's Jobs together. |
| `rate_job` | Records your verdict on a Job or on one of its results (good or bad, plus a reason) when you state one. A bad Rating of the whole Job, or of its only result, makes the options that Job used suspect until a good one uses them again. |
| `update_model_notes` | Replaces a Model's Notes, only with text you agreed to. You can undo it in the settings page. |
| `open_settings` | Opens the settings page. |

## Where things are kept

| What | Where |
| --- | --- |
| Providers, Models (`config.json`) and Credentials (`credentials.json`, mode 600) | `~/.config/litevision/` |
| Job history (`jobs.jsonl`) and cached Model capabilities | `~/.local/share/litevision/` |
| Generated images and videos, unless the Agent passes `output_path` | `~/litevision/outputs/<date>/` |

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
