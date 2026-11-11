# Git workflow

Two long-lived branches, no others:

- **`dev`**: all work. Commit here, run `bun run typecheck && bun test`, `git push`.
- **`main`**: released code only. Every commit on `main` is a published version tagged `vX.Y.Z`. `main` moves only during a release, and only by fast-forward to `dev`.

`main` stays the GitHub default branch: `npx skills add levyxdev/litevision` and the README on GitHub and npm read from it, so users always get the released Skill and docs.

An urgent fix is an ordinary commit on `dev`, shipped as a patch release.

## Release

1. On `dev`: `bun run typecheck && bun test`.
2. Bump `version` in `package.json`, commit `Release X.Y.Z`.
3. `git switch main && git merge --ff-only dev`. If it refuses, `main` has a commit `dev` lacks: `git switch dev && git merge main` and start again.
4. `git tag vX.Y.Z && git push origin main dev vX.Y.Z`.
5. `npm publish` (`prepublishOnly` runs typecheck, tests and build).
6. `gh release create vX.Y.Z --title X.Y.Z --generate-notes`.
7. `git switch dev`.
