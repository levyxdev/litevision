import type { OpenBrowser } from "./browser.ts";
import { startSettingsServer, type SettingsServer, type SettingsServerOptions } from "./server.ts";

export interface SettingsOpener {
  /** Opens the settings page in the User's browser, starting it unless one is already running. */
  open(): Promise<void>;
  /** Shuts down the running settings page, if any. */
  close(): Promise<void>;
}

/** Keeps at most one settings page running, and starts a fresh one after it shut down when idle. */
export function settingsOpener(options: SettingsServerOptions & { openBrowser: OpenBrowser }): SettingsOpener {
  let running: Promise<SettingsServer> | undefined;

  function current(): Promise<SettingsServer> {
    if (running === undefined) {
      const starting = startSettingsServer(options);
      running = starting;
      starting.then(
        (server) => server.closed.then(() => {
          if (running === starting) running = undefined;
        }),
        () => {
          if (running === starting) running = undefined;
        },
      );
    }
    return running;
  }

  return {
    async open() {
      await options.openBrowser((await current()).url);
    },
    async close() {
      const server = await running?.catch(() => undefined);
      await server?.close();
    },
  };
}
