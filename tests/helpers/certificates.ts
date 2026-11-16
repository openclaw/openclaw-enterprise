import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

export type OpenSslRunner = (command: string, args: string[]) => Promise<unknown>;

export interface CertificateAuthorityPaths {
  caPath: string;
  caKeyPath: string;
}

interface CertificatePaths {
  keyPath: string;
  certPath: string;
}

interface CertificateMaterial extends CertificatePaths {
  key: string;
  cert: string;
}

interface SelfSignedOptions {
  name?: string;
  commonName?: string;
  subjectAltName?: string;
  keyPem?: string | undefined;
  days?: number;
}

interface CertificateAuthorityOptions {
  caName: string;
  caKeyPem?: string | undefined;
  days?: number;
  run?: OpenSslRunner | undefined;
}

type LeafUsage = "serverAuth" | "clientAuth";

interface SignedLeafOptions {
  name: string;
  commonName?: string | undefined;
  subject?: string | undefined;
  subjectAltName?: string | undefined;
  usage?: LeafUsage;
  keyPem?: string | undefined;
  days?: number;
  run?: OpenSslRunner | undefined;
}

interface LeafPaths extends CertificatePaths {
  csr: string;
  ext: string;
}

interface IssueLeafOptions {
  subject: string;
  subjectAltName: string | undefined;
  usage: LeafUsage;
  keyPem: string | undefined;
  days: number;
  run: OpenSslRunner;
}

interface CaAndLeafOptions extends CertificateAuthorityOptions {
  commonName?: string | undefined;
  subject?: string | undefined;
  subjectAltName?: string | undefined;
  leafKeyPem?: string | undefined;
}

const execute = promisify(execFile);

// Returns the openssl key arguments: `-key keyPath` after writing `keyPem` there, or
// arguments that generate a fresh P-256 key at `keyPath` (much faster than RSA). Shared
// fixture keys (shared-keys.mjs) save the generation entirely where a test needs RSA.
async function keyArguments(keyPath: string, keyPem: string | undefined): Promise<string[]> {
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
  directory: string,
  {
    name = "tls",
    commonName = "localhost",
    subjectAltName = "DNS:localhost,IP:127.0.0.1",
    keyPem,
    days = 1,
  }: SelfSignedOptions = {},
): Promise<CertificateMaterial> {
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
  return readCertificate({ keyPath, certPath });
}

// A CA in `directory` as ca-key.pem and ca.pem. `run(command, args)` runs openssl; pass
// one to apply the caller's subprocess policy (timeouts, logging). Callers own the files,
// including removing the CA key.
export async function certificateAuthority(
  directory: string,
  { caName, caKeyPem, days = 2, run = execute }: CertificateAuthorityOptions,
): Promise<CertificateAuthorityPaths> {
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
  paths: LeafPaths,
  { caPath, caKeyPath }: CertificateAuthorityPaths,
  { subject, subjectAltName, usage, keyPem, days, run }: IssueLeafOptions,
): Promise<void> {
  await run("openssl", [
    "req",
    "-new",
    ...(await keyArguments(paths.keyPath, keyPem)),
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
    paths.certPath,
  ]);
}

// A leaf signed by `ca` (from certificateAuthority), in `directory` as <name>.key and
// <name>.crt. `subject` defaults to `/CN=<commonName>`; `usage` is serverAuth or
// clientAuth. Returns the PEM texts and their paths.
export async function signedLeaf(
  directory: string,
  ca: CertificateAuthorityPaths,
  {
    name,
    commonName,
    subject = `/CN=${commonName}`,
    subjectAltName,
    usage = "serverAuth",
    keyPem,
    days = 2,
    run = execute,
  }: SignedLeafOptions,
): Promise<CertificateMaterial> {
  const file = (suffix: string) => join(directory, `${name}.${suffix}`);
  const paths = { keyPath: file("key"), csr: file("csr"), ext: file("ext"), certPath: file("crt") };
  await issueLeaf(paths, ca, { subject, subjectAltName, usage, keyPem, days, run });
  return readCertificate(paths);
}

async function readCertificate({
  keyPath,
  certPath,
}: CertificatePaths): Promise<CertificateMaterial> {
  return {
    key: await readFile(keyPath, "utf8"),
    cert: await readFile(certPath, "utf8"),
    keyPath,
    certPath,
  };
}

// A CA and a server leaf it signed, in `directory` as ca-key.pem, ca.pem, key.pem and
// cert.pem. `run` and file ownership as for certificateAuthority.
export async function caAndLeaf(
  directory: string,
  {
    caName,
    commonName,
    subject,
    subjectAltName,
    caKeyPem,
    leafKeyPem,
    days = 2,
    run = execute,
  }: CaAndLeafOptions,
): Promise<CertificateAuthorityPaths & CertificatePaths> {
  const file = (name: string) => join(directory, name);
  const ca = await certificateAuthority(directory, { caName, caKeyPem, days, run });
  const paths = {
    keyPath: file("key.pem"),
    csr: file("leaf.csr"),
    ext: file("leaf.ext"),
    certPath: file("cert.pem"),
  };
  await issueLeaf(paths, ca, {
    subject: subject ?? `/CN=${commonName}`,
    subjectAltName,
    usage: "serverAuth",
    keyPem: leafKeyPem,
    days,
    run,
  });
  return { ...ca, keyPath: paths.keyPath, certPath: paths.certPath };
}
