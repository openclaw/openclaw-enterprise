import { createHash, randomUUID, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { StrandsBoxOptions } from "../../backends/strands-box.ts";
import type { Resource } from "./kubernetes.ts";

const lifetimeSeconds = 1800;
const renewBeforeMs = 5 * 60_000;
/** Let the existing active-revision maintenance owner reconcile well inside the bearer renewal margin. */
export const strandsExecutionMaintenanceIntervalMs = 120_000;

type Issuer = Pick<StrandsBoxOptions, "issuerPrivateKeyPath" | "issuer" | "keyId" | "audience">;
type Observation = {
  sandboxId: string;
  instanceId: string;
  peerKeyId: string;
  bearerSha256: string;
};

/**
 * Management reconciliation only, after proving the live sender. Replace the exact Secret and then
 * wait for the signed projection commitment. The request path cannot issue or rotate an identity.
 */
export async function reconcileStrandsExecutionBearer(
  identity: Resource,
  observation: Observation,
  issuer: Issuer,
  replace: (secret: Resource) => Promise<unknown>,
  now = Date.now(),
) {
  const { sandboxId, instanceId, peerKeyId } = observation;
  const previous = Buffer.from(identity.data?.bearer ?? "", "base64").toString();
  const claims = JSON.parse(Buffer.from(previous.split(".")[1] ?? "e30=", "base64url").toString());
  if (
    claims.exp * 1000 > now + renewBeforeMs &&
    claims.instance_id === instanceId &&
    claims.sandbox_id === sandboxId &&
    claims.exchange_key?.x === peerKeyId
  ) {
    const bearerSha256 = createHash("sha256").update(previous).digest("hex");
    return observation.bearerSha256 === bearerSha256
      ? { bearerSha256, expiresAt: String(claims.exp * 1000), peerKeyId, instanceId }
      : undefined; // Wait for that same instance's signed acknowledgement; don't issue another JWT.
  }

  if (!identity.metadata.uid || !identity.metadata.resourceVersion) {
    throw new Error(
      "Strands identity replacement requires the exact observed execution Secret version.",
    );
  }
  const { issuer: iss, audience: aud, keyId: kid } = issuer;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "EdDSA", typ: "openshell-ext+jwt", kid });
  const iat = Math.floor(now / 1000);
  const body = encode({
    iss,
    aud,
    iat,
    exp: iat + lifetimeSeconds,
    jti: randomUUID(),
    sub: "spiffe://openshell/sandbox/" + sandboxId,
    caller_kind: "supervisor",
    sandbox_id: sandboxId,
    instance_id: instanceId,
    exchange_key: { profile: "openshell-exchange-v1", kty: "OKP", crv: "Ed25519", x: peerKeyId },
  });
  const bytes = Buffer.from(header + "." + body);
  const key = readFileSync(issuer.issuerPrivateKeyPath);
  let jwt: string;
  try {
    jwt = bytes.toString() + "." + sign(null, bytes, key).toString("base64url");
  } finally {
    key.fill(0);
  }
  await replace({ ...identity, data: { bearer: Buffer.from(jwt).toString("base64") } });
  return undefined;
}
