import { generateKeyPairSync, sign } from "node:crypto";

// RSA signing keys published as JWKs, and compact JWS tokens whose header, payload, key and
// digest a test can each choose independently. Used by the ID-token verifier tests and by
// the fake Google and OIDC providers in human-login-transport.mjs and production-sign-in.mjs.

export function rsaSigningKey(kid, modulusLength = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength });
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" },
  };
}

export function encodeSegment(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString(
    "base64url",
  );
}

// Returns token(payload, options): RS256 with `signingKey` named by its kid unless the
// options replace the header, the private key or the digest.
export function idTokenSigner(signingKey) {
  return (
    payload,
    {
      header = { alg: "RS256", kid: signingKey.kid, typ: "JWT" },
      key = signingKey.privateKey,
      algorithm = "sha256",
    } = {},
  ) => {
    const input = `${encodeSegment(header)}.${encodeSegment(payload)}`;
    return `${input}.${sign(algorithm, Buffer.from(input), key).toString("base64url")}`;
  };
}
