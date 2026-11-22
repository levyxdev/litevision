# The Agent may set Standing Options, with the User's agreement

Standing Options were set only in the settings page, so a User who told their Agent "always use 2K on this Model" had to go and type it themselves. The Agent now sets them with `update_standing_options`, once the User has seen the old and new Standing Options and agreed.

This does not reopen ADR 0008. Model Notes hold what is known about a Model; Standing Options hold what the User wants from it, so they are not a second place for the Agent's knowledge. They do change what every later Job sends, and what it costs, so they are kept like Model Notes: the last change records who made it and when, keeps the one previous version, and the User can undo it in the settings page.

## Considered Options

- **The Agent opens the settings page for the User to type them**: rejected because the User has already said what they want, and agreeing to it is enough.
