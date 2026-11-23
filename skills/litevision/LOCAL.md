# Set up a local Model

Install a local Model when the User wants images made on their own machine, with no Provider. Do everything yourself except what only the User can do; leave every command that needs `sudo` to them.

1. **Check the machine.** `local install` says whether litevision runs local Models here and which quantisation fits its memory. On Windows, first run `nvidia-smi`: it must answer, and its header must show `CUDA Version` 12 or later. If it does not, hand the User installing or updating the NVIDIA driver, then check again.
2. **Choose the Model.** `flux-3-klein` generates and edits, and is the one to start with. `z-image-turbo` only generates, in fewer steps. `qwen-image-2.1` and `qwen-image-2.1-turbo` are larger and for non-commercial use only. Smaller images are much faster: start at 512 to 768 pixels on a 16 GB machine.
3. **See what it needs.** Run `npx -y litevision local install <model>` without `--yes`. It downloads nothing and prints the licence, the speed, the quantisation it chose for this machine's memory, and every file with its size. Check the free disk space (`df -h ~`; on Windows, `Get-PSDrive`) against the total.
4. **Ask the User once.** Say which Model, its licence, and how many GB it will download, and pass on any warning that it will likely not fit, with the alternative the command suggests. Only after they agree, run the command with `--yes`, adding `--force` only if they insist on a Model that will likely not fit.
5. **Generate** with the Alias the install printed.

What to hand the User:

- **A download refused with HTTP 401 or 403.** Every file litevision installs is public, so this means the file has been gated since this release. Tell the User which file it was, and stop.
- **On a Mac, more GPU memory (optional).** If a Job fails for memory or swaps heavily, the User may run `sudo sysctl iogpu.wired_limit_mb=<MB>` themselves. Tell them the risk: leaving macOS too little memory can freeze the machine until it restarts. The setting resets at restart.
- **An `sd-server` the User runs themselves.** litevision starts and shares its own instead. Suggest the User keep only litevision's, and leave stopping or removing theirs to them.
