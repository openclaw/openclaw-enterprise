import { createHash } from "node:crypto";

export function githubProviderOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password) {
    throw new Error("invalid-endpoint");
  }
  return url.origin;
}

/** Installation supplies the canonical HTTPS origin and a parsed public CA bundle.
 * Bind the trust policy, independent of PEM ordering, rather than a rotating leaf certificate. */
export function preparationIssuerAuthority(origin: string, ca?: Uint8Array): string {
  if (!ca) {
    return origin + "#default-https-trust";
  }
  const certificates = Buffer.from(ca)
    .toString()
    .split(/(?<=-----END CERTIFICATE-----)/)
    .map((cert) => cert.trim())
    .filter(Boolean);
  const bundle = [...new Set(certificates)].sort().join("\n");
  return origin + "#ca-sha256=" + createHash("sha256").update(bundle).digest("hex");
}
