import { story } from "./story.ts";

export default { title: "Components/Native admin" };

export const NativeAdmin = { ...story("nativeAdmin"), name: "Available" };
export const NativeRecovery = {
  ...story("nativeRecovery"),
  name: "Unreadable Agent recovery",
};
export const NativeRecoveryDenied = {
  ...story("nativeRecoveryDenied"),
  name: "Recovery access revoked",
};
export const NativeStopped = { ...story("nativeStopped"), name: "Stopped" };
export const NativeUnsupported = { ...story("nativeUnsupported"), name: "Unsupported" };
export const NativeDenied = { ...story("nativeDenied"), name: "Denied and hidden" };
export const NativeRefreshing = { ...story("nativeRefreshing"), name: "Refreshing access" };
export const NativeAvailableAfterDeploy = {
  ...story("nativeAvailableAfterDeploy"),
  name: "Available once a deployment completes",
};
