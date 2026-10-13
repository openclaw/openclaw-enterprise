import { X509Certificate } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

// Helm passes only fixed mount paths. An init failure prevents the API from starting;
// Node alone would warn and continue if NODE_EXTRA_CA_CERTS contained invalid PEM.
const [output, ...inputs] = process.argv.slice(1);
rmSync(output, { force: true });
const certificates = inputs.flatMap((path) => {
  const pem = readFileSync(path, "utf8");
  if (Buffer.byteLength(pem) > 1024 * 1024) {
    throw new Error(`CA bundle exceeds 1 MiB: ${path}`);
  }
  const blocks = [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)];
  const remainder = pem.replace(
    /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    "",
  );
  if (blocks.length === 0 || remainder.trim() !== "") {
    throw new Error(`CA bundle must contain only PEM certificates: ${path}`);
  }
  return blocks.map(([block]) => {
    const base64 = block
      .slice("-----BEGIN CERTIFICATE-----".length, -"-----END CERTIFICATE-----".length)
      .replace(/\s/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
      throw new Error(`CA bundle contains invalid certificate encoding: ${path}`);
    }
    const der = Buffer.from(base64, "base64");
    const certificate = new X509Certificate(der);
    if (!certificate.raw.equals(der)) {
      throw new Error(`CA bundle contains trailing certificate data: ${path}`);
    }
    if (!certificate.ca) {
      throw new Error(`CA bundle contains a non-CA certificate: ${path}`);
    }
    return certificate.toString();
  });
});
writeFileSync(output, `${certificates.join("\n")}\n`, { mode: 0o444, flag: "wx" });
