import type { Diagram } from "../diagram.ts";

export default {
  title: "01 What happens when the Agent runs git push?",
  subtitle: "Request path in the OpenShell reference implementation · token setup is shown in 01b",
  layout: { board: [1180, 640] },
  groups: [
    {
      id: "worker",
      title: "OCE worker · control plane",
      role: "control",
      pin: [20, 80, 410, 420],
    },
    {
      id: "openshell",
      title: "Execution environment",
      role: "runtime",
      pin: [720, 80, 440, 270],
    },
    {
      id: "sandbox",
      title: "Sandbox",
      role: "boundary",
      parent: "openshell",
      pin: [60, 35, 320, 80],
    },
    {
      id: "internet",
      title: "Internet",
      role: "external",
      pin: [720, 390, 440, 110],
    },
  ],
  nodes: [
    { id: "agent", title: "Agent", group: "sandbox", pin: [70, 30, 180, 40] },
    {
      id: "supervisor",
      title: "Credential Proxy",
      detail: "Holds the outgoing GitHub request",
      group: "openshell",
      pin: [60, 165, 320, 55],
    },
    {
      id: "adapter",
      title: "Git transport adapter",
      detail: "Authenticates the caller and checks the\nrequest, binding and loaded generation",
      group: "worker",
      pin: [30, 155, 340, 75],
    },
    {
      id: "owner",
      title: "Repository Git authority",
      detail: "Checks the Agent’s grant for\nthis repository and operation",
      group: "worker",
      pin: [30, 325, 340, 75],
    },
    {
      id: "github",
      title: "GitHub",
      detail: "Enforces installation token permissions\nand GitHub branch rules",
      group: "internet",
      pin: [60, 27, 320, 75],
    },
  ],
  edges: [
    {
      from: "agent",
      to: "supervisor",
      label: "1  git push",
      pin: { from: "bottom", to: "top", label: [955, 223] },
    },
    {
      from: "supervisor",
      to: "adapter",
      label: "2  Ask about this request\nEvaluateHttpRequest",
      pin: { from: "left", to: "right", label: [477, 248] },
    },
    {
      from: "adapter",
      to: "owner",
      label: "3  Check the grant",
      pin: {
        from: "left",
        to: "left",
        via: [
          [35, 272.5],
          [35, 442.5],
        ],
        label: [43, 366],
      },
    },
    {
      from: "adapter",
      to: "supervisor",
      label: "4  Return allow or deny",
      pin: {
        from: "bottom",
        to: "bottom",
        via: [
          [220, 335],
          [940, 335],
        ],
        label: [477, 325],
      },
    },
    {
      from: "supervisor",
      to: "github",
      label: "5  On allow, add the\ntoken and send",
      kind: "conditional",
      pin: {
        from: "right",
        to: "right",
        via: [
          [1140, 272.5],
          [1140, 454.5],
        ],
        label: [976, 367],
      },
    },
  ],
  notes: [
    "github-repository restricts access to selected repositories. GitHub governs refs. Explicit git-write checks the pushed ref in OCE.",
    "github-installation uses the App installation’s scope and requires opt-in. An allow leaves exact dispatch and delivery unconfirmed.",
  ],
} satisfies Diagram;
