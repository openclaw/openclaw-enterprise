import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createSecureContext } from "node:tls";
import { readPublicFile } from "./public-file.ts";

function isCertificateBundle(pem: string): boolean {
  // Match one certificate at the current offset so malformed bundles cannot
  // backtrack through previously accepted certificates.
  const certificate =
    /\s*-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/y;
  let end = 0;
  while (certificate.exec(pem)) {
    end = certificate.lastIndex;
  }
  return end > 0 && pem.slice(end).trim().length === 0;
}

export async function loadPublicCa(path: string): Promise<Buffer> {
  // Public projected files may be symlinks. Private service material has a
  // separate protected loader and is never part of platform composition.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const data = await readPublicFile(file, path, 131072, "invalid-public-ca");
    const pem = data.toString("utf8");
    if (!isCertificateBundle(pem)) {
      throw new Error("invalid-public-ca");
    }
    createSecureContext({ ca: pem, minVersion: "TLSv1.2" });
    return Buffer.from(data);
  } finally {
    await file.close();
  }
}
