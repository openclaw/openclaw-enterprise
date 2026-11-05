import type { Diagram } from "../diagram.ts";

export default {
  title: "Who sends a protected request?",
  subtitle:
    "Generic exchange · OpenClaw Control Plane authorizes · the runtime sender connects to the provider",
  layout: { board: [1180, 640] },
  groups: [
    { id: "api", title: "Controller API process", role: "control", pin: [20, 80, 475, 460] },
    { id: "runtime", title: "Selected runtime", role: "runtime", pin: [815, 80, 345, 348] },
    {
      id: "sender",
      title: "Trusted sender",
      parent: "runtime",
      role: "runtime",
      pin: [15, 150, 315, 183],
    },
    { id: "origin", title: "Provider", role: "external", pin: [815, 458, 345, 82] },
  ],
  nodes: [
    {
      id: "static",
      title: "SecretDriver",
      detail: "Reads a versioned secret",
      group: "api",
      pin: [20, 45, 205, 56],
    },
    {
      id: "warm",
      title: "PreparedTokenIssuer",
      detail: "Eligible prepared token",
      group: "api",
      pin: [250, 45, 205, 56],
    },
    {
      id: "exchange",
      title: "OCC exchange authority",
      detail: "Resolves material, permits sends, protects replies",
      group: "api",
      pin: [50, 170, 375, 60],
    },
    {
      id: "listener",
      title: "OpenShell exchange listener",
      detail: "Authenticates the exchange stream",
      group: "api",
      pin: [50, 297, 375, 60],
    },
    { id: "agent", title: "Agent in sandbox", group: "runtime", pin: [35, 40, 275, 42] },
    {
      id: "capture",
      title: "Capture the request",
      detail: "Record the original caller",
      group: "sender",
      pin: [20, 35, 275, 55],
    },
    {
      id: "dispatch",
      title: "Send and hold the reply",
      detail: "Owns upstream TLS and reply delivery",
      group: "sender",
      pin: [20, 112, 275, 55],
    },
    { id: "provider", title: "External API", group: "origin", pin: [35, 30, 275, 40] },
  ],
  edges: [
    {
      from: "exchange",
      to: "static",
      label: "readCredentialInput",
      kind: "conditional",
      pin: {
        from: "top",
        to: "bottom",
        via: [
          [257.5, 222],
          [142.5, 222],
        ],
        label: [46, 208],
      },
    },
    {
      from: "exchange",
      to: "warm",
      label: "readWarm",
      kind: "conditional",
      pin: {
        from: "top",
        to: "bottom",
        via: [
          [257.5, 222],
          [372.5, 222],
        ],
        label: [382, 208],
      },
    },
    {
      from: "listener",
      to: "exchange",
      label: "Calls five exchange methods",
      pin: { from: "top", to: "bottom", label: [267, 348] },
    },
    {
      from: "agent",
      to: "capture",
      label: "Provider request",
      pin: { from: "bottom", to: "top", label: [998, 199] },
    },
    {
      from: "capture",
      to: "listener",
      label: "Resolve and authorize\nthe captured request",
      pin: {
        from: "left",
        to: "right",
        via: [
          [640, 292.5],
          [640, 407],
        ],
        label: [520, 309],
      },
    },
    {
      from: "capture",
      to: "dispatch",
      label: "Wait for permit",
      pin: { from: "bottom", to: "top", label: [998, 334] },
    },
    {
      from: "dispatch",
      to: "listener",
      label: "Check the held reply",
      pin: {
        from: "left",
        to: "right",
        via: [
          [690, 369.5],
          [690, 407],
        ],
        label: [523, 369],
      },
    },
    {
      from: "listener",
      to: "dispatch",
      label: "Headers if needed, then send permit\nReturns only the approved reply",
      pin: {
        from: "bottom",
        to: "right",
        via: [
          [257.5, 493],
          [785, 493],
          [785, 418],
          [1142, 418],
          [1142, 369.5],
        ],
        label: [507, 456],
      },
    },
    {
      from: "dispatch",
      to: "provider",
      label: "Authorized HTTPS request",
      kind: "conditional",
      pin: { from: "bottom", to: "top", label: [995, 445] },
    },
  ],
  notes: [
    "At API startup, the selected Driver can bind the exchange to OCC. A route that uses no credential skips both material readers.",
    "The sender releases the approved reply to the original caller. Stock OpenShell lacks this sender guarantee. Git requests use a separate worker path.",
  ],
} satisfies Diagram;
