# litevision

Let an AI agent generate images through models you already pay for.

litevision is a local [MCP](https://modelcontextprotocol.io) server. You configure your own Providers (OpenAI, Gemini, Venice, APIMart, or any compatible relay) once, in a settings page on your own machine. Your Agent (Claude Code, Codex, …) then generates images with them and gets back file paths. Your API keys never pass through the conversation.

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

Ask your Agent to generate an image. While nothing is configured, it calls `open_settings`, which opens the settings page in your browser. You can also open it yourself:

```bash
npx -y litevision settings
```

The page listens on `127.0.0.1` only, behind a one-time token, and shuts down after a few idle minutes. On it you:

1. **Add a Provider**: a name, a base URL, and its API key (the Credential). "Test connection" checks the key.
2. **Add Models**: an Alias your Agent will use (e.g. `gpt-image-cheap`), the Provider's model id, and the Protocol it speaks:

   | Protocol | For |
   | --- | --- |
   | `openai-images` | OpenAI's Images API, and relays that copy it |
   | `gemini` | Google's Gemini API (Interactions API) |
   | `venice` | Venice |
   | `apimart` | APIMart |

3. **Pick a default image Model** and, optionally, write Model Notes ("photoreal, cheap, bad at Chinese text") so the Agent knows when to choose each one.

The page also shows the Job history, with the images and any Ratings you gave.

## Tools

| Tool | What it does |
| --- | --- |
| `generate_image` | Generates images from a prompt, optionally with reference images, an aspect ratio and Provider-specific `provider_options`. Saves them and returns the file paths. |
| `get_job` | Waits for, or reports on, a Job that was still running when `generate_image` returned. |
| `list_models` | Lists the configured Models with their capabilities and Model Notes; for one Model, also its docs link, parameter schema and options that already worked. |
| `rate_job` | Records your verdict on a result (good or bad, plus a reason) when you state one. |
| `update_model_notes` | Replaces a Model's Notes, only with text you agreed to. You can undo it in the settings page. |
| `open_settings` | Opens the settings page. |

## Where things are kept

| What | Where |
| --- | --- |
| Providers, Models (`config.json`) and Credentials (`credentials.json`, mode 600) | `~/.config/litevision/` |
| Job history (`jobs.jsonl`) and cached Model capabilities | `~/.local/share/litevision/` |
| Generated images, unless the Agent passes `output_path` | `~/litevision/outputs/<date>/` |

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
