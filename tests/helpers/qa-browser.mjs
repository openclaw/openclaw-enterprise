import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:tls";
import { chromium } from "playwright";
import { prepareQaConsoleTheme } from "./qa-installation.mjs";
import { waitFor } from "./qa-utils.mjs";
import { submitChatTurnWithAssistantProof, waitForStockUi } from "./native-ui-chat.mjs";

export async function createQaBrowser(f, { themed }) {
  if (themed) {
    await prepareQaConsoleTheme(f);
  }
  const nativeHost = `native.${f.cluster}.oce.localhost`;
  let nativeOrigin;
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
      // Port 0: the relay's port is read once bound, so nothing else can take it first.
      relay.listen(0, "127.0.0.1", accept);
    });
    nativeOrigin = `https://${nativeHost}:${relay.address().port}`;
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
  if (themed) {
    assert.equal(await page.title(), "Example Agents");
  }
  await page.getByLabel("Email", { exact: true }).fill(f.credentials.email);
  await page.getByLabel("Password").fill(f.credentials.password);
  const signedIn = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/auth/sign-in/email" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
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
    async verifySecrets(agent) {
      const secretsPage = await browser.newPage();
      const base = `/namespaces/${agent.namespaceId}`;
      const name = `qa-console-${randomUUID()}`;
      const syntheticValue = `synthetic-console-${randomUUID()}`;
      const configurationPath = `${base}/configurations/${agent.configurationId}`;
      const configuration = await f.api("GET", configurationPath);
      let secret;
      let configurationChanged = false;
      try {
        await secretsPage.goto(`${f.consoleUrl}/console/secrets?namespace=${agent.namespaceId}`);
        await secretsPage.getByRole("button", { name: "Create Secret", exact: true }).click();
        const create = secretsPage.getByRole("dialog", { name: "Create Secret", exact: true });
        await create.getByLabel("Secret name", { exact: true }).fill(name);
        await create.getByLabel("Value", { exact: true }).fill(syntheticValue);
        await create.getByRole("button", { name: "Create Secret", exact: true }).click();
        await secretsPage
          .getByRole("dialog", { name: "Secret created", exact: true })
          .getByRole("button", { name: "Close" })
          .click();
        secret = (await f.api("GET", `${base}/secrets`)).find((item) => item.name === name);
        assert.ok(secret, "console-created Secret must be persisted by the shipped controller");
        await secretsPage.getByRole("button", { name, exact: true }).click();
        await secretsPage
          .getByRole("dialog", { name, exact: true })
          .getByRole("button", { name: "Replace value", exact: true })
          .click();
        const replace = secretsPage.getByRole("dialog", {
          name: "Replace Secret value",
          exact: true,
        });
        await replace.getByLabel("Value", { exact: true }).fill(`${syntheticValue}-replacement`);
        await replace.getByRole("button", { name: "Replace value", exact: true }).click();
        await secretsPage
          .getByRole("dialog", { name: "Secret value replaced", exact: true })
          .getByRole("button", { name: "Close" })
          .click();

        // Change this scenario's Agent draft Configuration, leaving the active revision intact.
        // The real Configuration admission and stored reference must prevent Secret deletion.
        configurationChanged = true;
        await f.api("PATCH", configurationPath, {
          values: configuration.values,
          secretBindings: {
            ...configuration.secretBindings,
            QA_CONSOLE_SECRET: { source: secret.ref },
          },
        });
        await secretsPage.getByRole("button", { name, exact: true }).click();
        const detail = secretsPage.getByRole("dialog", { name, exact: true });
        await detail.getByText(agent.configurationId, { exact: true }).waitFor();
        assert.equal(
          await detail.getByRole("button", { name: "Delete Secret", exact: true }).isDisabled(),
          true,
        );
        // Bypass the disabled control to verify the actual server also rejects the reference.
        const refused = await secretsPage.evaluate(
          async (path) => (await fetch(path, { method: "DELETE" })).status,
          `${base}/secrets/${secret.id}`,
        );
        assert.equal(refused, 409);
        await detail.getByRole("button", { name: "Close" }).click();
        await f.api("PATCH", configurationPath, {
          values: configuration.values,
          secretBindings: configuration.secretBindings ?? {},
        });
        configurationChanged = false;
        await secretsPage.getByRole("button", { name, exact: true }).click();
        await secretsPage
          .getByRole("dialog", { name, exact: true })
          .getByRole("button", { name: "Delete Secret", exact: true })
          .click();
        await secretsPage
          .getByRole("dialog", { name: "Delete Secret", exact: true })
          .getByRole("button", { name: "Permanently delete Secret", exact: true })
          .click();
        await secretsPage.getByRole("dialog", { name: "Secret deleted", exact: true }).waitFor();
        assert.equal(
          (await f.api("GET", `${base}/secrets`)).some((item) => item.id === secret.id),
          false,
        );
        await f.record(`${agent.preset}-console-secrets`, {
          agentId: agent.id,
          configurationId: agent.configurationId,
          secretId: secret.id,
          created: true,
          replaced: true,
          referenceBlockedDeletion: true,
          deleted: true,
        });
        secret = null;
      } finally {
        try {
          if (configurationChanged) {
            await f.api("PATCH", configurationPath, {
              values: configuration.values,
              secretBindings: configuration.secretBindings ?? {},
            });
          }
          // A lost creation reply can leave an owned Secret before its ID was read.
          const owned = (await f.api("GET", `${base}/secrets`)).find((item) => item.name === name);
          if (owned) {
            await f.api("DELETE", `${base}/secrets/${owned.id}`);
          }
        } finally {
          await secretsPage.close();
        }
      }
    },
    async verifyNamespaceDeletionBlockers(agent) {
      const namespacesPage = await browser.newPage();
      try {
        const namespace = await f.api("GET", `/namespaces/${agent.namespaceId}`);
        await namespacesPage.goto(`${f.consoleUrl}/console/namespaces?namespace=${namespace.id}`);
        await namespacesPage
          .getByRole("button", { name: `Delete ${namespace.name}`, exact: true })
          .click();
        const refused = namespacesPage.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === `/namespaces/${namespace.id}` &&
            response.request().method() === "DELETE",
        );
        await namespacesPage.getByRole("button", { name: "Delete Namespace", exact: true }).click();
        assert.equal((await refused).status(), 409);
        // A deployed Agent in this run's Namespace must block real teardown and appear in the dialog.
        const blockers = namespacesPage.getByRole("dialog", {
          name: "Namespace still contains resources",
          exact: true,
        });
        await blockers.getByText(agent.id, { exact: true }).waitFor();
        await blockers.getByText(agent.configurationId, { exact: true }).waitFor();
        assert.equal((await f.api("GET", `/namespaces/${namespace.id}`)).status, "ready");
        await blockers.getByRole("button", { name: "View Agents", exact: true }).click();
        assert.equal(new URL(namespacesPage.url()).searchParams.get("namespace"), namespace.id);
        await namespacesPage.getByRole("link", { name: agent.name, exact: true }).waitFor();
        await f.record(`${agent.preset}-console-namespace-deletion`, {
          namespaceId: namespace.id,
          agentId: agent.id,
          configurationId: agent.configurationId,
          nonemptyDeletionRefused: true,
          cleanupNavigationScoped: true,
        });
      } finally {
        await namespacesPage.close();
      }
    },
    async verify(agent) {
      assert.equal(await page.locator(".sidebar .brand-name").textContent(), "Example Agents");
      assert.equal(
        await page.locator(".sidebar .brand img").getAttribute("src"),
        "/console/theme/logo.png",
      );
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
