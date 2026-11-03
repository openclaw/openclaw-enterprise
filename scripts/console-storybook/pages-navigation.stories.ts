import { story } from "./story.ts";

export default { title: "Pages/Navigation" };

export const NotFound = { ...story("notFound"), name: "Page not found" };
export const RuntimeImages = { ...story("runtimeImages"), name: "Debug runtime images" };
export const RuntimeImagesUnavailable = {
  ...story("runtimeImagesUnavailable"),
  name: "Debug metadata unavailable",
};

export const FirstVisits = { ...story("navigationFirstVisit") };
export const RetryOpeningAnAgent = { ...story("navigationAgentReadRetry") };
export const ReturnToLoadedPages = { ...story("navigationRetained") };
export const SlowRechecks = { ...story("navigationSlowRecheck") };
export const ReturnAccessDenied = { ...story("navigationDenied") };
export const ReturnSessionExpired = { ...story("navigationExpired") };
export const RefreshWhileOffline = { ...story("navigationOffline") };

export const ReturnBackendAccessDenied = { ...story("navigationBackendDenied") };

export const ReturnToAgentPanels = { ...story("navigationAgentReturn") };
