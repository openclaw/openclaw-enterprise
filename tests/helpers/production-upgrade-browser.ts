import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { Browser, BrowserContext, Page } from "playwright";
import { asRecord, isNonEmptyString } from "../../packages/utils/src/index.ts";
import { launchTrustingBrowser } from "./trusted-chromium.ts";
import { within } from "./wait-for.ts";

const timeoutMs = 20_000;
const checkpoints = ["previousPods", "candidatePods", "written", "returnedPods"] as const;

export function productionUpgradeBrowser(options: {
  certificate: string;
  origin: string;
  namespaceId: string;
  credentials: { email: string; password: string };
  revisions: { previous: string; candidate: string; recovery: string };
  record: (row: string, details: Record<string, unknown>) => Promise<void>;
}) {
  const { certificate, origin, namespaceId, credentials, revisions, record } = options;
  const url = `${origin}/console/agents?namespace=${encodeURIComponent(namespaceId)}`;
  const entryUrl = `${origin}/console/console.mjs`;
  const loginUrl = `${origin}/api/auth/sign-in/email`;
  const agents: { id: string; name: string }[] = [];
  let root: string | undefined;
  let browser: Browser | undefined;
  let session: BrowserContext;
  let warm: Page;
  let warmStart: number;
  let held: { page: Page; release: () => void } | undefined;
  let loginPosts = 0;
  let nextCheckpoint = 0;
  let phase = "checkpoint sequence";
  let failure: string | undefined;

  function rememberAgent(value: unknown) {
    const agent = asRecord(value);
    assert.ok(agent && isNonEmptyString(agent.id) && isNonEmptyString(agent.name));
    agents.push({ id: agent.id, name: agent.name });
  }

  async function expectRevision(page: Page, revision: string) {
    const meta = page.locator('meta[name="occ-build-revision"]');
    assert.equal(await meta.getAttribute("content"), revision);
  }

  async function openDocument(page: Page, revision: string) {
    const response = await page.goto(url, { waitUntil: "commit" });
    assert.equal(response?.status(), 200);
    assert.equal(response?.url(), url);
    await expectRevision(page, revision);
  }

  async function expectAgents(page: Page) {
    await page.getByRole("heading", { name: "Agents", exact: true }).waitFor();
    assert.equal(page.url(), url);
    for (const { id, name } of agents) {
      const link = page.getByRole("link", { name, exact: true });
      await link.waitFor();
      const href = await link.getAttribute("href");
      assert.ok(href);
      const target = new URL(href, origin);
      assert.equal(target.origin, origin);
      assert.equal(target.pathname, `/console/agents/${encodeURIComponent(id)}`);
    }
    assert.equal(loginPosts, 1);
  }

  async function launch() {
    const { chromium } = await import("playwright");
    // Chromium creates a Unix socket under this private root. A long rehearsal
    // TMPDIR can exceed the socket path limit before the browser starts.
    root = await mkdtemp("/tmp/occ-browser-");
    browser = await launchTrustingBrowser(chromium, root, {
      caFiles: [certificate],
      hosts: [{ host: new URL(origin).hostname, address: "127.0.0.1" }],
    });
    session = await browser.newContext();
    session.setDefaultTimeout(timeoutMs);
    session.on("request", (request) => {
      if (request.url() === loginUrl && request.method() === "POST") {
        loginPosts += 1;
      }
    });
  }

  async function signIn() {
    warm = await session.newPage();
    await openDocument(warm, revisions.previous);
    await warm.getByLabel("Email", { exact: true }).fill(credentials.email);
    await warm.getByLabel("Password").fill(credentials.password);
    const [response] = await Promise.all([
      warm.waitForResponse((item) => item.url() === loginUrl && item.request().method() === "POST"),
      warm.getByRole("button", { name: "Sign in", exact: true }).click(),
    ]);
    assert.equal(response.status(), 200);
    await expectAgents(warm);
    warmStart = await warm.evaluate(() => performance.timeOrigin);
  }

  async function holdEntry(revision: string) {
    const page = await session.newPage();
    const intercepted = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    held = { page, release: gate.resolve };
    let entryResponded = false;
    page.on("response", (response) => {
      if (response.url() === entryUrl && response.request().method() === "GET") {
        entryResponded = true;
      }
    });
    // Keep the selected HTML document while delaying its entry module before network.
    await page.route(entryUrl, async (route) => {
      intercepted.resolve();
      await gate.promise;
      await route.continue().catch(() => {});
    });
    await openDocument(page, revision);
    await within(intercepted.promise, "Console entry request", timeoutMs);
    assert.ok(!entryResponded);
  }

  async function entryBytes(page: Page) {
    const response = await page.waitForResponse(
      (item) => item.url() === entryUrl && item.request().method() === "GET",
    );
    assert.equal(response.status(), 200);
    return response.body();
  }

  async function bootHeld(revision: string, expected: Buffer) {
    assert.ok(held);
    const { page, release } = held;
    const loaded = entryBytes(page);
    release();
    assert.ok((await loaded).equals(expected));
    await expectAgents(page);
    await expectRevision(page, revision);
    await page.close();
    held = undefined;
  }

  async function openFresh(revision: string) {
    const page = await session.newPage();
    try {
      const cdp = await session.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
      const [entry] = await Promise.all([entryBytes(page), openDocument(page, revision)]);
      await expectAgents(page);
      return entry;
    } finally {
      await page.close();
    }
  }

  async function reenterAgents() {
    await warm.getByRole("link", { name: "Namespaces", exact: true }).click();
    await warm.getByRole("heading", { name: "Namespaces", exact: true }).waitFor();
    await warm.getByRole("link", { name: "Agents", exact: true }).click();
    await expectAgents(warm);
    // A fresh document would stop testing the already loaded module graph.
    assert.equal(await warm.evaluate(() => performance.timeOrigin), warmStart);
    await expectRevision(warm, revisions.previous);
  }

  async function step<T>(name: string, action: () => Promise<T>) {
    phase = name;
    const result = await action();
    await record(`Console browser ${phase}`, { disposition: "PASS" });
    return result;
  }

  async function fail(name: string) {
    failure ??= name;
    await record(`Console browser ${name}`, { disposition: "FAIL" }).catch(() => {});
  }

  return {
    async observe(row: string, details: Record<string, unknown> = {}) {
      await record(row, details);
      const markers = checkpoints.filter((field) => Object.hasOwn(details, field));
      if (failure || markers.length === 0) {
        return;
      }
      phase = "checkpoint sequence";
      try {
        const [marker] = markers;
        assert.ok(markers.length === 1 && marker === checkpoints[nextCheckpoint]);
        switch (marker) {
          case "previousPods":
            rememberAgent(details.baseline);
            await step("sandboxed Chromium and TLS trust", launch);
            await step("incumbent sign-in and Agents", signIn);
            await step("incumbent HTML with delayed entry", () => holdEntry(revisions.previous));
            break;
          case "candidatePods": {
            rememberAgent(details.accepted);
            const entry = await step("candidate fresh tab and Agents", () =>
              openFresh(revisions.candidate),
            );
            await step("incumbent HTML boots after upgrade", () =>
              bootHeld(revisions.previous, entry),
            );
            await step("warm tab reads candidate Agents", reenterAgents);
            await step("candidate HTML with delayed entry", () => holdEntry(revisions.candidate));
            break;
          }
          case "written":
            rememberAgent(details.written);
            break;
          case "returnedPods": {
            const entry = await step("recovery fresh tab and Agents", () =>
              openFresh(revisions.recovery),
            );
            await step("candidate HTML boots after return", () =>
              bootHeld(revisions.candidate, entry),
            );
            await step("warm tab reads returned Agents", reenterAgents);
            break;
          }
        }
        nextCheckpoint += 1;
      } catch {
        // Browser errors can include form or page contents. Finish the controller return first.
        await fail(phase);
      }
    },
    async close() {
      held?.release();
      try {
        await browser?.close();
      } catch {
        await fail("browser shutdown");
      } finally {
        if (root) {
          await rm(root, { recursive: true, force: true }).catch(() => fail("trust store cleanup"));
        }
      }
    },
    assertPassed() {
      assert.ok(!failure, `Console browser failed at ${failure}`);
      assert.equal(nextCheckpoint, checkpoints.length, "Console browser checkpoints incomplete");
    },
  };
}
