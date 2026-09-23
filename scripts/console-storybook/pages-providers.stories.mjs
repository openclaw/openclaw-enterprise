import { story } from "./story.mjs";

export default { title: "Pages/Providers" };

export const Providers = { ...story("providers"), name: "Configured" };
export const ProvidersEmpty = { ...story("providersEmpty"), name: "Empty" };
export const ProvidersError = { ...story("providersError"), name: "Discovery unavailable" };
export const ProvidersAnthropic = { ...story("providersAnthropic"), name: "Anthropic API key" };
export const ProvidersWithoutStorage = {
  ...story("providersWithoutStorage"),
  name: "Credential storage not configured",
};
export const ProvidersExistingSecret = {
  ...story("providersExistingSecret"),
  name: "Existing Secret",
};
export const ProvidersLocal = { ...story("providersLocal"), name: "Local server" };
export const ProvidersVllm = { ...story("providersVllm"), name: "Self-hosted server" };
