import { ConfigError, type Model } from "../config.ts";
import { openaiImages } from "./openai-images.ts";
import type { ProtocolAdapter } from "./protocol.ts";

const adapters: Record<string, ProtocolAdapter> = {
  "openai-images": openaiImages,
};

export function adapterFor(model: Model): ProtocolAdapter {
  const adapter = adapters[model.protocol];
  if (adapter === undefined) {
    throw new ConfigError(
      `Model "${model.alias}" uses Protocol "${model.protocol}", which litevision does not support. Supported Protocols: ${Object.keys(adapters).join(", ")}.`,
    );
  }
  return adapter;
}
