import { X509Certificate } from "node:crypto";

const BEGIN_CERTIFICATE = "-----BEGIN CERTIFICATE-----";
const END_CERTIFICATE = "-----END CERTIFICATE-----";

/** Accept public CA certificates only, before projecting trust into a workload. */
export function publicCaBundle(value: string): string {
  if (typeof value !== "string") {
    throw new Error("TLS trust must contain only PEM CA certificates.");
  }
  const certificates: string[] = [];
  let offset = 0;
  // Consume disjoint blocks once; never retry an unterminated block at later BEGIN markers.
  while (offset < value.length) {
    if (value.charAt(offset).trim() === "") {
      offset++;
      continue;
    }
    if (!value.startsWith(BEGIN_CERTIFICATE, offset)) {
      throw new Error("TLS trust must contain only PEM CA certificates.");
    }
    const end = value.indexOf(END_CERTIFICATE, offset + BEGIN_CERTIFICATE.length);
    if (end === -1) {
      throw new Error("TLS trust must contain only PEM CA certificates.");
    }
    const next = end + END_CERTIFICATE.length;
    certificates.push(value.slice(offset, next));
    offset = next;
  }
  if (certificates.length === 0) {
    throw new Error("TLS trust must contain only PEM CA certificates.");
  }
  const publicCertificates: string[] = [];
  for (const certificate of certificates) {
    let parsed: X509Certificate;
    try {
      parsed = new X509Certificate(certificate);
    } catch {
      throw new Error("TLS trust contains an invalid certificate.");
    }
    if (!parsed.ca) {
      throw new Error("TLS trust contains a non-CA certificate.");
    }
    publicCertificates.push(parsed.toString().trim());
  }
  return publicCertificates.join("\n") + "\n";
}
