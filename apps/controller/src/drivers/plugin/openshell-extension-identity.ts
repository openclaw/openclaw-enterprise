import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { asRecord } from "@openclaw-enterprise/utils";

export interface OpenShellExtensionIdentityOptions {
  readonly issuer: string;
  readonly audience: string;
  readonly keyId: string;
  readonly publicKey: string | Buffer;
}

/** Verifies gateway-signed extension JWTs; callers must enforce the required identity kind. */
export class OpenShellExtensionJwtVerifier {
  private readonly key: KeyObject;
  private readonly options: OpenShellExtensionIdentityOptions;

  constructor(options: OpenShellExtensionIdentityOptions) {
    this.options = options;
    this.key = createPublicKey(options.publicKey);
    if (
      this.key.asymmetricKeyType !== "ed25519" ||
      !options.issuer ||
      !options.audience ||
      !options.keyId
    ) {
      throw new Error("Invalid OpenShell extension identity configuration.");
    }
  }

  verify(authorization: string): Record<string, unknown> | undefined {
    if (!authorization.startsWith("Bearer ") || authorization.length > 8192) {
      return undefined;
    }
    const token = authorization.slice(7);
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
      return undefined;
    }
    try {
      const header = asRecord(JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")));
      if (
        !header ||
        header.alg !== "EdDSA" ||
        header.typ !== "openshell-ext+jwt" ||
        header.kid !== this.options.keyId ||
        header.crit !== undefined ||
        !verify(
          null,
          Buffer.from(`${parts[0]}.${parts[1]}`),
          this.key,
          Buffer.from(parts[2]!, "base64url"),
        )
      ) {
        return undefined;
      }
      const claims = asRecord(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
      const now = Math.floor(Date.now() / 1000);
      if (
        !claims ||
        claims.iss !== this.options.issuer ||
        claims.aud !== this.options.audience ||
        typeof claims.iat !== "number" ||
        !Number.isSafeInteger(claims.iat) ||
        typeof claims.exp !== "number" ||
        !Number.isSafeInteger(claims.exp) ||
        claims.iat > now + 5 ||
        claims.exp <= now ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > 3600 ||
        typeof claims.jti !== "string" ||
        claims.jti.length === 0
      ) {
        return undefined;
      }
      return claims;
    } catch {
      return undefined;
    }
  }
}
