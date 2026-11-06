import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { Agent, createServer, request } from "node:https";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createSecureContext } from "node:tls";
import { promisify } from "node:util";
import { reservePort } from "./available-port.mjs";
import { certificateAuthority, signedLeaf } from "./certificates.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";
import type { SavedAccountPeer } from "./saved-account-proxy.ts";

const execute = promisify(execFile);

/** The HTTPS origin validates the presented bearer with the issuer and retains only its digest. */
export async function createSavedAccountOrigin(t: TestContext, issuer: string) {
  // The lane resolves the issuer hostname to loopback. A distinct port is the MCP service.
  const host = new URL(issuer).hostname;
  const workerPort = await reservePort();
  t.after(workerPort.release);
  const directory = await temporaryDirectory(t, "oce-account-origin-");
  const ca = await certificateAuthority(directory, {
    caName: "Reports test CA",
    caKeyPem: undefined,
  });
  const leaf = await signedLeaf(directory, ca, {
    name: "reports",
    commonName: host,
    keyPem: undefined,
    subjectAltName: `DNS:${host}`,
  });
  const root = await readFile(ca.caPath, "utf8");
  const recipientAgent = new Agent({ secureContext: createSecureContext({ ca: root }) });
  t.after(() => recipientAgent.destroy());
  const requests: { tokenHash: string; subject: string; tool: string }[] = [];
  const server = createServer({ key: leaf.key, cert: leaf.cert }, async (req, res) => {
    const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    const observed = {
      tokenHash: createHash("sha256")
        .update(token ?? "")
        .digest("hex"),
      subject: "",
      tool: "",
    };
    requests.push(observed);
    if (req.method === "GET" || req.method === "DELETE") {
      observed.tool = req.method;
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/mcp");
      let bytes = "";
      for await (const chunk of req) {
        bytes += chunk.toString();
      }
      const body = JSON.parse(bytes);
      observed.tool = body.method === "tools/call" ? body.params?.name : body.method;
      const user =
        token &&
        (await fetch(`${issuer}/protocol/openid-connect/userinfo`, {
          headers: { Authorization: `Bearer ${token}` },
          redirect: "error",
        }));
      if (!user || !user.ok) {
        res.writeHead(401).end();
        return;
      }
      observed.subject = (await user.json()).sub;
      if (body.method === "notifications/initialized") {
        res.writeHead(202, { "content-type": "application/json" }).end();
        return;
      }
      let result;
      switch (body.method) {
        case "initialize":
          result = {
            protocolVersion: body.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "Reports", version: "1" },
          };
          break;
        case "tools/list":
          result = {
            tools: [
              {
                name: "whoami",
                description: "Return the signed-in account.",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
              },
            ],
          };
          break;
        case "tools/call":
          assert.deepEqual(body.params.arguments, {});
          result = {
            content: [
              {
                type: "text",
                text: observed.tool === "whoami" ? observed.subject : "report retrieved",
              },
            ],
          };
          break;
        default:
          res.writeHead(400).end();
          return;
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    } catch {
      res.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = new URL(`https://${host}:${workerPort.port}/mcp`);

  return {
    url: url.href,
    requests,
    workerPort,
    tls: { caPem: root, caPath: ca.caPath, certificatePem: leaf.cert, privateKeyPem: leaf.key },
    originAddress: `127.0.0.1:${address.port}`,
    async dispatch(peer: SavedAccountPeer, body: Record<string, unknown>): Promise<boolean> {
      const runner = process.env.OCC_TEST_OPENSHELL_CREDENTIAL_SENDER;
      if (runner) {
        // The native supervisor relay needs the test identity. Keep it off argv and out of test output.
        const file = join(directory, randomUUID() + ".json");
        await writeFile(
          file,
          JSON.stringify({
            brokerUrl: peer.brokerUrl,
            brokerCaPem: peer.brokerCaPem,
            audience: peer.audience,
            supervisorToken: peer.supervisorToken,
            sandboxId: peer.sandboxId,
            sandboxName: peer.sandboxName,
            workspace: peer.workspace,
            middlewareName: peer.middlewareName,
            bindingConfig: peer.bindingConfig,
            originHost: host,
            originPort: workerPort.port,
            originAddress: `127.0.0.1:${address.port}`,
            originCaPem: root,
            method: "POST",
            path: url.pathname,
            body,
          }),
          { mode: 0o600, flag: "wx" },
        );
        let stdout: string;
        try {
          ({ stdout } = await execute(runner, [], {
            env: { ...process.env, OPENSHELL_TEST_BROKER_REQUEST: file },
            timeout: 45_000,
            maxBuffer: 256 * 1024,
          }));
        } catch {
          throw new Error("The native OpenShell credential sender did not complete.");
        } finally {
          await unlink(file);
        }
        const matches = [...stdout.matchAll(/^OPENSHELL_TEST_HTTP_STATUS=(\d{3})$/gm)];
        assert.equal(
          matches.length,
          1,
          "the native sender reports the downstream HTTP status once",
        );
        return matches[0]![1] === "200";
      }

      // The standard lane exercises the production gRPC authority with a controlled sender.
      const bearer = await peer.resolve(url, body);
      if (!bearer) {
        return false;
      }
      return new Promise<boolean>((resolve, reject) => {
        const outbound = request(
          {
            hostname: "127.0.0.1",
            servername: host,
            port: address.port,
            method: "POST",
            path: url.pathname,
            agent: recipientAgent,
            headers: {
              host: url.host,
              "content-type": "application/json",
              authorization: `Bearer ${bearer}`,
            },
          },
          (response) => {
            response.resume();
            response.once("error", reject);
            response.once("end", () => resolve(response.statusCode === 200));
          },
        );
        outbound.once("error", reject);
        outbound.end(JSON.stringify(body));
      });
    },
  };
}
