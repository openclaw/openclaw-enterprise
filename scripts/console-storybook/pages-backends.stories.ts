import { story } from "./story.ts";

export default { title: "Pages/Backends" };

export const Backends = { ...story("backends"), name: "Configured" };
export const BackendsEmpty = { ...story("backendsEmpty"), name: "Empty" };
export const BackendsError = { ...story("backendsError"), name: "Discovery unavailable" };
export const BackendsDenied = { ...story("backendsDenied"), name: "Access denied" };
