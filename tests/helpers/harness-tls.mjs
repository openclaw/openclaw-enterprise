import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Local test-owned CA and a localhost leaf; no host trust or credentials are read. */
export async function harnessTlsFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "oce-harness-tls-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = (...args) => {
    const result = spawnSync("openssl", args, { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  run(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-subj",
    "/CN=Harness fixture CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  );
  run(
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    "server.key",
    "-out",
    "server.csr",
    "-subj",
    "/CN=localhost",
  );
  await writeFile(
    join(directory, "server.ext"),
    [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=serverAuth",
      "subjectAltName=DNS:localhost",
    ].join("\n"),
  );
  run(
    "x509",
    "-req",
    "-in",
    "server.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    "server.pem",
    "-extfile",
    "server.ext",
  );
  const rootCertificatePath = join(directory, "ca.pem");
  return {
    directory,
    rootCertificatePath,
    caBundle: await readFile(rootCertificatePath, "utf8"),
    cert: await readFile(join(directory, "server.pem"), "utf8"),
    key: await readFile(join(directory, "server.key"), "utf8"),
  };
}
