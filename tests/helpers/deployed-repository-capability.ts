import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { UnixRepositoryCredentialControlClient as Client } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
// Keep the real client on the owned socket even if the deployed program changes its path.
export class UnixRepositoryCredentialControlClient extends Client {
  constructor(options: ConstructorParameters<typeof Client>[0]) {
    assert.equal(options.controlSocket, "/run/openclaw/repository-control/private/control.sock");
    const controlSocket = new URL(import.meta.url).searchParams.get("socket");
    assert.ok(controlSocket);
    super({ controlSocket });
  }
}

export async function runDeployedCapability(
  args: string[],
  cwd: string,
  reply: { status: number; body: string },
) {
  assert.equal(cwd + "/", repository);
  const invocation = args.slice(args.indexOf("exec"));
  assert.deepEqual(invocation.slice(0, 8), [
    "exec",
    "worker-pod",
    "-c",
    "worker",
    "--",
    "node",
    "--input-type=module",
    "-e",
  ]);
  assert.equal(invocation.length, 9);
  const directory = await mkdtemp(join(tmpdir(), "cap-"));
  const socket = join(directory, "control.sock");
  const requests: { method: string | undefined; path: string | undefined; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
    }
    requests.push({ method: request.method, path: request.url, body });
    response.writeHead(reply.status, { "content-type": "application/json" });
    response.end(reply.body);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    const client = new URL(import.meta.url);
    client.searchParams.set("socket", socket);
    const paths = new Map([
      [
        "/app/apps/controller/src/drivers/repo/github/driver.ts",
        new URL("../../apps/controller/src/drivers/repo/github/driver.ts", import.meta.url).href,
      ],
      ["/app/apps/controller/src/backends/repository-credentials/control-client.ts", client.href],
    ]);
    const code = invocation[8]!.replace(
      /(["'`])(\/app\/[^"'`\r\n]*)\1/g,
      (_literal, _quote, path: string) => {
        const mapped = paths.get(path);
        assert.ok(mapped, `unexpected deployed application import: ${path}`);
        return JSON.stringify(mapped);
      },
    );
    const result = await new Promise<{ status: number; stdout: string; stderr: string }>(
      (resolve) => {
        execFile(
          process.execPath,
          [...invocation.slice(6, 8), code],
          { cwd, env: {}, timeout: 10_000 },
          (error, stdout, stderr) => {
            resolve({ status: error ? 1 : 0, stdout, stderr });
          },
        );
      },
    );
    return { ...result, requests };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}
