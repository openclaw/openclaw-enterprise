// Exercise the operator's real Console sign-in and Open Agent UI launch. Keep
// browser credentials, conversation content, and the history URL on this runner.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { launchTrustingBrowser } from "../../../tests/helpers/dev-up-keycloak.mjs";
import { textFromFrame, waitForStockUi } from "../../../tests/helpers/native-ui-chat.mjs";

const { RUN_DIR, CONSOLE_ORIGIN, agent, namespace, revision } = process.env;
const phase = process.argv[2];
assert.ok(["onboard", "final"].includes(phase));
const stateDir = join(RUN_DIR, "k3d-state");
const historyFile = join(RUN_DIR, "browser-conversation.json");
let stage = "initialize";
let browser;

async function openAgent(consolePage, origin, route) {
  const [page] = await Promise.all([
    consolePage.waitForEvent("popup"),
    consolePage.getByRole("link", { name: "Open Agent UI", exact: true }).click(),
  ]);
  await page.waitForURL((url) => url.origin === origin);
  const messages = [];
  page.on("websocket", (ws) => {
    if (new URL(ws.url()).origin !== origin.replace("https:", "wss:")) {
      return;
    }
    ws.on("framereceived", (frame) => {
      let event;
      try {
        event = JSON.parse(textFromFrame(frame));
      } catch {
        return;
      }
      if (event?.type !== "event" || !event.payload) {
        return;
      }
      const { message, sessionKey } = event.payload;
      if (message?.role !== "assistant" || message.isError) {
        return;
      }
      const terminal =
        (event.event === "chat" && event.payload.state === "final") ||
        (event.event === "session.message" && message.__openclaw?.runTerminal === true);
      if (!terminal || ["toolUse", "aborted", "error"].includes(message.stopReason)) {
        return;
      }
      const text =
        typeof message.content === "string"
          ? message.content
          : (Array.isArray(message.content) ? message.content : [])
              .filter((part) => part?.type === "text" && typeof part.text === "string")
              .map((part) => part.text)
              .join("");
      messages.push({ text, sessionKey });
    });
  });
  // Reopen the captured chat permalink through the fresh Agent UI tab. The
  // sidebar can filter or collapse history, so its visible rows are not a
  // stable index into an Agent's conversations.
  if (route) {
    assert.match(route.path, /^\/chat\/main\/[^/?#]+$/);
  }
  const destination = new URL(route?.path ?? "/new", origin);
  assert.equal(destination.origin, origin);
  const response = await page.goto(destination.href);
  assert.ok(response?.ok());
  await waitForStockUi(page);
  if (route) {
    // The app may change the title slug during navigation. Prove it loaded
    // this conversation before sending to it, then require the full session
    // key on the newly submitted recall turn's terminal reply below.
    await page.waitForURL((url) => url.origin === origin && url.pathname.startsWith("/chat/main/"));
    await page
      .getByText("OCE_READY", { exact: true })
      .first()
      .waitFor({ state: "attached", timeout: 60_000 });
  }
  async function send(prompt, expected, newChat = false) {
    const editor = page.locator(".agent-chat__composer-combobox > textarea").first();
    await editor.fill(prompt);
    const start = messages.length;
    await page
      .getByRole("button", { name: newChat ? "Start session" : "Send message", exact: true })
      .click();
    const deadline = Date.now() + 360_000;
    while (Date.now() < deadline) {
      const result = messages
        .slice(start)
        .find((m) => m.text.trim() === expected && (!route || m.sessionKey === route.sessionKey));
      if (result) {
        return result.sessionKey;
      }
      await delay(500);
    }
    throw new Error("Expected a new terminal assistant message");
  }
  return { page, send };
}

try {
  const state = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
  const origin = new URL(CONSOLE_ORIGIN);
  assert.equal(origin.origin, state.browserOrigin);
  assert.equal(origin.hostname, `console.${state.cluster}.oce.localhost`);
  assert.equal(origin.protocol, "https:");
  const browserDir = join(RUN_DIR, `browser-${phase}`);
  await mkdir(browserDir, { mode: 0o700 });
  stage = "launch trusted Chromium";
  browser = await launchTrustingBrowser(chromium, browserDir, {
    caFiles: [join(stateDir, "browser-ca.crt")],
    hosts: [
      { host: origin.hostname, address: "127.0.0.1" },
      { host: `*.${state.nativeAdminDomain}`, address: "127.0.0.1" },
      { host: "*", address: "~NOTFOUND" },
    ],
  });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const allowed = new Set([origin.origin]);
  await context.route("**/*", (route) =>
    allowed.has(new URL(route.request().url()).origin) ? route.continue() : route.abort(),
  );
  stage = "sign in to Console";
  const owner = await context.newPage();
  const loaded = await owner.goto(new URL("/console/", origin).href);
  assert.equal((await loaded.serverAddr())?.ipAddress, "127.0.0.1");
  await owner.getByLabel("Email", { exact: true }).fill("admin@development.openclaw.invalid");
  assert.equal(new URL(owner.url()).origin, origin.origin);
  await owner
    .getByLabel("Password", { exact: true })
    .fill((await readFile(join(stateDir, "initial-admin-password"), "utf8")).trim());
  const [login] = await Promise.all([
    owner.waitForResponse(
      (res) =>
        res.url() === origin.origin + "/api/auth/sign-in/email" &&
        res.request().method() === "POST",
    ),
    owner.getByRole("button", { name: "Sign in", exact: true }).click(),
  ]);
  assert.equal(login.status(), 200);
  await owner.getByLabel("Password", { exact: true }).waitFor({ state: "hidden" });
  stage = "resolve the running revision";
  const detail = new URL(`/console/agents/${agent}`, origin);
  detail.search = new URLSearchParams({ namespace, revision, tab: "workspace" });
  await owner.goto(detail.href);
  const access = await owner.evaluate(async (path) => {
    const response = await fetch(path, { mode: "same-origin", redirect: "error" });
    if (!response.ok) {
      throw new Error("Native Agent access failed");
    }
    return (await response.json()).data;
  }, `/namespaces/${namespace}/agents/${agent}/native-admin`);
  assert.equal(access.activeRevisionId, revision);
  assert.equal(access.status, "available");
  const nativeOrigin = new URL(access.origin);
  assert.equal(nativeOrigin.protocol, "https:");
  assert.ok(nativeOrigin.hostname.endsWith("." + state.nativeAdminDomain));
  assert.equal(nativeOrigin.port, origin.port);
  allowed.add(nativeOrigin.origin);

  let history;
  if (phase === "onboard") {
    stage = "complete onboarding";
    const ui = await openAgent(owner, nativeOrigin.origin);
    const id = randomUUID().slice(0, 8);
    const name = "Wren-" + id;
    const preference = "saffron-" + randomUUID();
    const marker = "OCE_ONBOARDED_" + id;
    const sessionKey = await ui.send(
      `Complete first-run onboarding in this workspace. Your name is ${name}; my name is Alex, and my preferred project color is ${preference}. Use sensible defaults for the rest. Save your name to IDENTITY.md and my preference to USER.md. Follow BOOTSTRAP.md and remove it when finished. Then reply with exactly ${marker}.`,
      marker,
      true,
    );
    assert.match(sessionKey, /^agent:main:dashboard:[a-f0-9-]{36}$/);
    const sessionId = sessionKey.split(":").at(-1);
    await ui.page.waitForURL((url) => url.pathname.startsWith("/chat/main/"));
    history = {
      agent,
      namespace,
      sessionKey,
      sessionId,
      preference,
    };
    stage = "verify Workspace identity and preference";
    await owner.reload();
    for (const [filename, expected] of [
      ["IDENTITY.md", name],
      ["USER.md", preference],
    ]) {
      await owner.getByText(filename + " loaded.", { exact: true }).waitFor({ state: "attached" });
      assert.ok(
        (await owner.getByLabel(filename, { exact: true }).inputValue()).includes(expected),
      );
    }
    stage = "verify ready reply";
    assert.equal(await ui.send("Reply with OCE_READY.", "OCE_READY"), sessionKey);
    history.path = new URL(ui.page.url()).pathname;
    await ui.page.close();
  } else {
    history = JSON.parse(await readFile(historyFile, "utf8"));
    assert.equal(history.agent, agent);
    assert.equal(history.namespace, namespace);
  }
  stage = "reopen original conversation from chat history";
  const reopened = await openAgent(owner, nativeOrigin.origin, history);
  stage = "recall saved preference";
  const nonce = "OCE_RECALL_" + randomUUID().slice(0, 8);
  await reopened.send(
    `What is my preferred project color? Reply with exactly ${nonce}, a space, and its saved value.`,
    nonce + " " + history.preference,
  );
  if (phase === "onboard") {
    await writeFile(historyFile, JSON.stringify(history), { mode: 0o600, flag: "wx" });
  }
  await writeFile(
    join(RUN_DIR, `receipt-browser-${phase}.json`),
    JSON.stringify({
      phase,
      agentId: agent,
      namespaceId: namespace,
      revisionId: revision,
      sessionId: history.sessionId,
      terminalAssistant: true,
      preferenceRecalled: true,
      ...(phase === "onboard" ? { workspaceVerified: true } : {}),
    }),
    { mode: 0o600, flag: "wx" },
  );
} catch {
  // Playwright errors can contain URLs, form values and returned content.
  console.error(`Control UI verification failed during ${stage}.`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
