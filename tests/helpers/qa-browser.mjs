import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { chromium } from "playwright";
import { unusedPort, waitFor } from "./qa-utils.mjs";
import { submitChatTurnWithAssistantProof, waitForStockUi } from "./native-ui-chat.mjs";

export async function createQaBrowser(f) {
  const nativeHost = `native.${f.cluster}.oce.localhost`;
  const port = await unusedPort();
  const nativeOrigin = `https://${nativeHost}:${port}`;
  const ca = f.browserCA ?? join(f.directory, "browser-ca.crt");
  let relay;
  let upstream;
  const sockets = new Set();
  if (f.controlPlane === "compose") {
    const key = join(f.directory, "browser-tls.key");
    await f.run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      ca,
      "-days",
      "2",
      "-subj",
      `/CN=${nativeHost}`,
      "-addext",
      `subjectAltName=DNS:${nativeHost}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
    ]);
    relay = createServer(
      { key: await readFile(key), cert: await readFile(ca), minVersion: "TLSv1.2" },
      (socket) => {
        if (!upstream) {
          socket.destroy();
          return;
        }
        const target = connect(upstream.port, "127.0.0.1");
        for (const connection of [socket, target]) {
          sockets.add(connection);
          connection.once("close", () => sockets.delete(connection));
        }
        socket.pipe(target);
        target.pipe(socket);
        socket.on("error", () => target.destroy());
        target.on("error", () => socket.destroy());
      },
    );
    await new Promise((accept, reject) => {
      relay.once("error", reject);
      relay.listen(port, "127.0.0.1", accept);
    });
    f.resources.after(async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise((accept) => relay.close(accept));
    });
  }
  // Add/remove only this run's CA nickname. Neither global certificate bypasses
  // nor Playwright ignoreHTTPSErrors are acceptable proof of trusted TLS.
  const database = join(homedir(), ".pki", "nssdb");
  await mkdir(database, { recursive: true, mode: 0o700 });
  try {
    await stat(join(database, "cert9.db"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    await f.run("certutil", ["-N", "--empty-password", "-d", `sql:${database}`]);
  }
  const nickname = `oce-qa-${f.suffix}`;
  await f.run("certutil", ["-A", "-d", `sql:${database}`, "-n", nickname, "-t", "C,,", "-i", ca]);
  f.resources.after(() => f.run("certutil", ["-D", "-d", `sql:${database}`, "-n", nickname]));
  const browser = await chromium.launchPersistentContext(join(f.directory, "browser-profile"), {
    headless: true,
    ...(process.env.OCC_TEST_BROWSER_EXECUTABLE
      ? { executablePath: process.env.OCC_TEST_BROWSER_EXECUTABLE }
      : {}),
    args: [`--host-resolver-rules=MAP *.${f.cluster}.oce.localhost 127.0.0.1`],
    ignoreHTTPSErrors: false,
  });
  f.resources.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(f.consoleUrl + "/console/");
  await page.getByLabel("Username").fill(f.credentials.email);
  await page.getByLabel("Password").fill(f.credentials.password);
  const signedIn = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/sign-in/email" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Login", exact: true }).click();
  assert.equal((await signedIn).status(), 200, "console sign-in must succeed");
  // An authenticated API read disambiguates a still-visible login page.
  const authenticated = await page.evaluate(async () => (await fetch("/installation")).status);
  assert.equal(authenticated, 200);
  await f.record("console", {
    authenticated: true,
    origin: f.consoleUrl,
    tls: f.controlPlane === "kubernetes",
  });
  return {
    nativeOrigin: f.controlPlane === "compose" ? nativeOrigin : undefined,
    async verify(agent) {
      const gateway = await f.gatewayUrl(agent);
      let origin = nativeOrigin;
      if (f.controlPlane === "compose") {
        upstream = new URL(gateway.url);
      } else {
        const path = `/namespaces/${agent.namespaceId}/agents/${agent.id}/native-admin`;
        const status = await page.evaluate(async (path) => {
          const response = await fetch(path);
          return { status: response.status, body: await response.json() };
        }, path);
        assert.equal(status.status, 200);
        assert.equal(status.body.data.status, "available");
        assert.equal(status.body.data.activeRevisionId, agent.revision.id);
        origin = status.body.data.origin;
      }
      const native = await browser.newPage();
      const frames = [];
      native.on("websocket", (socket) => {
        assert.equal(new URL(socket.url()).origin, origin.replace(/^http/, "ws"));
        socket.on("framereceived", (frame) => frames.push(frame));
      });
      try {
        const response = await native.goto(origin);
        assert.ok(response?.ok(), "native UI must load through its trusted endpoint");
        const authenticate =
          f.controlPlane === "compose"
            ? async () => {
                const credential = native.locator("#login-gate-credential");
                await credential.waitFor({ state: "attached", timeout: 60_000 });
                // The stock login failure view nests credentials in a collapsed
                // connection disclosure. Wait for that view before opening it.
                if (!(await credential.isVisible())) {
                  await native.locator("details.login-gate__connection > summary").click();
                }
                await credential.fill(gateway.gatewayPassword);
                await native.getByRole("button", { name: "Connect", exact: true }).click();
              }
            : undefined;
        await waitForStockUi(native);
        const nonce = `QA_NATIVE_${randomUUID()}`;
        await submitChatTurnWithAssistantProof(native, nonce, frames, waitFor, authenticate);
        const current = await f.pod(agent, "gateway");
        assert.equal(current.metadata.uid, gateway.pod.metadata.uid);
        await f.record(`${agent.preset}-native-ui`, {
          agentId: agent.id,
          revisionId: agent.revision.id,
          podUid: current.metadata.uid,
          origin,
          trustedTls: true,
          assistantNonce: nonce,
          receivedFrames: frames.length,
        });
      } finally {
        await native.close();
        await gateway.close();
      }
    },
  };
}
