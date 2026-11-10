import { story } from "./story.ts";

export default { title: "Components/Native admin" };

export const NativeAdmin = { ...story("nativeAdmin"), name: "Available" };
export const NativeTablet = {
  ...story("nativeAdmin", {
    frameWidth: "768px",
    frameHeight: "1024px",
    instructions:
      "At 768 px, the sidebar stays visible and the Agent title has its own row. Check that the full name is readable and Open Agent UI still opens the fixture.",
  }),
  name: "Available on tablet",
};
export const NativeHostOnlyUnavailable = {
  ...story("nativeHostOnlyUnavailable"),
  name: "Host-only launch unavailable",
};
export const NativeStopped = { ...story("nativeStopped"), name: "Stopped" };
export const NativeUnsupported = { ...story("nativeUnsupported"), name: "Unsupported" };
export const NativeDenied = { ...story("nativeDenied"), name: "Denied and hidden" };
export const NativeRefreshing = { ...story("nativeRefreshing"), name: "Refreshing access" };
export const NativeAvailableAfterDeploy = {
  ...story("nativeAvailableAfterDeploy"),
  name: "Available once a deployment completes",
};

export const OperatorChat = { ...story("nativeOperatorChat"), name: "Operator chat" };
