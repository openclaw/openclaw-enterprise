import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createSecureContext } from "node:tls";

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
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > 131072 ||
      (before.mode & 0o022) !== 0
    ) {
      throw new Error("invalid-public-ca");
    }
    const data = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < data.length) {
      const result = await file.read(data, size, data.length - size, size);
      if (result.bytesRead === 0) {
        break;
      }
      size += result.bytesRead;
    }
    const after = await file.stat();
    const named = await stat(path);
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      named.dev !== before.dev ||
      named.ino !== before.ino
    ) {
      throw new Error("invalid-public-ca");
    }
    const pem = data.subarray(0, size).toString("utf8");
    if (!isCertificateBundle(pem)) {
      throw new Error("invalid-public-ca");
    }
    createSecureContext({ ca: pem, minVersion: "TLSv1.2" });
    return Buffer.from(data.subarray(0, size));
  } finally {
    await file.close();
  }
}
