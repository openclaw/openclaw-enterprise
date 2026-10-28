import type { Diagram } from "../diagram.ts";

export default {
  title: "02 Who sends a protected request?",
  subtitle:
    "Generic exchange · configured OCC API and OpenShell listener · the stock supervisor lacks a qualified exact sender",
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
      detail: "Versioned static value",
      group: "api",
      pin: [20, 45, 205, 56],
    },
    {
      id: "warm",
      title: "PreparedTokenIssuer",
      detail: "Eligible warm token",
      group: "api",
      pin: [250, 45, 205, 56],
    },
    {
      id: "exchange",
      title: "OCC exchange authority",
      detail: "CredentialProxy class · checks use, send and reply",
      group: "api",
      pin: [50, 170, 375, 60],
    },
    {
      id: "listener",
      title: "Driver-owned exchange listener",
      detail: "OpenShell adapter · authenticates the stream",
      group: "api",
      pin: [50, 297, 375, 60],
    },
    { id: "agent", title: "Agent in sandbox", group: "runtime", pin: [35, 40, 275, 42] },
    {
      id: "capture",
      title: "Capture request and hold reply",
      group: "sender",
      pin: [20, 35, 275, 42],
    },
    {
      id: "dispatch",
      title: "Enforce the decision",
      detail: "Own upstream TLS and reply delivery",
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
      label: "Five bound methods",
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
      label: "Captured request / held response",
      pin: {
        from: "left",
        to: "right",
        via: [
          [640, 286],
          [640, 407],
        ],
        label: [517, 307],
      },
    },
    {
      from: "listener",
      to: "dispatch",
      label: "Credential headers when needed,\nsend permit / protected response",
      pin: {
        from: "bottom",
        to: "left",
        via: [
          [257.5, 493],
          [763, 493],
          [763, 369.5],
        ],
        label: [509, 447],
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
    "At API startup, the selected CredentialProxyDriver can bind its transport owner to OCC. A credential-free route skips both material readers.",
    "The runtime sender must forward only the permitted request and release only the protected reply. The observed Git hook uses a separate worker path (01).",
  ],
} satisfies Diagram;
