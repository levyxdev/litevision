# litevision

## Git workflow

Commit and push to `dev`, then close the issues the push resolves; `main` moves only in a release. Before a release, see `docs/agents/git-workflow.md`.

## Tests

Test through the MCP tools, as an Agent calls them: `startHarness` in `test/harness.ts` runs the server on recorded Provider responses and temporary folders. This is the default seam for `/tdd`.

## Settings page

To check the settings page, open it on the User's real configuration with `bun src/cli.ts settings`. The page never shows a Credential beyond its last 4 characters.

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
