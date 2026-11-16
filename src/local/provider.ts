/**
 * What makes a Provider or Model local. The local Provider has no address, as litevision starts the Runtime itself
 * (ADR 0014), and no Credential; only `local install` adds it and its Models.
 */

export const localProviderId = "local";

/** The Protocol local Models speak: stable-diffusion.cpp's sd-server. */
export const localProtocol = "sdcpp";

/** A Model on the local Provider or its Protocol: one only `local install` sets up. */
export const isLocalModel = (model: { provider?: unknown; protocol?: unknown }) => model.provider === localProviderId || model.protocol === localProtocol;

/** Why the settings page adds no local Provider or Model. */
export const addedOnlyByInstall = "Local Models, and the local Provider, are added only by `npx -y litevision local install <model>`.";
