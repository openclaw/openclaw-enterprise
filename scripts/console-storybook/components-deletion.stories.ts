import { story } from "./story.ts";

export default { title: "Components/Deletion" };

export const DeletionConfirm = { ...story("deletionConfirm"), name: "Confirmation" };
export const Deleting = { ...story("deleting"), name: "Cleanup in progress" };
export const DeletionProgressPhone = {
  ...story("deleting", { frameWidth: "390px" }),
  name: "Cleanup in progress (phone)",
};
export const DeletionDenied = { ...story("deletionDenied"), name: "Permission denied" };
export const DeletionConflict = { ...story("deletionConflict"), name: "Conflict" };
export const DeletionUnknown = { ...story("deletionUnknown"), name: "Outcome unknown" };

export const WaitingForCleanup = story("deletionWaiting");
export const RetryFailedCleanup = story("deletionRetryConfirm");
export const StatusAccessEnded = story("deletionStatusUnavailable");
export const PermissionDuringConfirmation = story("deletionPermissionDuringConfirmation");
