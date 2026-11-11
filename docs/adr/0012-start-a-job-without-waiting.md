# An Agent can start a Job without waiting for it, and collects it with get_job

ADR 0010 assumed that several calls cost the Agent nothing, so it dropped translated parameters and let the Agent write each Model's own fields in separate calls. In use they cost time: Claude Code runs tool calls that are not read-only one after another, so three `generate_image` calls sent in one message ran strictly in sequence, each starting within 20 ms of the previous one finishing. litevision itself has no Job queue; the client was waiting. `generate_image` and `generate_video` therefore take `wait` (default `true`). With `wait: false` the tool starts the Job and returns its `job_id` at once; the Job runs in the background, and the Agent collects it with `get_job`. Several such Jobs run at the same time, so the whole takes about as long as the slowest. A Job not waited for is an ordinary Job: it records its Source Jobs and file hashes, and a failure is recorded on the Job for `get_job` to report. A Comparison still waits (ADR 0009).

This corrects ADR 0010 where it says making several calls costs the Agent nothing, and ADR 0009 where it rejects separate calls partly because the Agent would wait on each Job in turn. That ADR's other reason, that the Agent would have to keep the group together itself, still holds.

## Considered Options

- **Mark the generation tools read-only**, so the client runs them in parallel: rejected because they are not. They spend the User's money and write files, and a read-only hint can also let a client skip asking the User before calling them.
- **A batch tool** that takes several requests and returns them together: rejected because it adds a second grouping concept next to the Comparison, and the Agent would still wait for the whole batch before seeing any result.
- **A Job queue inside litevision**: rejected because litevision never queued Jobs; the calls arrived one at a time from the client.
