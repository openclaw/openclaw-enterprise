import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import type {
  ExecFileSyncOptions,
  ExecFileSyncOptionsWithBufferEncoding,
  ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { createHash } from "node:crypto";

import { field } from "./metadata.ts";

export function skopeo(args: string[], options?: ExecFileSyncOptionsWithBufferEncoding): Buffer;
export function skopeo(args: string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function skopeo(args: string[], options?: ExecFileSyncOptions): Buffer | string;
export function skopeo(args: string[], options: ExecFileSyncOptions = {}): Buffer | string {
  return execFileSync("skopeo", args, { maxBuffer: 16 * 1024 * 1024, ...options });
}

export function skopeoLogin(
  registry: string,
  authfile: string,
  username: string | undefined,
  token: string | undefined,
) {
  assert.ok(username !== undefined, "A registry username is required.");
  skopeo(["login", "--authfile", authfile, "--username", username, "--password-stdin", registry], {
    ...(token === undefined ? {} : { input: token }),
    stdio: ["pipe", "ignore", "pipe"],
  });
}

export function inspectDigest(reference: string, authfile?: string) {
  const bytes = skopeo([
    "inspect",
    ...(authfile ? ["--authfile", authfile] : []),
    "--raw",
    reference,
  ]);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function remoteTagDigest(image: string, tag: string, authfile?: string, listed?: boolean) {
  try {
    return inspectDigest(`docker://${image}:${tag}`, authfile);
  } catch (error) {
    // Skopeo 1.13.3 reports the registry's MANIFEST_UNKNOWN as this terminal
    // diagnostic. Auth, transport, name and ambiguous failures must not copy.
    const missing = `reading manifest ${tag} in ${image}: manifest unknown`;
    const stderr = field(error, "stderr");
    const diagnostic =
      typeof stderr === "string" || Buffer.isBuffer(stderr)
        ? stderr.toString().trim().replace(/"$/, "")
        : undefined;
    if (
      listed ||
      field(error, "status") !== 1 ||
      (diagnostic !== missing &&
        !diagnostic?.endsWith(`: ${missing}`) &&
        !diagnostic?.endsWith(`${missing}: manifest unknown`))
    ) {
      throw error;
    }
    return null;
  }
}
