import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export interface RuntimeAuditReplayFields {
  revisionId: string;
  source: string;
  endpoint: string;
  body: string;
}

const privatePrefix = Buffer.from("302e020100300506032b657004220420", "hex");
const publicPrefix = Buffer.from("302a300506032b6570032100", "hex");

function privateKey(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, "base64url").length !== 32) {
    throw new Error("Invalid runtime audit credential.");
  }
  // Use the full credential with a separate domain. The stored SHA-256 token digest
  // must not be sufficient to sign a new observation.
  const seed = createHash("sha256").update("oce-runtime-audit-ed25519-v1\0").update(token).digest();
  return createPrivateKey({
    key: Buffer.concat([privatePrefix, seed]),
    format: "der",
    type: "pkcs8",
  });
}

function publicBytes(key: ReturnType<typeof privateKey>): Buffer {
  const der = createPublicKey(key).export({ format: "der", type: "spki" });
  return der.subarray(publicPrefix.length);
}

function signedBytes(fields: RuntimeAuditReplayFields): Buffer {
  return Buffer.from(
    JSON.stringify([
      "oce-runtime-audit-v1",
      fields.revisionId,
      fields.source,
      fields.endpoint,
      fields.body,
    ]),
    "utf8",
  );
}

export function runtimeAuditReplayVerifier(token: string): string {
  return publicBytes(privateKey(token)).toString("base64url");
}

export function createRuntimeAuditReplaySigner(
  token: string,
): (fields: RuntimeAuditReplayFields) => { verifier: string; signature: string } {
  const key = privateKey(token);
  const verifier = publicBytes(key).toString("base64url");
  return (fields) => ({
    verifier,
    signature: sign(null, signedBytes(fields), key).toString("base64url"),
  });
}

export function verifyRuntimeAuditReplay(
  fields: RuntimeAuditReplayFields,
  verifier: string,
  signature: string,
): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(verifier) || !/^[A-Za-z0-9_-]{86}$/.test(signature)) {
    return false;
  }
  try {
    const rawPublic = Buffer.from(verifier, "base64url");
    const rawSignature = Buffer.from(signature, "base64url");
    if (
      rawPublic.length !== 32 ||
      rawSignature.length !== 64 ||
      rawPublic.toString("base64url") !== verifier ||
      rawSignature.toString("base64url") !== signature
    ) {
      return false;
    }
    const key = createPublicKey({
      key: Buffer.concat([publicPrefix, rawPublic]),
      format: "der",
      type: "spki",
    });
    return verify(null, signedBytes(fields), key, rawSignature);
  } catch {
    return false;
  }
}
