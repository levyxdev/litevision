# Model capabilities are asked of the Provider and cached, with built-in fallbacks

What a Model can do — its aspect ratios and their sizes, how many reference images and images per Job it takes — differs by model, not just by Protocol, and Providers add and change models often. Where a Provider describes its models (Venice's `GET /models?type=image` constraints, APIMart's `GET /v1/models/{model}/schema`), litevision asks it. The answer is cached per Model in `~/.local/share/litevision/capabilities.json` for a day, and asked again when the User adds or changes a Model or a "test connection" succeeds in the settings page. When the Provider cannot be asked (no Credential yet, offline, a relay without the endpoint, an answer litevision cannot read), the last cached answer is used, then the adapter's own built-in table. Gemini describes no image capabilities, so its adapter uses only its table.

The same lookup gives the Agent what it needs to use `provider_options` on its own: a docs link per Model, the Provider's parameter schema when it publishes one, and the options completed Jobs have already sent (derived from the Job history). litevision still passes `provider_options` through unchecked, and the Provider's error tells the Agent when one is wrong.

## Considered Options

- **Built-in tables only**: rejected because every new model on a relay would need a litevision release before its sizes and limits were right.
- **Ask the Provider on every call**: rejected because `list_models` would pay one Provider round trip per Model each time, and nothing would work offline.
- **Store the answer in `config.json` when the Model is added**: rejected because `config.json` is what the User edits; a cache that litevision may throw away belongs with the other data it writes.

## Consequences

`generate_image` and `list_models` may wait a few seconds for a Provider whose cached answer is stale; the wait is capped and falls back rather than failing. A "known-good" option only means the Provider accepted it and returned images, not that it changed the result.
