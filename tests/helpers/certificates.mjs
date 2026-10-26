import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Returns the openssl key arguments: `-key keyPath` after writing `keyPem` there, or
// arguments that generate a fresh P-256 key at `keyPath` (much faster than RSA). Shared
// fixture keys (shared-keys.mjs) save the generation entirely where a test needs RSA.
async function keyArguments(keyPath, keyPem) {
  if (keyPem === undefined) {
    return [
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyPath,
    ];
  }
  await writeFile(keyPath, keyPem, { mode: 0o600 });
  return ["-key", keyPath];
}

// A self-signed server (or client) certificate in `directory`, as `<name>.key` and
// `<name>.crt`. Returns the PEM texts and their paths.
export async function selfSigned(
  directory,
  {
    name = "tls",
    commonName = "localhost",
    subjectAltName = "DNS:localhost,IP:127.0.0.1",
    keyPem,
    days = 1,
  } = {},
) {
  const keyPath = join(directory, `${name}.key`);
  const certPath = join(directory, `${name}.crt`);
  await execute("openssl", [
    "req",
    "-x509",
    ...(await keyArguments(keyPath, keyPem)),
    "-days",
    String(days),
    "-out",
    certPath,
    "-subj",
    `/CN=${commonName}`,
    "-addext",
    `subjectAltName=${subjectAltName}`,
  ]);
  return {
    key: await readFile(keyPath, "utf8"),
    cert: await readFile(certPath, "utf8"),
    keyPath,
    certPath,
  };
}

// A CA and a server leaf it signed, in `directory` as ca-key.pem, ca.pem, key.pem and
// cert.pem. `run(command, args)` runs openssl; pass one to apply the caller's subprocess
// policy (timeouts, logging). Callers own the files, including removing the CA key.
export async function caAndLeaf(
  directory,
  { caName, commonName, subjectAltName, caKeyPem, leafKeyPem, days = 2, run = execute },
) {
  const file = (name) => join(directory, name);
  const caKey = await keyArguments(file("ca-key.pem"), caKeyPem);
  await run("openssl", [
    "req",
    "-x509",
    ...caKey,
    "-days",
    String(days),
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
    ...(await keyArguments(file("key.pem"), leafKeyPem)),
    "-subj",
    `/CN=${commonName}`,
    "-out",
    file("leaf.csr"),
  ]);
  await writeFile(
    file("leaf.ext"),
    [
      `subjectAltName=${subjectAltName}`,
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
    String(days),
    "-extfile",
    file("leaf.ext"),
    "-out",
    file("cert.pem"),
  ]);
  return {
    caPath: file("ca.pem"),
    caKeyPath: file("ca-key.pem"),
    keyPath: file("key.pem"),
    certPath: file("cert.pem"),
  };
}
