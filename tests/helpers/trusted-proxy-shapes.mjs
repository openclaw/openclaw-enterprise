// Gateway trusted-proxy settings the Gateway refuses at startup, so Kubernetes Compute refuses them
// at preparation, deploy admission and Configuration save (findings 3006, 3032). The driver
// conformance test sends every shape; the HTTP tests send the `*_SAMPLE` shapes through the real
// API. The expected texts are KUBERNETES_ALLOW_USERS_REFUSAL and
// KUBERNETES_DEVICE_AUTO_APPROVE_REFUSAL in refusal-text.mjs.

// allowUsers values the API tests send: the machine identity left out, a case-duplicate e-mail
// identity (the Gateway resolves "@" grants case-insensitively), and an empty list, which admits
// every proxy user upstream. The first one also names a human, so a response that echoed the
// submitted list would show it.
export const INVALID_ALLOW_USERS_SAMPLE = [
  ["oidc:member-01"],
  ["occ-workspace-files", "member@example.com", "Member@Example.com"],
  [],
];

// Every refused allowlist: the sample plus duplicates, case variants that spoof the machine
// identity, identities a proxy header cannot carry exactly, and object property names.
export const INVALID_ALLOW_USERS = [
  ...INVALID_ALLOW_USERS_SAMPLE,
  ["occ-workspace-files", " "],
  null,
  ["occ-workspace-files", "oidc:member-01", "oidc:member-01"],
  ["occ-workspace-files", "occ-workspace-files"],
  ["occ-workspace-files", "OCC-Workspace-Files"],
  ["occ-workspace-files", "oidc:m\u00e9mber-01"],
  ["occ-workspace-files", "oidc:member\u200b-01"],
  ["occ-workspace-files", "oidc:member\u0000-01"],
  ["occ-workspace-files", "oidc:member\t01"],
  ["occ-workspace-files", 42],
  ["occ-workspace-files", "constructor"],
  ["occ-workspace-files", "__proto__"],
];

// deviceAutoApprove values the API tests send: scopes as text, a text enabled, and an unknown key.
export const INVALID_DEVICE_AUTO_APPROVE_SAMPLE = [
  { enabled: true, scopes: "operator.read" },
  { enabled: "true" },
  { enabled: true, approvers: ["oidc:member-01"] },
];

// Every refused device auto-approval: the sample plus values that are not an object, an admin scope
// as text (a text value would skip the human admin-scope check), and blank or non-text scopes.
export const INVALID_DEVICE_AUTO_APPROVE = [
  ...INVALID_DEVICE_AUTO_APPROVE_SAMPLE,
  "operator.admin",
  null,
  ["operator.read"],
  { enabled: true, scopes: "operator.admin" },
  { enabled: true, scopes: [""] },
  { enabled: true, scopes: ["operator.read", 42] },
  { enabled: true, extra: true },
];

// Device auto-approvals the Gateway accepts: each optional field alone, an empty scope list, and
// both fields with a non-admin scope.
export const ACCEPTED_DEVICE_AUTO_APPROVE = [
  {},
  { enabled: false },
  { scopes: [] },
  { enabled: true, scopes: ["operator.read"] },
];
