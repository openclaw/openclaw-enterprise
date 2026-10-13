import { X509Certificate } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

// Helm passes only fixed mount paths. An init failure prevents the API from starting;
// Node alone would warn and continue if NODE_EXTRA_CA_CERTS contained invalid PEM.
// OCC_CA_SOURCES maps each mount path to the Secret and key the operator configured, so
// errors name what the operator can fix. Every failure is one line on stderr, no stack.
const PEM = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

class BundleError extends Error {}

function sources() {
  try {
    const parsed = JSON.parse(process.env.OCC_CA_SOURCES ?? "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new BundleError(
      error?.code === "ENOENT"
        ? "not found in the Pod; check that the Secret and key exist"
        : `cannot be read (${error?.code ?? "unknown error"})`,
    );
  }
}

function certificates(pem) {
  if (Buffer.byteLength(pem) > 1024 * 1024) {
    throw new BundleError("the value is larger than 1 MiB");
  }
  if (pem.trim() === "") {
    throw new BundleError("the value is empty; it must hold one or more PEM CA certificates");
  }
  const remainder = pem.replace(PEM, "").trim();
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(remainder)) {
    throw new BundleError(
      "the value contains a private key; it must hold only public CA certificates",
    );
  }
  const blocks = pem.match(PEM) ?? [];
  if (blocks.length === 0) {
    throw new BundleError(
      "the value is not PEM; expected -----BEGIN CERTIFICATE----- blocks (DER and other formats are not supported)",
    );
  }
  if (remainder !== "") {
    throw new BundleError(
      "the value has text outside its PEM certificate blocks; it must hold only PEM CA certificates",
    );
  }
  return blocks.map((block, index) => {
    const position = `certificate ${index + 1} of ${blocks.length}`;
    const base64 = block
      .slice("-----BEGIN CERTIFICATE-----".length, -"-----END CERTIFICATE-----".length)
      .replace(/\s/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
      throw new BundleError(`${position} has invalid base64`);
    }
    const der = Buffer.from(base64, "base64");
    let certificate;
    try {
      certificate = new X509Certificate(der);
    } catch {
      throw new BundleError(`${position} is not a valid X.509 certificate`);
    }
    if (!certificate.raw.equals(der)) {
      throw new BundleError(`${position} has trailing data`);
    }
    if (!certificate.ca) {
      const subject = certificate.subject.replace(/\n/g, ", ");
      throw new BundleError(
        `${position} (${subject}) is not a CA certificate; use the issuing root or intermediate CA, not the server certificate`,
      );
    }
    return certificate.toString();
  });
}

const [output, ...inputs] = process.argv.slice(1);
const names = sources();
let current;
try {
  rmSync(output, { force: true });
  const bundle = inputs.flatMap((path) => {
    current = path;
    return certificates(read(path));
  });
  current = undefined;
  writeFileSync(output, `${bundle.join("\n")}\n`, { mode: 0o444, flag: "wx" });
} catch (error) {
  const source = current === undefined ? undefined : (names[current] ?? current);
  const problem =
    error instanceof BundleError
      ? `${source}: ${error.message}`
      : `${source ? `${source}: ` : ""}${error?.message ?? error}`;
  process.stderr.write(`assemble-api-ca: ${problem.replace(/\s+/g, " ")}\n`);
  process.exit(1);
}
