import { story } from "./story.mjs";

export default { title: "Components/Deletion" };

export const DeletionConfirm = { ...story("deletionConfirm"), name: "Confirmation" };
export const Deleting = { ...story("deleting"), name: "Cleanup in progress" };
export const DeletionDenied = { ...story("deletionDenied"), name: "Permission denied" };
export const DeletionConflict = { ...story("deletionConflict"), name: "Conflict" };
export const DeletionUnknown = { ...story("deletionUnknown"), name: "Outcome unknown" };
