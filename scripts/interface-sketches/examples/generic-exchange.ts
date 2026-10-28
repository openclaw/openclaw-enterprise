import type { Diagram } from "../diagram.ts";

export default {
  title: "02 Generic protected exchange",
  subtitle: "Exact-exchange contract · stock OpenShell lacks a qualified exact sender",
  groups: [
    { id: "control", title: "OCE control plane", role: "control" },
    {
      id: "installed-driver",
      title: "One InstalledDriver · OpenShell backend",
      role: "control",
      parent: "control",
    },
    { id: "runtime", title: "Data plane", role: "runtime" },
    { id: "sandbox", title: "Sandbox", role: "boundary", parent: "runtime" },
    { id: "provider", title: "Internet", role: "external" },
  ],
  nodes: [
    {
      id: "compute-driver",
      title: "ComputeDriver",
      detail: "Kubernetes Compute",
      group: "control",
    },
    { id: "sandbox-driver", title: "SandboxDriver", group: "installed-driver" },
    {
      id: "credential-proxy-driver",
      title: "CredentialProxyDriver",
      detail: "Supplies transport owner",
      group: "installed-driver",
    },
    {
      id: "request-authority",
      title: "OCC request authority",
      detail: "Policy · use record · send decision",
      group: "control",
    },
    {
      id: "credential-proxy",
      title: "CredentialProxy",
      detail: "Implements CredentialProxyExchange",
      group: "control",
    },
    { id: "secret-driver", title: "SecretDriver", group: "control" },
    { id: "token-issuer", title: "PreparedTokenIssuer", group: "control" },
    { id: "versioned-secret", title: "Versioned Secret", group: "control" },
    { id: "prepared-material", title: "Prepared material", group: "control" },
    { id: "agent", title: "Agent", group: "sandbox" },
    {
      id: "trusted-sender",
      title: "Trusted sender",
      detail: "Required for exact dispatch",
      group: "runtime",
    },
    { id: "external-api", title: "External API", group: "provider" },
  ],
  edges: [
    {
      from: "compute-driver",
      to: "sandbox-driver",
      label: "Uses paired owner",
      kind: "setup",
    },
    {
      from: "credential-proxy-driver",
      to: "credential-proxy",
      label: "bindExchange",
      kind: "setup",
    },
    { from: "agent", to: "trusted-sender", label: "Requests provider operation" },
    {
      from: "trusted-sender",
      to: "credential-proxy",
      label: "Calls exchange via listener",
    },
    { from: "credential-proxy", to: "request-authority", label: "Checks send authority" },
    {
      from: "credential-proxy",
      to: "secret-driver",
      label: "readCredentialInput",
      kind: "conditional",
    },
    {
      from: "credential-proxy",
      to: "token-issuer",
      label: "readWarm",
      kind: "conditional",
    },
    { from: "secret-driver", to: "versioned-secret", label: "Reads version" },
    { from: "token-issuer", to: "prepared-material", label: "Reads token" },
    {
      from: "trusted-sender",
      to: "external-api",
      label: "Injects and forwards if approved",
      kind: "conditional",
    },
  ],
  notes: [
    "OCC constructs the proxy and exposes only five bound methods to the listener: resolve, authorizeSend, beginResponse, renewResponse, and protectResponse.",
    "Credential-free routes skip both material readers. The observed Git hook is shown in 01 and 01b.",
  ],
} satisfies Diagram;
