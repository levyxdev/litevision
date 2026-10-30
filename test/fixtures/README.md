# Provider fixtures

Responses the injected HTTP transport replays in tests. The `openai/` files are hand-written from OpenAI's documented response shapes, not captured from live calls; replace them with real captures (Credentials removed) during the live smoke test (#11).

The OpenAI error responses (`invalid-api-key`, `insufficient-quota`, `billing-hard-limit-reached`, `rate-limit-exceeded`, `moderation-blocked`, `content-policy-violation`, `server-error`) follow OpenAI's documented `{ "error": { "message", "type", "param", "code" } }` shape; the tests pair each with the HTTP status OpenAI sends it with. `edits.json` answers `/images/edits`, which responds in the same shape as `/images/generations`.

The `apimart/` files are hand-written from APIMart's official docs (https://docs.apimart.ai/en), also not live captures; #11 replaces them. Sources:

- `submitted.json`, and the `{ "error": { "code", "message", "type" } }` errors `invalid-api-key` (401), `insufficient-balance` (402) and `rate-limit` (429): the response examples on the GPT-Image-2 page (`api-reference/images/gpt-image-2/generation`).
- `task-*.json`: Get Task Status (`api-reference/tasks/status`). `task-completed.json` follows its documented example, where `result.images[].url` is an array; `pending`, `processing`, `failed` and `cancelled` keep that shape with the fields the page lists for each status. The moderation message in `task-failed-moderation.json` is made up; the page documents only the `error` object's fields.
- `models.json`: Models List Metadata (`api-reference/texts/models/list`) with `expand=category`.
- `schema-gpt-image-2.json`: that page says `GET /v1/models/{model}/schema` answers in the same shape as one list item with `expand=parameters`. Its `input_schema` is filled in from the GPT-Image-2 page's request fields.
