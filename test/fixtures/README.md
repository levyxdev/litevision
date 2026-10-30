# Provider fixtures

Responses the injected HTTP transport replays in tests. The `openai/` files are hand-written from OpenAI's documented response shapes, not captured from live calls; replace them with real captures (Credentials removed) during the live smoke test (#11).

The OpenAI error responses (`invalid-api-key`, `insufficient-quota`, `billing-hard-limit-reached`, `rate-limit-exceeded`, `moderation-blocked`, `content-policy-violation`, `server-error`) follow OpenAI's documented `{ "error": { "message", "type", "param", "code" } }` shape; the tests pair each with the HTTP status OpenAI sends it with. `edits.json` answers `/images/edits`, which responds in the same shape as `/images/generations`.
