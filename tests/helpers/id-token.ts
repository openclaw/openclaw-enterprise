import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

// RSA signing keys published as JWKs, and compact JWS tokens whose header, payload, key and
// digest a test can each choose independently. Used by the ID-token verifier tests and by
// the sign-in fixtures in google-sign-in.ts, human-login-transport.ts, and oidc-provider.ts.

export function rsaSigningKey(kid: string, modulusLength = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength });
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" },
  };
}

export function encodeSegment(value: unknown): string {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString(
    "base64url",
  );
}

interface IdTokenSigningOptions {
  header?: Record<string, unknown>;
  key?: KeyObject;
  algorithm?: string;
}

// Returns token(payload, options): RS256 with `signingKey` named by its kid unless the
// options replace the header, the private key or the digest.
export function idTokenSigner(signingKey: ReturnType<typeof rsaSigningKey>) {
  return (
    payload: unknown,
    {
      header = { alg: "RS256", kid: signingKey.kid, typ: "JWT" },
      key = signingKey.privateKey,
      algorithm = "sha256",
    }: IdTokenSigningOptions = {},
  ): string => {
    const input = `${encodeSegment(header)}.${encodeSegment(payload)}`;
    return `${input}.${sign(algorithm, Buffer.from(input), key).toString("base64url")}`;
  };
}
