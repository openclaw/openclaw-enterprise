import { readFile } from "node:fs/promises";
import { certificateAuthority, signedLeaf } from "./certificates.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";

/** Local test-owned CA and a localhost leaf; no host trust or credentials are read. */
export async function harnessTlsFixture(t) {
  const directory = await temporaryDirectory(t, "oce-harness-tls-");
  const ca = await certificateAuthority(directory, { caName: "Harness fixture CA", days: 1 });
  const { key, cert } = await signedLeaf(directory, ca, {
    name: "server",
    commonName: "localhost",
    subjectAltName: "DNS:localhost",
    days: 1,
  });
  return {
    directory,
    ca,
    rootCertificatePath: ca.caPath,
    caBundle: await readFile(ca.caPath, "utf8"),
    cert,
    key,
  };
}
