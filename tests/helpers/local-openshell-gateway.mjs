import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

// Read only the disposable installation's administrative client identity. Never
// project it into an Agent; these private host files are removed with the test.
export async function localOpenShellGatewayOptions(context, kubectl, environment, namespace, port) {
  const directory = await mkdtemp(join(tmpdir(), "oce-gateway-client-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  let result;
  try {
    result = await execute(
      "kubectl",
      [...kubectl, "get", "secret", "openshell-client-tls", "-n", namespace, "-o", "json"],
      { env: environment, timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
  } catch {
    // Do not attach subprocess output, which may contain private key material.
    throw new Error("Cannot read the disposable Gateway client identity.");
  }
  const { data } = JSON.parse(result.stdout);
  for (const name of ["ca.crt", "tls.crt", "tls.key"]) {
    assert.equal(typeof data?.[name], "string", `Gateway client Secret is missing ${name}`);
    await writeFile(join(directory, name), Buffer.from(data[name], "base64"), { mode: 0o600 });
  }
  return {
    endpoint: `https://127.0.0.1:${port}`,
    rootCertificatePath: join(directory, "ca.crt"),
    auth: {
      mode: "mtls",
      certificatePath: join(directory, "tls.crt"),
      privateKeyPath: join(directory, "tls.key"),
    },
  };
}
