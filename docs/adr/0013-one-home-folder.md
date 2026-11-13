# Configuration and data live in one `~/.litevision` folder

litevision keeps `config.json`, `credentials.json`, `jobs.jsonl` and `capabilities.json` in `~/.litevision` on every system, or in `LITEVISION_HOME` when it is set. Generated files stay in `~/litevision/outputs`, outside it: they are the User's to open and share, and a hidden folder would hide them from Finder, while sharing the outputs folder never carries a Credential with it. One folder, the same on every system, is one path to tell a User, back up or delete, as with `~/.claude` or `~/.cargo`. On Windows the folder mode 700 has no effect; the user profile's own permissions protect it.

## Considered Options

- **XDG folders on every system** (`~/.config` and `~/.local/share`), as before: rejected because they split one tool's files in two and are foreign on macOS and Windows.
- **Each system's own folders** (`~/Library/Application Support`, `%APPDATA%` and `%LOCALAPPDATA%`, XDG): rejected because the path differs on each system, which makes docs and troubleshooting harder for no gain to the User.
