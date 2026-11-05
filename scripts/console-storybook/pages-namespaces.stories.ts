import { story } from "./story.ts";

// Namespace rows are cards with toned status badges. Walk the shared badge and card patterns
// with badge-and-card-workflow.md.
export default { title: "Pages/Namespaces" };

export const Namespaces = { ...story("namespaces"), name: "Ready and provisioning" };
export const NamespacesEmpty = { ...story("namespacesEmpty"), name: "Empty" };
export const NamespacesEmptyMember = { ...story("namespacesEmptyMember") };
export const NamespacesDenied = { ...story("namespacesDenied"), name: "Access denied" };
export const CreateNamespace = { ...story("namespaceCreate") };
export const CreateNamespaceMobile = { ...story("namespaceCreateMobile") };
export const CreateRequired = { ...story("namespaceCreateRequired") };
export const CreateInvalidName = { ...story("namespaceCreateInvalidName") };
export const CreateConflict = { ...story("namespaceCreateConflict") };
export const CreateDenied = { ...story("namespaceCreateDenied") };
export const CreateRefused = { ...story("namespaceCreateRefused") };
export const CreatePending = { ...story("namespaceCreatePending") };
export const CreateUnknown = { ...story("namespaceCreateUnknown") };
export const CreateSuccess = { ...story("namespaceCreateSuccess") };
export const CreateUnreadable = { ...story("namespaceCreateUnreadable") };

export const DeleteNamespace = { ...story("namespaceDelete") };
export const DeleteConfirmation = { ...story("namespaceDeleteConfirmation") };
export const DeleteMobile = { ...story("namespaceDeleteMobile") };
export const DeleteBlocked = { ...story("namespaceDeleteBlocked") };
export const DeleteDenied = { ...story("namespaceDeleteDenied") };
export const DeleteRestricted = { ...story("namespaceDeleteRestricted") };
export const DeleteRefused = { ...story("namespaceDeleteRefused") };
export const DeletePending = { ...story("namespaceDeletePending") };
export const DeleteUnknown = { ...story("namespaceDeleteUnknown") };
export const DeleteRetry = { ...story("namespaceDeleteRetry") };

export const NamespacesUnavailable = { ...story("namespacesUnavailable") };
export const NamespacesUnavailableMobile = { ...story("namespacesUnavailableMobile") };
export const NamespacesUnavailableEmpty = { ...story("namespacesUnavailableEmpty") };
