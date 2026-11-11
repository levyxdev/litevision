/**
 * The Alias the settings page fills in for a new Model until the User types their own: the model id made into a valid
 * Alias, after the Provider id. The same model on two Providers is two Models, and their model ids are easy to confuse
 * (`gemini-3.1-flash-image` on Gemini, `google/flash-image-3.1` on Together), so the Provider id tells them apart. A
 * model id that already starts with the Provider id gets no second one.
 *
 * The page embeds this function's source, so it must use nothing from outside its own body.
 */
export function suggestedAlias(providerId: string, modelId: string): string {
  const name = modelId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "");
  if (name === "") return "";
  const prefixed = providerId === "" || name.toLowerCase().startsWith(providerId.toLowerCase() + "-") ? name : providerId + "-" + name;
  return prefixed.slice(0, 64).replace(/-+$/, "");
}
