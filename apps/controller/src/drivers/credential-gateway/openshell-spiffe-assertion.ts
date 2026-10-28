import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { asRecord } from "@openclaw-enterprise/utils";
import { parseUnambiguousJson } from "../repo/credentials/json-members.ts";

interface AssertionPolicy {
  readonly assertionAudience: string;
  readonly issuer?: string;
  readonly algorithm: "RS256" | "ES256" | "EdDSA";
}

export interface OpenShellSpiffeTrust extends AssertionPolicy {
  readonly keyId: string;
  readonly publicKey: string | Buffer;
}

export interface OpenShellSpiffeBundleTrust extends AssertionPolicy {
  /** SPIFFE bundles omit the domain. The operator binds the exact published object to this domain. */
  readonly trustDomain: string;
}

function assertionKeys(
  trust: OpenShellSpiffeTrust | (OpenShellSpiffeBundleTrust & { readonly bundle: string }),
): Map<string, KeyObject> {
  if ("publicKey" in trust) {
    return new Map([[trust.keyId, createPublicKey(trust.publicKey)]]);
  }
  if (Buffer.byteLength(trust.bundle) > 65_536) {
    throw new Error("SPIFFE bundle exceeds 64 KiB.");
  }
  const keys = asRecord(parseUnambiguousJson(trust.bundle))?.keys;
  if (!Array.isArray(keys) || keys.length > 32) {
    throw new Error("Invalid SPIFFE bundle keys.");
  }
  const jwt = new Map<string, KeyObject>();
  for (const entry of keys) {
    const jwk = asRecord(entry);
    // SPIFFE Trust Domain and Bundle §4.2.2: other uses (normally x509-svid) are not JWT trust.
    if (jwk?.use !== "jwt-svid") {
      continue;
    }
    if (
      typeof jwk.kid !== "string" ||
      !/^[A-Za-z0-9._-]{1,256}$/.test(jwk.kid) ||
      jwt.has(jwk.kid) ||
      (jwk.alg !== undefined && jwk.alg !== trust.algorithm) ||
      Object.keys(jwk).some(
        (k) => !["use", "kid", "alg", "kty", "crv", "x", "y", "e", "n"].includes(k),
      )
    ) {
      throw new Error("Invalid SPIFFE JWT authority.");
    }
    const key = createPublicKey({ key: jwk, format: "jwk" });
    // OpenSSL accepts some malformed base64url values. Trust only a canonical public JWK.
    const fields = key.export({ format: "jwk" });
    if (Object.entries(fields).some(([name, value]) => jwk[name] !== value)) {
      throw new Error("Malformed SPIFFE JWT public key.");
    }
    jwt.set(jwk.kid, key);
  }
  return jwt;
}

/** Operator-pinned JWT-SVID trust. A verified subject still requires a live runtime mapping. */
export class OpenShellSpiffeAssertionVerifier {
  private readonly keys: Map<string, KeyObject>;
  private readonly trust: AssertionPolicy;
  private readonly domain: string | undefined;

  constructor(
    trust: OpenShellSpiffeTrust | (OpenShellSpiffeBundleTrust & { readonly bundle: string }),
  ) {
    this.keys = assertionKeys(trust);
    if (
      new URL(trust.assertionAudience).protocol !== "https:" ||
      (trust.issuer !== undefined && new URL(trust.issuer).protocol !== "https:") ||
      !["RS256", "ES256", "EdDSA"].includes(trust.algorithm)
    ) {
      throw new Error("Invalid operator SPIFFE trust.");
    }
    for (const [id, key] of this.keys) {
      if (
        !id ||
        (trust.algorithm === "RS256" &&
          (key.asymmetricKeyType !== "rsa" ||
            (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)) ||
        (trust.algorithm === "ES256" &&
          (key.asymmetricKeyType !== "ec" ||
            key.asymmetricKeyDetails?.namedCurve !== "prime256v1")) ||
        (trust.algorithm === "EdDSA" && key.asymmetricKeyType !== "ed25519")
      ) {
        throw new Error("Invalid operator SPIFFE trust key.");
      }
    }
    this.domain = "trustDomain" in trust ? trust.trustDomain : undefined;
    this.trust = trust;
  }

  /** Narrow an in-flight verification, including when a publisher replaces a key under the same ID. */
  retainKeysFrom(bundle: OpenShellSpiffeAssertionVerifier): void {
    for (const [id, key] of this.keys) {
      if (!bundle.keys.get(id)?.equals(key)) {
        this.keys.delete(id);
      }
    }
  }

  verify(assertion: string): string | undefined {
    try {
      const parts = assertion.split(".");
      if (
        assertion.length > 8192 ||
        parts.length !== 3 ||
        parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
      ) {
        return undefined;
      }
      const header = parseUnambiguousJson(
        Buffer.from(parts[0]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const claims = parseUnambiguousJson(
        Buffer.from(parts[1]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const now = Date.now() / 1000;
      const key = typeof header?.kid === "string" && this.keys.get(header.kid);
      if (
        !header ||
        !claims ||
        header.jku ||
        header.jwk ||
        header.x5u ||
        header.crit ||
        header.alg !== this.trust.algorithm ||
        !key ||
        (this.trust.issuer !== undefined && claims.iss !== this.trust.issuer) ||
        !(
          claims.aud === this.trust.assertionAudience ||
          (Array.isArray(claims.aud) &&
            claims.aud.length === 1 &&
            claims.aud[0] === this.trust.assertionAudience)
        ) ||
        typeof claims.sub !== "string" ||
        typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= now ||
        claims.exp > now + 300 ||
        (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now)) ||
        (claims.iat !== undefined && (typeof claims.iat !== "number" || claims.iat > now)) ||
        !verify(
          this.trust.algorithm === "EdDSA" ? null : "sha256",
          Buffer.from(parts.slice(0, 2).join(".")),
          { key, dsaEncoding: "ieee-p1363" },
          Buffer.from(parts[2]!, "base64url"),
        )
      ) {
        return undefined;
      }
      const subject = new URL(claims.sub);
      return subject.protocol === "spiffe:" &&
        subject.hostname &&
        (this.domain === undefined || subject.host === this.domain) &&
        !subject.username &&
        !subject.password &&
        !subject.search &&
        !subject.hash
        ? claims.sub
        : undefined;
    } catch {
      return undefined;
    }
  }
}
