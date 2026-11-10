import { isIP } from "node:net";

import { ConfigurationValidationError } from "@openclaw-enterprise/contracts";
import type { AgentRevision, OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord, immutableCopy } from "@openclaw-enterprise/utils";

import { AGENT_POLICY_PREFIX } from "./openshell-policy.ts";

// These are the two native entrypoints shipped by the qualified bundled Codex release.
const CODEX_BINARIES = new Set([
  "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.164.0-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex",
  "/app/node_modules/openclaw/node_modules/.pnpm/@openai+codex@0.164.0-linux-arm64/node_modules/@openai/codex/vendor/aarch64-unknown-linux-musl/bin/codex",
]);

function refuse(): never {
  throw new ConfigurationValidationError([
    {
      path: "/policy/codexArtifactRuleNames",
      code: "INVALID_VALUE",
      message:
        "Protected Codex artifacts require the exact declared credential-free, inspected, read-only rules.",
    },
  ]);
}

function exactKeys(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const record = asRecord(value);
  if (
    !record ||
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key))
  ) {
    refuse();
  }
  return record;
}

function ruleName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.startsWith(AGENT_POLICY_PREFIX) &&
    !name.startsWith("oce-egress-") &&
    !name.startsWith("_provider_") &&
    ![
      "workspace-node-enrollment",
      "oce-prepared-git",
      "__proto__",
      "constructor",
      "prototype",
    ].includes(name)
  );
}

function literalArtifactHost(value: unknown): boolean {
  if (
    typeof value !== "string" ||
    value.length > 253 ||
    isIP(value) !== 0 ||
    value === "github.com" ||
    value.endsWith(".github.com")
  ) {
    return false;
  }
  const labels = value.split(".");
  if (
    labels.length < 2 ||
    !/[a-z]/.test(value) ||
    !labels.every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  ) {
    return false;
  }
  try {
    // URL consumers canonicalize hexadecimal and abbreviated IPv4 aliases to addresses.
    return new URL(`https://${value}`).hostname === value;
  } catch {
    return false;
  }
}

/** Validate the complete closed wire form, including data rehydrated from persistence. */
function qualifiedMap(value: unknown): Readonly<OpenClawConfigurationDocument> {
  const map = asRecord(value);
  if (!map) {
    refuse();
  }
  for (const [name, value] of Object.entries(map)) {
    if (!ruleName(name)) {
      refuse();
    }
    const rule = exactKeys(value, ["name", "binaries", "endpoints"]);
    if (
      rule.name !== name ||
      !Array.isArray(rule.binaries) ||
      rule.binaries.length === 0 ||
      !Array.isArray(rule.endpoints) ||
      rule.endpoints.length === 0
    ) {
      refuse();
    }
    const paths = new Set<string>();
    for (const value of rule.binaries) {
      const binary = exactKeys(value, ["path"]);
      if (
        typeof binary.path !== "string" ||
        !CODEX_BINARIES.has(binary.path) ||
        paths.has(binary.path)
      ) {
        refuse();
      }
      paths.add(binary.path);
    }
    const hosts = new Set<string>();
    for (const value of rule.endpoints) {
      // Stock 0.1.6 REST uses verified auto TLS inspection when tls is omitted;
      // explicit terminate is unsupported, and skip would remove inspection.
      const endpoint = exactKeys(value, ["host", "ports", "protocol", "enforcement", "access"]);
      if (
        !literalArtifactHost(endpoint.host) ||
        hosts.has(endpoint.host as string) ||
        !Array.isArray(endpoint.ports) ||
        endpoint.ports.length !== 1 ||
        endpoint.ports[0] !== 443 ||
        endpoint.protocol !== "rest" ||
        endpoint.enforcement !== "NETWORK_ENFORCEMENT_MODE_ENFORCE" ||
        endpoint.access !== "NETWORK_ACCESS_PRESET_READ_ONLY"
      ) {
        refuse();
      }
      hosts.add(endpoint.host as string);
    }
  }
  return immutableCopy(map as OpenClawConfigurationDocument);
}

/** Sandbox selects only explicitly declared Installation rules; ambient defaults stay outside. */
export function qualifyOpenShellCodexArtifactRules(
  defaults: Readonly<OpenClawConfigurationDocument>,
  names: readonly string[],
): Readonly<OpenClawConfigurationDocument> {
  if (
    !Array.isArray(names) ||
    new Set(names).size !== names.length ||
    names.some(
      (name) => typeof name !== "string" || !ruleName(name) || !Object.hasOwn(defaults, name),
    )
  ) {
    refuse();
  }
  return qualifiedMap(Object.fromEntries(names.map((name) => [name, defaults[name]!])));
}

/** Both paired compilers consume immutable admission, never current Installation defaults. */
export function openShellProtectedCodexArtifacts(
  revision: Readonly<AgentRevision> | undefined,
): Readonly<OpenClawConfigurationDocument> {
  const snapshot = revision?.sandboxPolicy;
  if (snapshot === undefined) {
    return {};
  }
  exactKeys(snapshot, ["driverId", "implementation", "version", "defaults", "additions"]);
  if (
    revision?.executionAdmission.mode !== "protected" ||
    revision.harness.id !== "codex" ||
    revision.harness.mode !== "dedicated" ||
    !revision.egressPlan?.repositoryGit ||
    revision.repositoryCredentials === undefined ||
    !Array.isArray(revision.repositoryCredentials.bindings) ||
    revision.repositoryCredentials.bindings.length === 0 ||
    typeof snapshot.driverId !== "string" ||
    snapshot.driverId.length === 0 ||
    snapshot.driverId !== revision.sandboxDriverId ||
    snapshot.driverId !== revision.egressPlan.sandboxDriverId ||
    snapshot.implementation !== "openshell" ||
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 1 ||
    !Array.isArray(snapshot.additions) ||
    snapshot.additions.length !== 0
  ) {
    refuse();
  }
  return qualifiedMap(snapshot.defaults);
}
