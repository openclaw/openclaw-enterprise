import { story } from "./story.ts";

export default { title: "Components/Stop Agent" };

export const Confirmation = story("stopConfirm");
export const Pending = story("stopPending");
export const Requested = story("stopRequested");
export const DeletionDiscovered = story("stopReadDiscoversDeletion");
export const RepeatConfirmation = story("stopRepeatConfirm");
export const NoSelectedVersion = story("stopNoSelection");
export const NeverDeployed = story("stopNeverDeployed");
export const RepeatUnknown = story("stopRepeatUnknown");
export const Denied = story("stopDenied");
export const Unknown = story("stopUnknown");
export const PermissionDuringConfirmation = story("stopPermissionDuringConfirmation");
