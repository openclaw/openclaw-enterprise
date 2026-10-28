import type { Diagram } from "../diagram.ts";

export default {
  title: "01 OpenShell Git request",
  subtitle: "GitHub App installation preview",
  groups: [
    { id: "worker", title: "OCE worker (control plane)", role: "control" },
    { id: "openshell", title: "OpenShell data plane", role: "runtime" },
    { id: "sandbox", title: "Sandbox", role: "boundary", parent: "openshell" },
    { id: "internet", title: "Internet", role: "external" },
  ],
  nodes: [
    { id: "agent", title: "Agent", group: "sandbox" },
    {
      id: "supervisor",
      title: "Credential Proxy",
      detail: "OpenShell supervisor",
      group: "openshell",
    },
    {
      id: "adapter",
      title: "OpenShell Git transport adapter",
      detail: "Checks identity and binding. Classifies the HTTP request.",
      group: "worker",
    },
    {
      id: "owner",
      title: "Prepared Git owner",
      detail: "Restricted worker authority · observedHook.authorize",
      group: "worker",
    },
    {
      id: "github",
      title: "GitHub",
      detail: "Checks repository membership, permissions and branch rules.",
      group: "internet",
    },
  ],
  edges: [
    { from: "agent", to: "supervisor", label: "Attempt git push" },
    { from: "supervisor", to: "adapter", label: "EvaluateHttpRequest before injection" },
    { from: "adapter", to: "owner", label: "Get local decision" },
    { from: "adapter", to: "supervisor", label: "Return allow or deny" },
    {
      from: "supervisor",
      to: "github",
      label: "Inject token and forward if allowed",
      kind: "conditional",
    },
  ],
  // Keep the hook and its reply together across the worker boundary.
  layout: { direction: "RIGHT" },
  notes: [
    "Before allowing the request, the worker rechecks the recipient and loaded generation via Gateway status without fetching a token. For credential setup, see 01b.",
    "An allow does not confirm delivery to GitHub. One observed denial does not establish that every request uses the hook.",
    "OCE adds no per-ref filter. The bundled Driver refuses repository-scoped Git and has no native sender fallback.",
  ],
} satisfies Diagram;
