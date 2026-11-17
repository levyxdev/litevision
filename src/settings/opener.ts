import type { OpenBrowser } from "./browser.ts";
import { startSettingsServer, type SettingsServer, type SettingsServerOptions } from "./server.ts";

/** The settings page's tabs, each opened by its URL fragment. */
export const settingsTabs = ["providers", "models", "history"] as const;
export type SettingsTab = (typeof settingsTabs)[number];

export interface SettingsOpener {
  /** Opens the settings page in the User's browser, on `tab` when given, starting it unless one is already running. */
  open(tab?: SettingsTab): Promise<void>;
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
    async open(tab) {
      const { url } = await current();
      await options.openBrowser(tab === undefined ? url : `${url}#${tab}`);
    },
    async close() {
      const server = await running?.catch(() => undefined);
      await server?.close();
    },
  };
}
