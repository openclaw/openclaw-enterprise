import type { Diagram } from "../diagram.ts";

export default {
  title: "00 Protected requests in OCE",
  subtitle: "OpenClaw Enterprise · platform roles, with an optional Git authority binding",
  layout: { board: [1180, 640] },
  groups: [
    {
      id: "setup",
      title: "Setup · installed capabilities",
      role: "control",
      pin: [20, 80, 1140, 130],
    },
    { id: "worker", title: "OCE worker", role: "control", pin: [20, 290, 330, 250] },
    {
      id: "execution",
      title: "Execution · request path",
      role: "runtime",
      pin: [380, 290, 460, 250],
    },
    {
      id: "sandbox",
      title: "Workload boundary",
      role: "boundary",
      parent: "execution",
      pin: [15, 28, 235, 100],
    },
    { id: "upstream", title: "Upstream", role: "external", pin: [935, 290, 225, 250] },
  ],
  nodes: [
    {
      id: "compute",
      title: "ComputeDriver",
      detail: "Prepares and verifies execution",
      group: "setup",
      pin: [20, 40, 270, 55],
    },
    {
      id: "sandbox-driver",
      title: "SandboxDriver",
      detail: "Protected Git requires repositoryAccess",
      group: "setup",
      pin: [360, 40, 320, 55],
    },
    {
      id: "proxy",
      title: "CredentialProxyDriver",
      detail: "Can supply the Git transport adapter",
      group: "setup",
      pin: [740, 40, 370, 55],
    },
    {
      id: "authority",
      title: "Repository Git authority",
      detail: "ProtectedRepositoryGitAuthority\nChecks grant and requested operation",
      group: "worker",
      pin: [20, 40, 290, 75],
    },
    {
      id: "workload",
      title: "Agent workload",
      detail: "Attempts a protected request",
      group: "sandbox",
      pin: [10, 30, 215, 55],
    },
    {
      id: "sender",
      title: "Trusted sender",
      detail: "Enforces the selected profile\noutside the workload",
      group: "execution",
      pin: [200, 150, 240, 75],
    },
    {
      id: "provider",
      title: "Provider",
      detail: "Applies its own\naccess rules",
      group: "upstream",
      pin: [15, 150, 190, 75],
    },
  ],
  edges: [
    {
      from: "authority",
      to: "proxy",
      label:
        "For protected Git, the worker supplies the authority\nCredentialProxyDriver.bindRepositoryGit(authority)",
      kind: "setup",
      pin: {
        from: "top",
        to: "bottom",
        via: [
          [185, 235],
          [945, 235],
        ],
        label: [355, 257],
      },
    },
    {
      from: "workload",
      to: "sender",
      label: "Attempt\nrequest",
      pin: { from: "right", to: "top", via: [[700, 375.5]], label: [720, 383] },
    },
    {
      from: "sender",
      to: "authority",
      label: "Authorize this\nGit request",
      pin: { from: "left", to: "bottom", via: [[185, 477.5]], label: [212, 450] },
    },
    {
      from: "sender",
      to: "provider",
      label: "Send if\nallowed",
      kind: "conditional",
      pin: { from: "right", to: "left", label: [856, 450] },
    },
  ],
  notes: [
    "OpenShell implements the GitHub App installation preview. Its online allow decision leaves dispatch and provider delivery unconfirmed.",
    "Strands/Box has separate sandbox and provider-call prototypes. Protected Git requires its own binding and verification.",
  ],
} satisfies Diagram;
