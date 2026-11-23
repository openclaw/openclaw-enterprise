import { X509Certificate } from "node:crypto";
import { checkServerIdentity, type PeerCertificate } from "node:tls";

// A revision-specific trust anchor, obtained from authenticated compute state.
// No connection or session reuse across admissions, even at the same port.
export function browserRevisionTls(certificate?: string) {
  if (certificate === undefined) return {};
  const leaf = new X509Certificate(certificate);
  return {
    agent: false as const,
    ca: leaf.toString(),
    rejectUnauthorized: true,
    checkServerIdentity(host: string, peer: PeerCertificate) {
      return (
        checkServerIdentity(host, peer) ??
        (peer.raw.equals(leaf.raw)
          ? undefined
          : new Error("Unexpected browser revision certificate."))
      );
    },
  };
}
