import { homedir } from "node:os";
import { join } from "node:path";

/** Where litevision keeps configuration, Job history and generated files. */
export interface Dirs {
  /** Holds `config.json` and `credentials.json`. */
  config: string;
  /** Holds `jobs.jsonl`. */
  data: string;
  /** Default output folder; each Job saves under a dated subfolder. */
  output: string;
}

export function defaultDirs(home = homedir()): Dirs {
  return {
    config: join(home, ".config", "litevision"),
    data: join(home, ".local", "share", "litevision"),
    output: join(home, "litevision", "outputs"),
  };
}
