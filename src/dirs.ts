import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Where litevision keeps configuration, Job history and generated files. */
export interface Dirs {
  /** Holds `config.json`, `credentials.json`, `jobs.jsonl` and `capabilities.json`. */
  home: string;
  /** Default output folder; each Job saves under a dated subfolder. */
  output: string;
}

/** `~/.litevision`, or `LITEVISION_HOME` when set, on every system; see docs/adr/0013. */
export function defaultDirs(home = homedir(), env = process.env): Dirs {
  return {
    home: env.LITEVISION_HOME ? resolve(env.LITEVISION_HOME) : join(home, ".litevision"),
    output: join(home, "litevision", "outputs"),
  };
}
