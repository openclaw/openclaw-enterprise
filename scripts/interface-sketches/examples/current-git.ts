import type { Diagram } from "../diagram.ts";

export default {
  title: "What happens when the Agent runs git push?",
  subtitle: "Selected-repository profile (github-repository) · OpenShell reference implementation",
  layout: { board: [1180, 474] },
  groups: [
    {
      id: "openshell",
      title: "OpenShell runtime",
      role: "runtime",
      pin: [20, 80, 725, 152],
    },
    {
      id: "sandbox",
      title: "Sandbox",
      role: "boundary",
      parent: "openshell",
      pin: [18, 33, 248, 104],
    },
    {
      id: "worker",
      title: "OpenClaw Enterprise worker",
      role: "control",
      pin: [330, 275, 830, 120],
    },
    {
      id: "internet",
      title: "External service",
      role: "external",
      pin: [930, 111, 230, 112],
    },
  ],
  nodes: [
    { id: "agent", title: "Agent", group: "sandbox", pin: [14, 34, 220, 56] },
    {
      id: "supervisor",
      title: "Credential Proxy",
      detail: "Holds the outgoing GitHub request",
      group: "openshell",
      pin: [445, 67, 270, 56],
    },
    {
      id: "adapter",
      title: "Git transport adapter",
      detail: "Authenticates caller. Checks request,\nbinding and loaded generation",
      group: "worker",
      pin: [120, 33, 300, 75],
    },
    {
      id: "owner",
      title: "Repository Git authority",
      detail: "Checks the Agent’s grant for this\nrepository and operation",
      group: "worker",
      pin: [562, 33, 248, 75],
    },
    {
      id: "github",
      title: "GitHub",
      detail: "Enforces token permissions\nand GitHub branch rules",
      group: "internet",
      pin: [12, 26, 206, 76],
    },
  ],
  edges: [
    {
      from: "agent",
      to: "supervisor",
      label: "git push",
      pin: { label: [327, 164] },
    },
    {
      from: "supervisor",
      to: "github",
      label: "On allow, add the token\nand send the request",
      kind: "conditional",
      pin: { label: [763, 146] },
    },
    {
      from: "supervisor",
      to: "adapter",
      label: "EvaluateHttpRequest\nAsk for allow or deny",
      pin: { from: "bottom", to: "top", label: [615, 250] },
    },
    {
      from: "adapter",
      to: "owner",
      label: "Check the grant",
      pin: { label: [765, 335] },
    },
  ],
  notes: [
    "github-repository restricts access to selected repositories. GitHub governs refs. Explicit git-write checks the pushed ref in OCE.",
    "An allow authorizes this request. Read back the ref at GitHub to confirm that the push succeeded.",
  ],
} satisfies Diagram;
