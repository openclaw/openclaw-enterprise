import { writeFile } from "node:fs/promises";
import { join } from "node:path";

// Callers own subprocess policy and cleanup: image tests remove the CA key,
// while the first-Agent smoke retains it.
export async function createModelProbeCertificates({ directory, caName, run }) {
  const file = (name) => join(directory, name);
  await run("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    `/CN=${caName}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
    "-keyout",
    file("ca-key.pem"),
    "-out",
    file("ca.pem"),
  ]);
  await run("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=api.openai.com",
    "-keyout",
    file("key.pem"),
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
