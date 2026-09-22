import { story } from "./story.mjs";

export default { title: "Pages/Agents" };

export const Agents = { ...story("agents"), name: "Populated" };
export const AgentsEmpty = { ...story("agentsEmpty"), name: "Empty" };
export const AgentsSearch = { ...story("agentsSearch"), name: "No search matches" };
export const NoNamespaces = { ...story("noNamespaces"), name: "No readable Namespaces" };
export const NamespaceMissing = { ...story("namespaceMissing"), name: "Namespace unavailable" };
export const AgentsDenied = { ...story("agentsDenied"), name: "Access denied" };
export const AgentsError = { ...story("agentsError"), name: "Read failure" };
export const AgentsLoading = { ...story("agentsLoading"), name: "Loading" };
