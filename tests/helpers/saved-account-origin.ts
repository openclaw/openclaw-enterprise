import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Agent, createServer, request } from "node:https";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { createSecureContext } from "node:tls";
import { createInterface } from "node:readline";
import { certificateAuthority, signedLeaf } from "./certificates.mjs";
import { temporaryDirectory } from "./temporary-directory.mjs";
import type { SavedAccountPeer } from "./saved-account-proxy.ts";

const host = "reports.example.test";

/** The HTTPS origin validates the presented bearer with the issuer and retains only its digest. */
export async function createSavedAccountOrigin(t: TestContext, issuer: string) {
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
    try {
      assert.equal(req.method, "POST");
      assert.equal(req.url, "/mcp");
      let bytes = "";
      for await (const chunk of req) {
        bytes += chunk.toString();
      }
      const body = JSON.parse(bytes);
      observed.tool = body.params?.name ?? "";
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
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "report retrieved" }] },
        }),
      );
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
  const port = address.port;
  const url = new URL(`https://${host}:${port}/mcp`);

  async function startSender(runner: string, peer: SavedAccountPeer) {
    // The supervisor identity is private to the fixture. Its cache and SPIFFE client
    // live in one process for this Sandbox across rotation, retry and detach.
    const file = join(directory, randomUUID() + ".json");
    await writeFile(
      file,
      JSON.stringify({
        brokerUrl: peer.brokerUrl,
        brokerCaPem: peer.brokerCaPem,
        tokenUrl: peer.tokenUrl,
        audience: peer.audience,
        supervisorToken: peer.supervisorToken,
        sandboxId: peer.sandboxId,
        sandboxName: peer.sandboxName,
        workspace: peer.workspace,
        middlewareName: peer.middlewareName,
        bindingConfig: peer.bindingConfig,
        originHost: host,
        originPort: port,
        originAddress: `127.0.0.1:${port}`,
        originCaPem: root,
        path: url.pathname,
      }),
      { mode: 0o600, flag: "wx" },
    );
    const child = spawn(runner, [], {
      env: {
        ...process.env,
        OPENSHELL_TEST_BROKER_REQUEST: file,
        SSL_CERT_FILE: peer.brokerCaPath,
      },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const pending = new Map<string, ReturnType<typeof Promise.withResolvers<boolean>>>();
    const fail = () => {
      for (const request of pending.values()) {
        request.reject(new Error("The stock OpenShell test sender stopped before its response."));
      }
    };
    child.on("error", fail);
    child.once("close", fail);
    child.stdin.on("error", fail);
    t.after(() => {
      child.stdin.end();
      child.kill();
    });
    createInterface({ input: child.stdout }).on("line", (line: string) => {
      const result = /(?:^|\s)OPENSHELL_TEST_HTTP_STATUS=([0-9a-f-]+) (\d{3})$/.exec(line);
      if (result) {
        pending.get(result[1]!)?.resolve(result[2] === "200");
      }
    });
    return async (body: Record<string, unknown>) => {
      const id = randomUUID();
      const completion = Promise.withResolvers<boolean>();
      pending.set(id, completion);
      const timer = setTimeout(
        () => completion.reject(new Error("The stock OpenShell test request timed out.")),
        45_000,
      );
      try {
        child.stdin.write(JSON.stringify({ id, body }) + "\n");
        return await completion.promise;
      } finally {
        clearTimeout(timer);
        pending.delete(id);
      }
    };
  }
  const native = new Map<SavedAccountPeer, ReturnType<typeof startSender>>();

  return {
    url: url.href,
    requests,
    async dispatch(peer: SavedAccountPeer, body: Record<string, unknown>): Promise<boolean> {
      const runner = process.env.OCC_TEST_OPENSHELL_CREDENTIAL_SENDER;
      if (runner) {
        let sender = native.get(peer);
        if (!sender) {
          sender = startSender(runner, peer);
          native.set(peer, sender);
        }
        return (await sender)(body);
      }

      // Use the production middleware and token endpoint, with CI issuing the Sandbox identity.
      const id = await peer.authorize(url, body);
      const bearer = id && (await peer.redeem(id));
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
