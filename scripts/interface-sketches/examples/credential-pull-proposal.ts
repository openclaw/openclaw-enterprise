import type { Diagram } from "../diagram.ts";

export default {
  title: "Proposed Git credential pull",
  subtitle: "Design discussion · both cache paths require a fresh decision before the proxy sends",
  layout: { board: [1180, 640] },
  groups: [
    { id: "oce", title: "OCE worker", role: "control", pin: [20, 80, 385, 405] },
    { id: "runtime", title: "Execution environment", role: "runtime", pin: [680, 80, 480, 405] },
    {
      id: "sandbox",
      title: "Sandbox",
      role: "boundary",
      parent: "runtime",
      pin: [18, 32, 165, 92],
    },
    { id: "internet", title: "Upstream", role: "external", pin: [680, 505, 480, 78] },
  ],
  nodes: [
    { id: "agent", title: "Agent", group: "sandbox", pin: [10, 33, 145, 40] },
    {
      id: "proxy",
      title: "Credential Proxy",
      detail: "Apply the local allowlist",
      group: "runtime",
      pin: [237, 57, 215, 58],
    },
    {
      id: "cache",
      title: "Token cache",
      detail: "This execution and grant",
      group: "runtime",
      pin: [237, 145, 215, 58],
    },
    {
      id: "release",
      title: "Check before release",
      detail: "Verify this operation and recipient",
      group: "oce",
      pin: [25, 145, 325, 58],
    },
    {
      id: "version",
      title: "Bind the installed version",
      detail: "Held request and verified recipient",
      group: "runtime",
      pin: [80, 251, 290, 60],
    },
    {
      id: "authorize",
      title: "RepositoryGitAuthority.authorize",
      detail: "Check the request and installed version",
      group: "oce",
      pin: [25, 252, 325, 60],
    },
    {
      id: "send",
      title: "Credential Proxy",
      detail: "Inject the token and send",
      group: "runtime",
      pin: [80, 332, 290, 58],
    },
    { id: "github", title: "GitHub", group: "internet", pin: [80, 25, 290, 40] },
  ],
  edges: [
    { from: "agent", to: "proxy", label: "Git", pin: { label: [882, 151] } },
    {
      from: "proxy",
      to: "cache",
      label: "Listed destination",
      pin: { from: "bottom", to: "top", label: [863, 217] },
    },
    {
      from: "cache",
      to: "release",
      label: "Miss · check before release",
      pin: { label: [472, 248] },
    },
    {
      from: "cache",
      to: "version",
      label: "Hit · reuse scoped token",
      pin: {
        from: "bottom",
        to: "top",
        via: [
          [1024.5, 304],
          [905, 304],
        ],
        label: [938, 326],
      },
    },
    {
      from: "release",
      to: "version",
      label: "If allowed, install the scoped token",
      pin: {
        from: "bottom",
        to: "top",
        via: [
          [207.5, 294],
          [800, 294],
          [800, 319],
          [905, 319],
        ],
        label: [470, 287],
      },
    },
    {
      from: "version",
      to: "authorize",
      label: "Hit or miss · authorize this request",
      pin: { label: [450, 352] },
    },
    {
      from: "authorize",
      to: "send",
      label: "Only on allow",
      kind: "conditional",
      pin: { from: "bottom", to: "left", via: [[207.5, 441]], label: [500, 431] },
    },
    {
      from: "send",
      to: "github",
      label: "HTTPS",
      pin: { from: "bottom", to: "top", label: [922, 500] },
    },
  ],
  notes: [
    "Open question: how does OCE verify the installed version after the first pull, before granting permission to send?",
  ],
} satisfies Diagram;
