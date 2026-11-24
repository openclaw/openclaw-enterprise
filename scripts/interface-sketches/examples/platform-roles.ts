import type { Diagram } from "../diagram.ts";

export default {
  title: "From a user’s task to a protected request",
  subtitle: "OpenClaw Enterprise (OCE) · selected-repository profile (github-repository)",
  layout: { board: [1180, 450] },
  groups: [
    { id: "oce", title: "OpenClaw Enterprise", role: "control", pin: [240, 82, 658, 310] },
    { id: "sandbox", title: "Sandbox", role: "boundary", parent: "oce", pin: [26, 52, 196, 116] },
    { id: "provider", title: "External service", role: "external", pin: [945, 134, 215, 116] },
  ],
  nodes: [
    {
      id: "user",
      title: "1   User",
      detail: "“Implement a feature and push a branch.”",
      pin: [20, 164, 175, 76],
    },
    {
      id: "agent",
      title: "2   Agent",
      detail: "Runs git push",
      group: "sandbox",
      pin: [14, 36, 168, 64],
    },
    {
      id: "proxy",
      title: "3   Credential Proxy",
      detail: "Holds the request",
      group: "oce",
      pin: [345, 88, 255, 64],
    },
    {
      id: "authority",
      title: "OCE control plane",
      detail: "Checks this Agent’s grant",
      group: "oce",
      pin: [345, 225, 255, 64],
    },
    {
      id: "github",
      title: "4   GitHub",
      detail: "Applies repository rules",
      group: "provider",
      pin: [12, 36, 191, 64],
    },
  ],
  edges: [
    { from: "user", to: "agent", label: "Task", pin: { label: [211, 191] } },
    { from: "agent", to: "proxy", label: "Git request", pin: { label: [478, 191] } },
    {
      from: "proxy",
      to: "authority",
      label: "May this Agent push?",
      pin: { from: "bottom", to: "top", label: [724, 273] },
    },
    {
      from: "proxy",
      to: "github",
      label: "Send with token\nonly on allow",
      kind: "conditional",
      pin: { label: [850, 175] },
    },
  ],
  notes: ["The credential stays outside the Agent’s sandbox. A denied request stops at the proxy."],
} satisfies Diagram;
