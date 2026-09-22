import { story } from "./story.mjs";

export default { title: "Pages/Providers" };

export const Providers = { ...story("providers"), name: "Configured" };
export const ProvidersEmpty = { ...story("providersEmpty"), name: "Empty" };
export const ProvidersError = { ...story("providersError"), name: "Discovery unavailable" };
