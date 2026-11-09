import type { ProtectedWorkspaceEndpoint } from "@openclaw-enterprise/contracts";
import { asRecord, hasControlCharacter } from "@openclaw-enterprise/utils";
import { posix } from "node:path";

export const PROTECTED_WORKSPACE_BINDING_ENV = "OPENCLAW_CODEX_REMOTE_WORKSPACE_BINDING";
export const PROTECTED_WORKSPACE_TRUST_DIRECTORY = "/etc/openclaw-box-owner";
export const PROTECTED_WORKSPACE_BINDING_FILE = "binding.json";
export const PROTECTED_WORKSPACE_CA_FILE = "ca.pem";

const SHA256 = /^[0-9a-f]{64}$/u;

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key))
  );
}

export function validProtectedWorkspaceEndpoint(
  value: unknown,
): value is ProtectedWorkspaceEndpoint {
  const endpoint = asRecord(value);
  if (!endpoint || !hasExactKeys(endpoint, ["url", "tls", "workspaceRoot", "original"])) {
    return false;
  }
  const tls = asRecord(endpoint.tls);
  const original = asRecord(endpoint.original);
  if (
    !tls ||
    !hasExactKeys(tls, ["caBundle"]) ||
    typeof tls.caBundle !== "string" ||
    !original ||
    original.purpose !== "normal-protected-codex-workspace" ||
    typeof original.generationSha256 !== "string" ||
    !SHA256.test(original.generationSha256) ||
    typeof endpoint.url !== "string" ||
    typeof endpoint.workspaceRoot !== "string" ||
    !posix.isAbsolute(endpoint.workspaceRoot) ||
    posix.resolve(endpoint.workspaceRoot) !== endpoint.workspaceRoot ||
    endpoint.workspaceRoot === "/" ||
    endpoint.workspaceRoot.trim() !== endpoint.workspaceRoot ||
    hasControlCharacter(endpoint.workspaceRoot)
  ) {
    return false;
  }
  const keys = ["purpose", "generationSha256", "state"];
  if (original.state === "reserved") {
    return hasExactKeys(original, keys);
  }
  return (
    original.state === "release-acknowledged" &&
    hasExactKeys(original, [...keys, "startupSha256"]) &&
    typeof original.startupSha256 === "string" &&
    SHA256.test(original.startupSha256)
  );
}

/** The release state may advance while the four values remain byte-identical. */
export function protectedWorkspaceTrustData(
  endpoint: ProtectedWorkspaceEndpoint,
): Readonly<Record<string, string>> {
  return {
    [PROTECTED_WORKSPACE_BINDING_FILE]: JSON.stringify({
      url: endpoint.url,
      workspaceRoot: endpoint.workspaceRoot,
      generationSha256: endpoint.original.generationSha256,
    }),
    [PROTECTED_WORKSPACE_CA_FILE]: endpoint.tls.caBundle,
  };
}
