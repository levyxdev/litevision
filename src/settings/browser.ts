import { spawn } from "node:child_process";

/** Opens a URL in the User's default browser. Tests inject a stand-in instead. */
export type OpenBrowser = (url: string) => Promise<void>;

export const openInBrowser: OpenBrowser = (url) => {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? // `start` is a cmd built-in; its first quoted argument is the window title.
          ["cmd", ["/c", "start", '""', url]]
        : ["xdg-open", [url]];
  return new Promise((resolve, reject) => {
    // Detached and silent: stdout may be carrying the MCP protocol.
    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsVerbatimArguments: process.platform === "win32" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
};
