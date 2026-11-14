// Exercise the operator's real Console sign-in and Open Agent UI launch. Keep
// browser credentials and conversation history on this runner.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { textFromFrame, waitForStockUi } from "../../../tests/helpers/native-ui-chat.mjs";
import { launchTrustingBrowser } from "../../../tests/helpers/trusted-chromium.ts";

// Playwright runs these calls in the stock UI's page context.
declare const openclawControlUi: {
  navigate(route: "sessions", location: { pathname: string; search: string }): void;
  snapshot(): { basePath: string; routeReady: boolean; sessionKey: string };
};

type BrowserHistory = {
  agent: string;
  namespace: string;
  sessionKey: string;
  sessionId: string;
  preference: string;
};

let stage = "initialize";
let browser: Browser | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function openAgent(consolePage: Page, origin: string, sessionKey?: string) {
  const [page] = await Promise.all([
    consolePage.waitForEvent("popup", { timeout: 60_000 }),
    consolePage.getByRole("link", { name: "Open Agent UI", exact: true }).click(),
  ]);
  await page.waitForURL((url) => url.origin === origin, { timeout: 60_000 });
  const messages: { text: string; sessionKey: string }[] = [];
  page.on("websocket", (ws) => {
    if (new URL(ws.url()).origin !== origin.replace("https:", "wss:")) {
      return;
    }
    ws.on("framereceived", (frame) => {
      let event: unknown;
      try {
        event = JSON.parse(textFromFrame(frame));
      } catch {
        return;
      }
      if (!isRecord(event) || event.type !== "event" || !isRecord(event.payload)) {
        return;
      }
      const { message, sessionKey } = event.payload;
      if (
        typeof sessionKey !== "string" ||
        !isRecord(message) ||
        message.role !== "assistant" ||
        message.isError
      ) {
        return;
      }
      const terminal =
        (event.event === "chat" && event.payload.state === "final") ||
        (event.event === "session.message" &&
          isRecord(message.__openclaw) &&
          message.__openclaw.runTerminal === true);
      const { content, stopReason } = message;
      if (
        !terminal ||
        (typeof stopReason === "string" && ["toolUse", "aborted", "error"].includes(stopReason))
      ) {
        return;
      }
      let text = "";
      if (typeof content === "string") {
        text = content;
      } else if (Array.isArray(content)) {
        const parts: readonly unknown[] = content;
        for (const part of parts) {
          if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
            text += part.text;
          }
        }
      }
      messages.push({ text, sessionKey });
    });
  });
  // A document request for a chat permalink reads public chat publications.
  // Load the signed-in UI first, then open the private chat from its history.
  const response = await page.goto(new URL("/new", origin).href);
  if (!response?.ok()) {
    console.error("Control UI navigation HTTP " + (response?.status() ?? 0));
    throw new Error("Control UI navigation failed");
  }
  await waitForStockUi(page);
  if (sessionKey !== undefined) {
    stage = "search signed-in session history";
    await page.evaluate((sessionKey) => {
      const app = openclawControlUi;
      app.navigate("sessions", {
        pathname: app.snapshot().basePath + "/sessions",
        search: "?" + new URLSearchParams({ session: sessionKey, status: "all" }),
      });
    }, sessionKey);
    await page.waitForURL((url) => url.origin === origin && url.pathname === "/sessions", {
      timeout: 60_000,
    });

    // The displayed title may change. The Sessions table labels its selection
    // control with the full key and links to that same row's private chat.
    stage = "open matching session history row";
    const row = page.getByRole("row").filter({
      has: page.getByRole("checkbox", { name: "Select session: " + sessionKey, exact: true }),
    });
    const chatLink = row.locator("a.session-link");
    await chatLink.waitFor({ state: "visible", timeout: 60_000 });
    await chatLink.click();

    stage = "verify original session selected";
    await page.waitForFunction(
      (sessionKey) => {
        const state = openclawControlUi.snapshot();
        return state.routeReady === true && state.sessionKey === sessionKey;
      },
      sessionKey,
      { timeout: 90_000 },
    );
    assert.equal(new URL(page.url()).origin, origin);
  }
  async function send(prompt: string, expected: string, newChat = false) {
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
        .find(
          (m) =>
            m.text.trim() === expected && (sessionKey === undefined || m.sessionKey === sessionKey),
        );
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
  const phase = process.argv[2];
  assert.ok(phase === "onboard" || phase === "final");
  const { RUN_DIR, CONSOLE_ORIGIN, agent, namespace, revision } = process.env;
  assert.ok(RUN_DIR && CONSOLE_ORIGIN && agent && namespace && revision);
  const stateDir = join(RUN_DIR, "k3d-state");
  const historyFile = join(RUN_DIR, "browser-conversation.json");
  const state: unknown = JSON.parse(await readFile(join(stateDir, "state.json"), "utf8"));
  assert.ok(isRecord(state));
  const { browserOrigin, cluster, nativeAdminDomain } = state;
  assert.ok(typeof cluster === "string" && typeof nativeAdminDomain === "string");
  const origin = new URL(CONSOLE_ORIGIN);
  assert.equal(origin.origin, browserOrigin);
  assert.equal(origin.hostname, `console.${cluster}.oce.localhost`);
  assert.equal(origin.protocol, "https:");
  const browserDir = join(RUN_DIR, `browser-${phase}`);
  await mkdir(browserDir, { mode: 0o700 });
  stage = "launch trusted Chromium";
  browser = await launchTrustingBrowser(chromium, browserDir, {
    caFiles: [join(stateDir, "browser-ca.crt")],
    hosts: [
      { host: origin.hostname, address: "127.0.0.1" },
      { host: `*.${nativeAdminDomain}`, address: "127.0.0.1" },
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
  assert.equal((await loaded?.serverAddr())?.ipAddress, "127.0.0.1");
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
  detail.search = new URLSearchParams({ namespace, revision, tab: "workspace" }).toString();
  await owner.goto(detail.href);
  const access = await owner.evaluate(async (path) => {
    const response = await fetch(path, { mode: "same-origin", redirect: "error" });
    if (!response.ok) {
      throw new Error("Native Agent access failed");
    }
    const envelope: unknown = await response.json();
    if (typeof envelope !== "object" || envelope === null || !("data" in envelope)) {
      throw new Error("Native Agent access response is missing data");
    }
    return envelope.data;
  }, `/namespaces/${namespace}/agents/${agent}/native-admin`);
  assert.ok(isRecord(access));
  assert.equal(access.activeRevisionId, revision);
  assert.equal(access.status, "available");
  assert.ok(typeof access.origin === "string");
  const nativeOrigin = new URL(access.origin);
  assert.equal(nativeOrigin.protocol, "https:");
  assert.ok(nativeOrigin.hostname.endsWith("." + nativeAdminDomain));
  assert.equal(nativeOrigin.port, origin.port);
  allowed.add(nativeOrigin.origin);

  let history: BrowserHistory;
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
    const sessionId = /^agent:main:dashboard:([a-f0-9-]{36})$/.exec(sessionKey)?.[1];
    assert.ok(sessionId);
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
    ] as const) {
      await owner.getByText(filename + " loaded.", { exact: true }).waitFor({ state: "attached" });
      assert.ok(
        (await owner.getByLabel(filename, { exact: true }).inputValue()).includes(expected),
      );
    }
    stage = "verify ready reply";
    assert.equal(await ui.send("Reply with OCE_READY.", "OCE_READY"), sessionKey);
    await ui.page.close();
  } else {
    const saved: unknown = JSON.parse(await readFile(historyFile, "utf8"));
    assert.ok(isRecord(saved));
    assert.equal(saved.agent, agent);
    assert.equal(saved.namespace, namespace);
    const { sessionKey, sessionId, preference } = saved;
    assert.ok(
      typeof sessionKey === "string" &&
        typeof sessionId === "string" &&
        typeof preference === "string",
    );
    history = { agent, namespace, sessionKey, sessionId, preference };
  }
  stage = "reopen original conversation from chat history";
  const reopened = await openAgent(owner, nativeOrigin.origin, history.sessionKey);
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
} catch (error) {
  // Export only a source line, not a stack frame, URL or assertion operand.
  const frame = error instanceof Error && error.stack?.match(/\bbrowser\.ts:(\d{1,5}):\d+/);
  if (frame) {
    console.error("quickstart-location browser.ts:" + frame[1]);
  }
  // Playwright errors can contain URLs, form values and returned content.
  console.error(`Control UI verification failed during ${stage}.`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
