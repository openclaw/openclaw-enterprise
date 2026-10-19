import { story } from "./story.mjs";

// Namespace rows are cards with toned status badges. Walk the shared badge and card patterns
// with badge-and-card-workflow.md.
export default { title: "Pages/Namespaces" };

export const Namespaces = { ...story("namespaces"), name: "Ready and provisioning" };
export const NamespacesEmpty = { ...story("namespacesEmpty"), name: "Empty" };
export const NamespacesDenied = { ...story("namespacesDenied"), name: "Access denied" };

export const NamespacesUnavailable = { ...story("namespacesUnavailable") };
export const NamespacesUnavailableMobile = { ...story("namespacesUnavailableMobile") };
export const NamespacesUnavailableEmpty = { ...story("namespacesUnavailableEmpty") };
