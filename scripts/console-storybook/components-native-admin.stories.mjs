import { story } from "./story.mjs";

export default { title: "Components/Native admin" };

export const NativeAdmin = { ...story("nativeAdmin"), name: "Available" };
export const NativeStopped = { ...story("nativeStopped"), name: "Stopped" };
export const NativeUnsupported = { ...story("nativeUnsupported"), name: "Unsupported" };
export const NativeDenied = { ...story("nativeDenied"), name: "Denied and hidden" };
