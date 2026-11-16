# One Runtime per machine, and a machine-wide queue for local Jobs

A local GPU holds one Model at a time, and sd-server refuses to load another while a Job runs. Each Agent session runs its own litevision process, so if every process started its own Runtime, two Models would fill the GPU, and two processes sharing one Runtime would fail each other's Jobs whenever they asked for different Models. litevision therefore runs one Runtime per machine and queues local Jobs across every process on it.

- The first local Job starts the Runtime litevision installed, on `127.0.0.1` and a free port, and records it in `~/.litevision/runtime.json`. Other processes use it from there. The process that started it stops it when it exits; a Job another process had running then fails, and the next Job starts a new Runtime. A Runtime whose process outlived its litevision is adopted by the next one to use it. Without an installed Runtime, local Jobs go to the Provider's base URL, a Runtime the User runs.
- Each local Job puts a file in `~/.litevision/queue/` and runs only once it holds the turn, which it keeps until the Job ends. The turn goes to the oldest Job on the Model the Runtime last ran, else to the oldest Job, so Jobs on one Model run together. Files left by a process that died are removed by whoever finds them.
- Removing a Job's queue file cancels it, so `cancel_job` works from any session: a waiting Job never starts, and a running one is cancelled on the Runtime, which stops at its next step and keeps the Model loaded.
- After ten minutes without a local Job, the process that owns the Runtime unloads its Model; the Runtime keeps running.

This differs from ADR 0012, which rejected a Job queue because Jobs arrived from the client one at a time. That still holds for cloud Jobs, which never queue.

## Considered Options

- **A Runtime per process**: rejected because two sessions would load two Models into one GPU.
- **Let sd-server queue the Jobs**: rejected because it queues Jobs only for the Model it has loaded and refuses a load while any is pending, so a Job on another Model fails instead of waiting.
- **A queue inside one litevision process**: rejected because Jobs from other sessions would still collide on the Runtime.
