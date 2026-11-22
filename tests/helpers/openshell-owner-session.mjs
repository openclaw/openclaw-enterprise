// Exercise guarded OIDC browser access against the real HTTPS listener and stock Agent UI.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { publishedJSON } from "./dev-up-keycloak.mjs";
import { enableInstalledOidcNativeAdmin } from "./native-admin-oidc-k3d.mjs";
import { submitChatTurnWithAssistantProof, waitForStockUi } from "./native-ui-chat.ts";
import { verifyOpenShellOwnerPasswordSession } from "./openshell-owner-password-session.ts";

export {
  assertOpenShellOwnerModelSelection,
  preflightOpenShellOwnerBrowser,
} from "./openshell-owner-password-session.ts";

const execute = promisify(execFile);

export async function verifyOpenShellOwnerSession(input) {
  const { t, cluster, stateDirectory, kubectl, environment, browserPort, namespaceId } = input;
  const {
    browser,
    consoleHost,
    consoleOrigin,
    agentDomain,
    host,
    origin,
    agent,
    agentPath,
    rev,
    account,
    recoveryUserId,
    runtimeImagesBeforeUpgrade,
    allowOwnedRequest,
    openRecoveryPage,
    expectOwnerStatus,
    grant,
    consoleRequest,
    readNativeAccess,
  } = await verifyOpenShellOwnerPasswordSession(input);

  // The earlier phase proves the shared-cookie/password path. Switch only this
  // disposable installation to guarded OIDC; all native runtime I/O stays real.
  const oidc = await enableInstalledOidcNativeAdmin({
    t,
    cluster,
    stateDirectory,
    kubectl,
    environment,
    recoveryUserId,
    consoleOrigin,
    agentDomain,
  });
  const owner = await openRecoveryPage();
  // Account GET requires Origin, which browser fetch cannot set. Dial the
  // owned listener with its CA and hostname; Chromium's trust does not apply to Node.
  const accountResponse = await publishedJSON(
    {
      hostname: consoleHost,
      port: browserPort,
      ca: await readFile(join(stateDirectory, "browser-ca.crt")),
    },
    `/api/auth/accounts/${account.id}`,
    {
      headers: {
        origin: consoleOrigin,
        cookie: (await owner.context().cookies(consoleOrigin))
          .map(({ name, value }) => `${name}=${value}`)
          .join("; "),
      },
    },
  );
  const currentAccount = accountResponse.data;
  await expectOwnerStatus("POST", `/api/auth/accounts/${account.id}/providers/oidc`, {
    subject: oidc.subject,
    expectedVersion: currentAccount.version,
  });
  await grant(account.principalId, "agent", agent.id, ["administer"]);
  await grant(account.principalId, "namespace", namespaceId, ["read"]);
  const guardedAccess = await readNativeAccess(agentPath);
  assert.equal(guardedAccess.status, "available");
  assert.equal(guardedAccess.sessionMode, "host-only-exchange");
  assert.equal(guardedAccess.origin, origin);

  const receiptPath =
    process.env.OCC_TEST_NATIVE_BROWSER_RECEIPT ||
    join(await mkdtemp(join(tmpdir(), "oce-native-host-only-real-")), "receipt.json");
  const guarded = await browser.newContext({ serviceWorkers: "block" });
  t.after(() => guarded.close());
  await guarded.route("**/*", allowOwnedRequest);
  const received = [];
  const sends = [];
  guarded.on("page", (page) => {
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).origin !== origin.replace("https:", "wss:")) {
        return;
      }
      socket.on("framereceived", (frame) => received.push({ ...frame, page, socket }));
      socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        // Starting a session can submit its first turn in sessions.create;
        // creating an empty session must not count as a submitted turn.
        if (
          frame.type === "req" &&
          (frame.method === "chat.send" ||
            (frame.method === "sessions.create" &&
              typeof frame.params?.message === "string" &&
              frame.params.message.trim().length > 0))
        ) {
          sends.push({ page, socket });
        }
      });
    });
  });
  const consolePage = await guarded.newPage();
  await consolePage.route("https://idp.example.test/authorize*", oidc.authorizeRoute);
  await consolePage.goto(consoleOrigin + "/console/");
  const callback = consolePage.waitForResponse(
    (res) => new URL(res.url()).pathname === "/api/auth/providers/oidc/callback",
  );
  await consolePage.getByRole("button", { name: "Continue with Test SSO", exact: true }).click();
  assert.equal((await callback).status(), 302);
  await consolePage.waitForURL(consoleOrigin + "/console/");
  const session = await consoleRequest(consolePage, "GET", "/api/auth/session");
  assert.equal(session.data.user.id, account.id, "OIDC authenticated the attached collaborator");
  const parent = (await guarded.cookies(consoleOrigin)).find(
    (cookie) => cookie.name === oidc.parentCookieName,
  );
  assert.ok(parent?.secure && parent.httpOnly);
  assert.equal(parent.domain, consoleHost, "the guarded parent cookie is host-only");
  await consolePage.goto(
    `${consoleOrigin}/console/agents/${agent.id}?namespace=${namespaceId}&revision=${rev.id}`,
  );

  async function waitFor(description, observe) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const value = await observe();
      if (value) {
        return value;
      }
      await delay(100);
    }
    assert.fail(description);
  }
  async function hello(page, firstFrame = 0) {
    return waitFor("the opened stock Gateway returns hello-ok", () =>
      received.slice(firstFrame).find((frame) => {
        const data = JSON.parse(String(frame.payload));
        return (
          frame.page === page &&
          !frame.socket.isClosed() &&
          data.type === "res" &&
          data.ok === true &&
          data.payload?.type === "hello-ok"
        );
      }),
    );
  }
  async function launch() {
    const popup = consolePage.waitForEvent("popup");
    await consolePage.getByRole("link", { name: "Open Agent UI", exact: true }).click();
    const page = await popup;
    await hello(page);
    await waitForStockUi(page);
    assert.equal(new URL(page.url()).origin, origin);
    assert.equal(await page.evaluate(() => globalThis.opener === null), true);
    return page;
  }
  const first = await launch();
  assert.ok(!(await guarded.cookies(origin)).some((cookie) => cookie.name === parent.name));
  const handle = (await guarded.cookies(origin)).find(
    (cookie) => cookie.name === "__Host-occ_agent_access",
  );
  assert.ok(handle?.secure && handle.httpOnly && handle.sameSite === "Strict");
  assert.equal(handle.domain, host);
  const marker = "host-only-" + randomUUID();
  const terminal = await submitChatTurnWithAssistantProof(first, marker, received, waitFor);
  assert.equal(terminal.page, first);
  assert.ok(!terminal.socket.isClosed());
  const replySelector = `.chat-group.assistant [data-message-text="${marker}"]`;
  await first.locator(replySelector).waitFor({ state: "visible" });
  const sessionKey = JSON.parse(String(terminal.payload)).payload.sessionKey;
  assert.equal(typeof sessionKey, "string");
  assert.ok(sessionKey.length > 0);
  const conversation = first.url();
  assert.match(new URL(conversation).pathname, /^\/chat\//);
  assert.equal(sends.length, 1, "one real turn was submitted");

  // A repeated exchange for the same binding must preserve the first tab's
  // already-authorized socket through its next renewal.
  const second = await launch();
  const beforeReopen = received.length;
  await second.goto(conversation);
  await waitForStockUi(second);
  const secondHello = await hello(second, beforeReopen);
  assert.notEqual(secondHello.socket, terminal.socket, "each tab owns its Gateway socket");
  await second.locator(replySelector).waitFor({ state: "visible" });
  // The UI can add a display-name slug when it resolves the saved URL. Verify
  // the committed conversation identity, not that mutable presentation text.
  await second.waitForFunction((key) => {
    const snapshot = globalThis.openclawControlUi?.snapshot();
    return snapshot?.routeReady === true && snapshot.sessionKey === key;
  }, sessionKey);
  assert.equal(new URL(second.url()).origin, origin);
  assert.match(new URL(second.url()).pathname, /^\/chat\//);
  // The production native proxy renews every 25 seconds. Keep both exact
  // sockets untouched for two intervals; reconnects cannot satisfy this check.
  await delay(55_000);
  assert.ok(
    !terminal.socket.isClosed(),
    "the original reply socket survived repeat launch and renewal",
  );
  assert.ok(!secondHello.socket.isClosed(), "the reopened conversation stayed connected");
  assert.equal(sends.length, 1, "reopening never submitted another turn");

  // Sign out through the same Console that launched both windows. Neither
  // native page is navigated or manually closed until both streams are revoked.
  await consolePage.locator(".account-toggle").click();
  const signedOut = consolePage.waitForResponse(
    (res) =>
      res.url() === consoleOrigin + "/api/auth/sign-out" && res.request().method() === "POST",
  );
  const closed = Promise.all([
    terminal.socket.waitForEvent("close", { timeout: 45_000 }),
    secondHello.socket.waitForEvent("close", { timeout: 45_000 }),
  ]);
  await consolePage.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  assert.ok((await signedOut).ok());
  await closed;
  const refused = await second.goto(origin + "/settings/advanced");
  assert.equal(refused.status(), 403, "a revoked parent cannot reuse its native handle");
  assert.equal(sends.length, 1);
  await guarded.close();
  const source = await execute("git", ["rev-parse", "HEAD"], { cwd: import.meta.dirname });
  const changes = await execute("git", ["diff", "--name-only", "HEAD"], {
    cwd: import.meta.dirname,
  });
  await writeFile(
    receiptPath,
    JSON.stringify(
      {
        observedAt: new Date().toISOString(),
        source: source.stdout.trim(),
        trackedChanges: changes.stdout.trim().length > 0,
        releaseRevision: oidc.releaseRevision,
        controllerImage: oidc.controllerImage,
        agentId: agent.id,
        revisionId: rev.id,
        runtimeImagesBeforeUpgrade,
        provider: "OIDC protocol fixture; runtime and model are real",
        reopenedSameConversation: true,
        chatSubmissions: sends.length,
        originalReplySocketSurvivedRepeatLaunchAndRenewals: true,
        renewalObservationMs: 55_000,
        distinctSocketsClosedOnParentSignOut: true,
        revokedNativeRequestStatus: refused.status(),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
  t.diagnostic(`Guarded native browser receipt: ${receiptPath}`);
  t.diagnostic(
    "Guarded OIDC provider fixture: real host-only browser exchange, Gateway hello and model reply; repeated launch reopened the same conversation without a turn, the original socket survived two renewals, and parent sign-out closed both sockets.",
  );
}
