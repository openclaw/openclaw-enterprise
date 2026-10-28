import type { Diagram } from "../diagram.ts";

export default {
  title: "01 Protected Git request",
  subtitle: "OpenShell reference implementation · GitHub App installation preview · setup in 01b",
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
      title: "OpenShell data plane",
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
      detail: "OpenShell supervisor",
      group: "openshell",
      pin: [60, 165, 320, 55],
    },
    {
      id: "adapter",
      title: "Git transport adapter",
      detail: "Verifies caller identity and binding.\nClassifies the HTTP request.",
      group: "worker",
      pin: [30, 155, 340, 75],
    },
    {
      id: "owner",
      title: "Prepared Git owner",
      detail: "Restricted worker authority\nobservedHook.authorize",
      group: "worker",
      pin: [30, 325, 340, 75],
    },
    {
      id: "github",
      title: "GitHub",
      detail: "Checks repository membership,\npermissions and branch rules.",
      group: "internet",
      pin: [60, 27, 320, 75],
    },
  ],
  edges: [
    {
      from: "agent",
      to: "supervisor",
      label: "Attempt git push",
      pin: { from: "bottom", to: "top", label: [955, 223] },
    },
    {
      from: "supervisor",
      to: "adapter",
      label: "EvaluateHttpRequest\nbefore injection",
      pin: { from: "left", to: "right", label: [477, 248] },
    },
    {
      from: "adapter",
      to: "owner",
      label: "Get local decision",
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
      label: "Return allow or deny",
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
      label: "Inject token and forward\nif allowed",
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
    "Before allow: worker rechecks recipient and loaded generation via Gateway status, without fetching a token.",
    "Preview: allow does not prove delivery; one denial does not prove every request uses the hook. No OCE per-ref filter.\nThe bundled Driver refuses repository-scoped Git; no native sender fallback.",
  ],
} satisfies Diagram;
