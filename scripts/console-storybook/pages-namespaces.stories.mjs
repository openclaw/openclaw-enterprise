import { story } from "./story.mjs";

export default { title: "Pages/Namespaces" };

export const Namespaces = { ...story("namespaces"), name: "Ready and provisioning" };
export const NamespacesEmpty = { ...story("namespacesEmpty"), name: "Empty" };
export const NamespacesDenied = { ...story("namespacesDenied"), name: "Access denied" };
