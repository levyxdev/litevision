# Develop with Bun, ship plain JavaScript that runs on Node

litevision is developed with Bun alone: it installs dependencies, runs scripts and tests (`bun test`) and bundles the release with `bun build --target node`. Users run the published npm package with `npx`, so it runs on Node (`engines.node >= 22`). Source code therefore uses Node APIs (`node:fs`, `node:http`, `fetch`, …) and never Bun-only ones such as `Bun.serve`, `Bun.file` or `bun:sqlite`; only tests may import `bun:test`. One toolchain keeps setup to a single install, while targeting Node keeps the barrier for Users at whatever their Agent already needs.

## Considered Options

- **Node with pnpm, vitest and a separate bundler**: rejected because it is several tools to install and configure for no gain at this size.
- **Ship for Bun (`bunx`) or as a compiled binary**: rejected because Users would have to install Bun, or we would have to build and distribute one binary per platform.
