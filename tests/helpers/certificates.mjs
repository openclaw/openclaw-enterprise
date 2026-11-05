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

// A CA in `directory` as ca-key.pem and ca.pem. `run(command, args)` runs openssl; pass
// one to apply the caller's subprocess policy (timeouts, logging). Callers own the files,
// including removing the CA key.
export async function certificateAuthority(
  directory,
  { caName, caKeyPem, days = 2, run = execute },
) {
  const caPath = join(directory, "ca.pem");
  const caKeyPath = join(directory, "ca-key.pem");
  await run("openssl", [
    "req",
    "-x509",
    ...(await keyArguments(caKeyPath, caKeyPem)),
    "-days",
    String(days),
    "-subj",
    `/CN=${caName}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign",
    "-out",
    caPath,
  ]);
  return { caPath, caKeyPath };
}

// Writes the leaf key, CSR, extensions and certificate at `paths` and signs it with `ca`.
// `subjectAltName` is left out when unset; `usage` is the extended key usage.
async function issueLeaf(
  paths,
  { caPath, caKeyPath },
  { subject, subjectAltName, usage, keyPem, days, run },
) {
  await run("openssl", [
    "req",
    "-new",
    ...(await keyArguments(paths.key, keyPem)),
    "-subj",
    subject,
    "-out",
    paths.csr,
  ]);
  await writeFile(
    paths.ext,
    [
      ...(subjectAltName === undefined ? [] : [`subjectAltName=${subjectAltName}`]),
      "basicConstraints=critical,CA:FALSE",
      `extendedKeyUsage=${usage}`,
      "keyUsage=critical,digitalSignature,keyEncipherment",
      "",
    ].join("\n"),
  );
  await run("openssl", [
    "x509",
    "-req",
    "-in",
    paths.csr,
    "-CA",
    caPath,
    "-CAkey",
    caKeyPath,
    "-CAcreateserial",
    "-days",
    String(days),
    "-extfile",
    paths.ext,
    "-out",
    paths.cert,
  ]);
}

// A leaf signed by `ca` (from certificateAuthority), in `directory` as <name>.key and
// <name>.crt. `subject` defaults to `/CN=<commonName>`; `usage` is serverAuth or
// clientAuth. Returns the PEM texts and their paths.
export async function signedLeaf(
  directory,
  ca,
  {
    name,
    commonName,
    subject = `/CN=${commonName}`,
    subjectAltName,
    usage = "serverAuth",
    keyPem,
    days = 2,
    run = execute,
  },
) {
  const file = (suffix) => join(directory, `${name}.${suffix}`);
  const paths = { key: file("key"), csr: file("csr"), ext: file("ext"), cert: file("crt") };
  await issueLeaf(paths, ca, { subject, subjectAltName, usage, keyPem, days, run });
  return {
    key: await readFile(paths.key, "utf8"),
    cert: await readFile(paths.cert, "utf8"),
    keyPath: paths.key,
    certPath: paths.cert,
  };
}

// A CA and a server leaf it signed, in `directory` as ca-key.pem, ca.pem, key.pem and
// cert.pem. `run` and file ownership as for certificateAuthority.
export async function caAndLeaf(
  directory,
  { caName, commonName, subject, subjectAltName, caKeyPem, leafKeyPem, days = 2, run = execute },
) {
  const file = (name) => join(directory, name);
  const ca = await certificateAuthority(directory, { caName, caKeyPem, days, run });
  const paths = {
    key: file("key.pem"),
    csr: file("leaf.csr"),
    ext: file("leaf.ext"),
    cert: file("cert.pem"),
  };
  await issueLeaf(paths, ca, {
    subject: subject ?? `/CN=${commonName}`,
    subjectAltName,
    usage: "serverAuth",
    keyPem: leafKeyPem,
    days,
    run,
  });
  return { ...ca, keyPath: paths.key, certPath: paths.cert };
}
