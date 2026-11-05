import type { Diagram } from "../diagram.ts";

export default {
  title: "03 Proposed Git credential pull",
  subtitle:
    "Design under discussion · authorize each protected request, including requests that reuse a token",
  layout: { board: [1180, 640] },
  groups: [
    { id: "oce", title: "OCE worker · control plane", role: "control", pin: [20, 80, 435, 430] },
    { id: "runtime", title: "Execution environment", role: "runtime", pin: [730, 80, 430, 345] },
    {
      id: "sandbox",
      title: "Sandbox",
      parent: "runtime",
      role: "boundary",
      pin: [55, 34, 315, 85],
    },
    { id: "internet", title: "Upstream", role: "external", pin: [730, 455, 430, 85] },
  ],
  nodes: [
    { id: "agent", title: "Agent", group: "sandbox", pin: [40, 32, 235, 40] },
    {
      id: "sender",
      title: "Credential Proxy",
      detail: "Check local allowlist on every request",
      group: "runtime",
      pin: [40, 146, 350, 58],
    },
    {
      id: "cache",
      title: "In-memory token cache",
      detail: "Scoped to this execution and grant",
      group: "runtime",
      pin: [45, 264, 245, 65],
    },
    {
      id: "precheck",
      title: "Authorize before release",
      detail: "Proposed check for an empty cache",
      group: "oce",
      pin: [35, 75, 345, 58],
    },
    {
      id: "material",
      title: "Prepared Git material",
      detail: "readMaterial for the verified recipient",
      group: "oce",
      pin: [35, 179, 345, 58],
    },
    {
      id: "authorize",
      title: "RepositoryGitAuthority.authorize",
      detail: "Match request, recipient and installed version",
      group: "oce",
      pin: [35, 321, 345, 68],
    },
    { id: "github", title: "GitHub", group: "internet", pin: [65, 30, 300, 40] },
  ],
  edges: [
    {
      from: "agent",
      to: "sender",
      label: "1  Git request",
      pin: { from: "bottom", to: "top", label: [957, 219] },
    },
    {
      from: "sender",
      to: "cache",
      label: "Look up bound token",
      pin: {
        from: "bottom",
        to: "top",
        via: [
          [945, 319],
          [897.5, 319],
        ],
        label: [953, 326],
      },
    },
    {
      from: "sender",
      to: "precheck",
      label: "2  Cache miss: check this operation",
      kind: "conditional",
      pin: {
        from: "left",
        to: "right",
        via: [
          [580, 255],
          [580, 184],
        ],
        label: [468, 168],
      },
    },
    {
      from: "precheck",
      to: "material",
      label: "Only after approval",
      pin: { from: "bottom", to: "top", label: [235, 241] },
    },
    {
      from: "material",
      to: "cache",
      label: "3  Release scoped token on miss",
      kind: "conditional",
      pin: {
        from: "right",
        to: "left",
        via: [
          [605, 288],
          [605, 376.5],
        ],
        label: [470, 319],
      },
    },
    {
      from: "sender",
      to: "authorize",
      label: "4  Fresh decision on hit or miss",
      pin: {
        from: "left",
        to: "right",
        via: [
          [707, 255],
          [707, 435],
        ],
        label: [467, 428],
      },
    },
    {
      from: "sender",
      to: "github",
      label: "5  Inject and send\nonly on allow",
      kind: "conditional",
      pin: {
        from: "right",
        to: "right",
        via: [
          [1141, 255],
          [1141, 505],
        ],
        label: [1029, 389],
      },
    },
  ],
  notes: [
    "OCE derives the credential from the execution binding. The proxy cannot name an arbitrary Secret.",
    "Open question: how does the proxy prove which version it installed after a cold pull? The final authorization needs that evidence.",
  ],
} satisfies Diagram;
