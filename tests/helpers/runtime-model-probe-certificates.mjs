import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sharedRsaPrivateKeyPem } from "../fixtures/repository-credentials/shared-keys.mjs";

// Callers own subprocess policy and cleanup: image tests remove the CA key,
// while the first-Agent smoke retains it. The CA and leaf keys are the process's
// shared fixture keys (shared-keys.mjs); both certificates are minted per call.
export async function createModelProbeCertificates({ directory, caName, run }) {
  const file = (name) => join(directory, name);
  await writeFile(file("ca-key.pem"), sharedRsaPrivateKeyPem("model-probe-ca"), { mode: 0o600 });
  await writeFile(file("key.pem"), sharedRsaPrivateKeyPem("model-probe-leaf"), { mode: 0o600 });
  await run("openssl", [
    "req",
    "-x509",
    "-key",
    file("ca-key.pem"),
    "-days",
    "2",
    "-subj",
    `/CN=${caName}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
    "-out",
    file("ca.pem"),
  ]);
  await run("openssl", [
    "req",
    "-new",
    "-key",
    file("key.pem"),
    "-subj",
    "/CN=api.openai.com",
    "-out",
    file("leaf.csr"),
  ]);
  await writeFile(
    file("leaf.ext"),
    [
      "subjectAltName=DNS:api.openai.com",
      "basicConstraints=critical,CA:FALSE",
      "extendedKeyUsage=serverAuth",
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "",
    ].join("\n"),
  );
  await run("openssl", [
    "x509",
    "-req",
    "-in",
    file("leaf.csr"),
    "-CA",
    file("ca.pem"),
    "-CAkey",
    file("ca-key.pem"),
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    file("leaf.ext"),
    "-out",
    file("cert.pem"),
  ]);
}
