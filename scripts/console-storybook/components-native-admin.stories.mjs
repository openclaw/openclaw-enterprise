import { story } from "./story.mjs";

export default { title: "Components/Native admin" };

export const NativeAdmin = { ...story("nativeAdmin"), name: "Available" };
export const NativeStopped = { ...story("nativeStopped"), name: "Stopped" };
export const NativeUnsupported = { ...story("nativeUnsupported"), name: "Unsupported" };
export const NativeDenied = { ...story("nativeDenied"), name: "Denied and hidden" };

export const NativeReadError = { ...story("nativeReadError"), name: "Status read failure" };
export const NativeReadRecovery = { ...story("nativeReadRecovery"), name: "Recovery on Back" };

export const UiConfigurationRequired = {
  ...story("nativeUiConfiguration"),
  name: "UI Configuration Required",
};
export const AssignedRoleMissing = {
  ...story("nativeRoleUnavailable"),
  name: "Assigned Role Missing",
};
export const PairingPermissionsRequired = {
  ...story("nativeDeviceApproval"),
  name: "Pairing Permissions Required",
};
