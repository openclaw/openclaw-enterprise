import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { SshCommand } from "./executor.ts";

type Host = Pick<
  SshCommand,
  "address" | "port" | "user" | "identityFile" | "knownHostsFile" | "connectTimeoutSeconds"
>;
type Target = { installationId: string; namespaceId: string; agentId: string; revisionId: string };

// The remote listener must live in a host-owned directory, terminate TLS and
// authenticate the revision. Never forward to the recyclable gateway TCP port.
export function browserSocketPath(target: Target) {
  const fields = [target.installationId, target.namespaceId, target.agentId, target.revisionId];
  if (!fields.every((field) => typeof field === "string" && field.trim()))
    throw new Error("Missing SSH browser target.");
  const hash = createHash("sha256").update(JSON.stringify(fields)).digest("hex");
  return `/run/occ-browser/${hash}.sock`;
}

export function browserForwardArgs(host: Host, target: Target, localPort: number): string[] {
  if (
    !Number.isSafeInteger(localPort) ||
    localPort < 1024 ||
    localPort > 65535 ||
    !isAbsolute(host.identityFile) ||
    !isAbsolute(host.knownHostsFile) ||
    !/^[A-Za-z0-9:.][A-Za-z0-9:.%-]*$/.test(host.address) ||
    !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(host.user) ||
    !Number.isSafeInteger(host.port) ||
    host.port < 1 ||
    host.port > 65535 ||
    !Number.isSafeInteger(host.connectTimeoutSeconds) ||
    host.connectTimeoutSeconds < 1
  )
    throw new Error("Invalid SSH browser forward.");
  return [
    "-F",
    "/dev/null",
    "-NT",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "GlobalKnownHostsFile=/dev/null",
    "-o",
    `UserKnownHostsFile=${host.knownHostsFile}`,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    `ConnectTimeout=${host.connectTimeoutSeconds}`,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    "-i",
    host.identityFile,
    "-p",
    String(host.port),
    "-l",
    host.user,
    "-L",
    `127.0.0.1:${localPort}:${browserSocketPath(target)}`,
    "--",
    host.address,
  ];
}
