import type { ModelAuthCatalogProvider } from "@openclaw-enterprise/contracts";

// Static authentication mappings checked against the bundled OpenClaw 2026.9.1 runtime.
export const MODEL_AUTH_CATALOG: readonly ModelAuthCatalogProvider[] = [
  {
    id: "openai",
    label: "OpenAI",
    requiresBaseUrl: false,
    authMethods: [{ id: "api-key", label: "API key", credentialKind: "secret" }],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    requiresBaseUrl: false,
    authMethods: [{ id: "api-key", label: "API key", credentialKind: "secret" }],
  },
  {
    id: "ollama",
    label: "Ollama",
    requiresBaseUrl: true,
    authMethods: [{ id: "local", label: "Local server", credentialKind: "none" }],
  },
  {
    id: "vllm",
    label: "vLLM",
    requiresBaseUrl: true,
    authMethods: [{ id: "custom", label: "Self-hosted server", credentialKind: "secret" }],
  },
];
