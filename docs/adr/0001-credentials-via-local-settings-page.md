# Credentials are entered through a local settings page, never through the Agent

litevision's caller is an Agent whose conversation, tool arguments and shell output can end up in transcripts and logs, so a Credential must never pass through it. The User enters Credentials in a settings web page that litevision serves on `127.0.0.1`. Either the `open_settings` MCP tool or `litevision settings` opens the page. Credentials are stored in a separate `credentials.json` (mode 600) that the Agent-facing tools never print.

Any website open in the User's browser can send requests to localhost. The page therefore accepts a request only if all three checks pass:

- it carries a random one-time token from the URL litevision opened;
- its `Host` header is `127.0.0.1`, which defeats DNS rebinding;
- its `Origin` header is the page's own origin.

The page also shuts down after a period of idleness. Without these checks, a malicious page could rewrite a Provider's base URL and capture its key on the next generation.

## Considered Options

- **Environment variables only**: rejected because the User then has to edit shell profiles for every relay. It also gives no place to test a connection or choose Models.
- **Interactive CLI wizard**: rejected because MCP is the only Agent-facing surface. Asking the User to switch to a terminal is clumsier than a page the Agent can open for them.
- **The User pastes the key into chat**: rejected outright, because the key would land in the transcript.

## Consequences

This protects against accidental leaks, not against a malicious Agent. An Agent with shell access can still read any file the User can.
