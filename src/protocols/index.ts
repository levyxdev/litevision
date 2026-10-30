import { ConfigError, type Model } from "../config.ts";
import { gemini } from "./gemini.ts";
import { openaiImages } from "./openai-images.ts";
import type { ProtocolAdapter } from "./protocol.ts";

const adapters: Record<string, ProtocolAdapter> = {
  "openai-images": openaiImages,
  gemini,
};

/** The Protocols litevision supports, which a Model may use. */
export function supportedProtocols(): string[] {
  return Object.keys(adapters);
}

/** The adapter for a Protocol name, if litevision supports it. */
export function adapterForProtocol(protocol: string): ProtocolAdapter | undefined {
  return Object.hasOwn(adapters, protocol) ? adapters[protocol] : undefined;
}

export function adapterFor(model: Model): ProtocolAdapter {
  const adapter = adapterForProtocol(model.protocol);
  if (adapter === undefined) {
    throw new ConfigError(
      `Model "${model.alias}" uses Protocol "${model.protocol}", which litevision does not support. Supported Protocols: ${supportedProtocols().join(", ")}.`,
    );
  }
  return adapter;
}

/**
 * Test seam: makes `adapter` available as Protocol `name` until the returned function is called. Lets tests drive
 * shared behaviour (live capabilities, partial results) before every real Protocol has it.
 */
export function registerProtocol(name: string, adapter: ProtocolAdapter): () => void {
  if (Object.hasOwn(adapters, name)) throw new Error(`Protocol "${name}" is already registered.`);
  adapters[name] = adapter;
  return () => {
    delete adapters[name];
  };
}
