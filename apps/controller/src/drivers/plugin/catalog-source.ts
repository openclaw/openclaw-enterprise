// Shared by standalone profile rendering and controller startup without runtime imports.
export function isCodexCatalogSource(value: unknown): value is "hosted" | "openai-curated" {
  return value === "hosted" || value === "openai-curated";
}
