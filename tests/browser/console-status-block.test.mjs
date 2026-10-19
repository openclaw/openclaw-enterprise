import assert from "node:assert/strict";
import test from "node:test";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  detailUrl,
  fileBrowser,
  login,
  nativeValues,
  newPage,
  selectSecret,
} from "./console-agents-browser-helpers.mjs";
import {
  createRepositoryLaunchFixture,
  openAdvancedSettings,
} from "./console-agents-test-support.mjs";

// Errors, warnings and notices share one status block (UX plan C1): a stripe and wash in the
// tone's design-token colours, with the text in the body colour. A refusal after a request takes
// focus and comes into view; Share Agent left its refusal unfocused above the form, so a reader
// at phone width heard nothing (findings 1862, 1864).

// One Chromium for the file; each test still gets its own context.
const browser = fileBrowser();

// A status block's tone, whether its stripe and wash are the tone's tokens, and the contrast of
// its text with the wash laid over the surface beneath it.
const statusPaint = (locator) =>
  locator.evaluate((node) => {
    const view = globalThis;
    const tokenColor = (name, property = "color") => {
      const probe = globalThis.document.createElement("span");
      probe.style[property] = `var(--color-${name})`;
      globalThis.document.body.append(probe);
      const value = view.getComputedStyle(probe)[property];
      probe.remove();
      return value;
    };
    const rgba = (value) => {
      const [r, g, b, a = 1] = value.match(/[\d.]+/g).map(Number);
      return { r, g, b, a };
    };
    // The wash is translucent: lay each background over the one beneath until an opaque one.
    const layers = [];
    for (let at = node; at; at = at.parentElement) {
      const color = rgba(view.getComputedStyle(at).backgroundColor);
      if (color.a > 0) {
        layers.push(color);
        if (color.a === 1) {
          break;
        }
      }
    }
    const backdrop = layers.reverse().reduce(
      (below, above) => ({
        r: above.r * above.a + below.r * (1 - above.a),
        g: above.g * above.a + below.g * (1 - above.a),
        b: above.b * above.a + below.b * (1 - above.a),
      }),
      { r: 255, g: 255, b: 255 },
    );
    const luminance = ({ r, g, b }) => {
      const [lr, lg, lb] = [r, g, b].map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    const contrast = (color) => {
      const [light, dark] = [luminance(color), luminance(backdrop)].sort((a, b) => b - a);
      return (light + 0.05) / (dark + 0.05);
    };
    const style = view.getComputedStyle(node);
    const tone = node.dataset.tone;
    return {
      status: node.classList.contains("status"),
      tone,
      stripe: style.borderLeftColor === tokenColor(tone) && style.borderLeftWidth === "3px",
      wash: style.backgroundColor === tokenColor(`${tone}-subtle`, "backgroundColor"),
      bodyText: style.color === tokenColor("text"),
      contrast: Math.round(contrast(rgba(style.color)) * 100) / 100,
    };
  });

function assertPaint(paint, tone, label) {
  assert.deepEqual(
    { ...paint, contrast: paint.contrast >= 4.5 },
    { status: true, tone, stripe: true, wash: true, bodyText: true, contrast: true },
    `${label}: ${JSON.stringify(paint)}`,
  );
}

// Whether a refusal has focus and is on screen.
const refusalView = (locator) =>
  locator.evaluate((node) => {
    const { top, bottom } = node.getBoundingClientRect();
    return {
      focused: globalThis.document.activeElement === node,
      // Whole, with room for its focus ring (3 px plus a 2 px offset).
      inView: top >= 5 && top < globalThis.innerHeight && bottom <= globalThis.innerHeight - 5,
      rect: [Math.round(top), Math.round(bottom), globalThis.innerHeight, globalThis.scrollY],
    };
  });

// The API's 403 for a policy write.
const forbidden = async (route) => {
  if (route.request().method() === "GET") {
    await route.continue();
    return;
  }
  await route.fulfill({
    status: 403,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Forbidden" } }),
  });
};

// An Agent page at `viewport` with its Share Agent panel's form filled in for a provisioned
// person.
async function sharingPage(t, viewport) {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["status-recipient"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Status refusal");
  const agent = await fixture.createAgent(namespace.id, "Status Agent", nativeValues("status"));
  const { page } = await newPage(t, fixture, { browser, context: { viewport } });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"));
  const panel = page.getByRole("region", { name: "Share Agent", exact: true });
  await panel
    .getByLabel("Existing person’s Principal ID")
    .fill(fixture.provisionedAccounts[0].principal.id);
  await panel.getByRole("checkbox").check();
  return { page, panel, policyPath: `${fixture.origin}/namespaces/${namespace.id}/iam` };
}

const SHARE_REFUSAL =
  "Sharing policy requires Installation administration. Your other Agent controls remain available according to their own permissions.";

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`a Share Agent refusal is a focused danger block on screen at ${viewport.width}px`, async (t) => {
    const { page, panel, policyPath } = await sharingPage(t, viewport);
    // The policy read succeeds; the first write is refused.
    await page.route(`${policyPath}/roles`, forbidden);
    // Submitted from the keyboard, as a reader who then hears the outcome would.
    await panel.getByRole("button", { name: "Share Agent", exact: true }).focus();
    await page.keyboard.press("Enter");
    const alert = panel.getByRole("alert").filter({ hasText: SHARE_REFUSAL });
    await alert.waitFor();
    const view = await refusalView(alert);
    t.diagnostic(JSON.stringify(view));
    assert.equal(view.focused, true, "the refusal has focus");
    assert.equal(view.inView, true, "the refusal is on screen");
    // Every existing word is kept.
    assert.equal(
      await alert.textContent(),
      `${SHARE_REFUSAL} Refresh sharing to inspect current policy before another change.`,
    );
    assertPaint(await statusPaint(alert), "danger", "Share refusal");
  });
}

// Remove binding sits below the grants list, and its refusal shows above the form. On a phone
// whose visible area is short (a small screen, or the browser's bars shown), the refusal was
// above the fold and unfocused: the reader saw the list collapse and nothing else.
test("a refused binding removal at 390px brings its refusal on screen with focus", async (t) => {
  const { page, panel, policyPath } = await sharingPage(t, { width: 390, height: 560 });
  await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
  await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
  await page.route(`${policyPath}/access-bindings/*`, forbidden);
  const remove = panel.getByRole("button", { name: "Remove binding", exact: true }).first();
  await remove.focus();
  await page.keyboard.press("Enter");
  const alert = panel.getByRole("alert").filter({ hasText: SHARE_REFUSAL });
  await alert.waitFor();
  const view = await refusalView(alert);
  t.diagnostic(JSON.stringify(view));
  assert.equal(view.focused, true, "the refusal has focus");
  assert.equal(view.inView, true, "the refusal is on screen");
  assertPaint(await statusPaint(alert), "danger", "removal refusal");
});

// A reader who moved focus out of Share Agent while the request ran keeps it there: the refusal
// is shown, but it does not pull focus back (finding 1984).
test("a Share Agent refusal leaves focus where the reader moved it", async (t) => {
  const { page, panel, policyPath } = await sharingPage(t, { width: 1440, height: 900 });
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let sent;
  const writing = new Promise((resolve) => {
    sent = resolve;
  });
  await page.route(`${policyPath}/roles`, async (route) => {
    if (route.request().method() !== "GET") {
      sent();
      await held;
    }
    await forbidden(route);
  });
  await panel.getByRole("button", { name: "Share Agent", exact: true }).focus();
  await page.keyboard.press("Enter");
  await writing;
  const elsewhere = page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("link")
    .first();
  await elsewhere.focus();
  release();
  const alert = panel.getByRole("alert").filter({ hasText: SHARE_REFUSAL });
  await alert.waitFor();
  assert.equal(
    await elsewhere.evaluate((node) => node === globalThis.document.activeElement),
    true,
    "focus stays where the reader moved it",
  );
  assert.equal((await refusalView(alert)).focused, false, "the refusal does not take focus");
});

// A warning and an informational notice on the same tab: the API-key plugin warning and the
// note on which version the tab edits.
test("warning and info notices use their tone's token colours with readable text", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const driver = new CodexPluginDriver({ catalogSource: "openai-curated" });
  fixture.controller.registerDriver(driver);
  fixture.controller.selectDriver("plugin", driver.id);
  const namespace = await fixture.createNamespace("Status notices", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Status notices",
    nativeValues("status-notices", { harnessId: "codex" }),
    { executionMode: "dedicated" },
  );
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "plugins"));
  const warning = page.getByText(
    "Codex plugins need a ChatGPT login. This Agent uses an API key, so each selected plugin is disabled when it deploys (PLUGIN_AUTH_REQUIRED). Change its Harness authentication under Credentials to use plugins.",
    { exact: true },
  );
  await warning.waitFor();
  assertPaint(await statusPaint(warning), "warning", "API-key plugin warning");
  const info = page.locator(".version-selection-notice");
  assert.equal(
    await info.textContent(),
    "Plugin changes to this Agent appear in the next deployment. Existing versions stay unchanged.",
  );
  assert.equal(await info.getAttribute("role"), "status");
  assertPaint(await statusPaint(info), "info", "version notice");
});

// An empty live block keeps its place in the accessibility tree with no box: a live region
// announces a change only if it was in the tree before the change. The sign-in alert stays empty
// while the request runs, then the same node takes the refusal.
test("an empty alert block stays in the accessibility tree until its refusal arrives", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const { page } = await newPage(t, fixture, { browser });
  const cdp = await page.context().newCDPSession(page);
  // The sign-in alert's DOM node and its node in Chromium's accessibility tree, if it has one.
  const signInAlert = async () => {
    const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdp.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: "form p.status[role=alert]",
    });
    const { node } = await cdp.send("DOM.describeNode", { nodeId });
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    const exposed = nodes.find(
      (candidate) => candidate.backendDOMNodeId === node.backendNodeId && !candidate.ignored,
    );
    return { backendNodeId: node.backendNodeId, role: exposed?.role?.value ?? null };
  };
  await page.goto(new URL("/console/login", fixture.origin).href);
  // The sign-in request is held until the empty alert has been read.
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const reached = new Promise((resolve) => {
    void page.route("**/api/auth/sign-in/email", async (route) => {
      resolve();
      await held;
      await route.continue();
    });
  });
  await page.getByLabel("Username").fill(fixture.credentials.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Login" }).click();
  await reached;
  const pending = await signInAlert();
  assert.equal(await page.locator("form p.status[role=alert]").textContent(), "");
  assert.equal(pending.role, "alert", "the empty alert is in the accessibility tree");
  const box = await page.locator("form p.status[role=alert]").boundingBox();
  assert.equal(box?.height, 0, "the empty alert takes no space");
  release();
  await page.getByText("Could not sign in. Check your username and password.").waitFor();
  const refused = await signInAlert();
  assert.deepEqual(refused, { backendNodeId: pending.backendNodeId, role: "alert" });
});

// A feedback line's class, tone, role and text.
const lineState = (locator) =>
  locator.evaluate((node) => ({
    className: node.className,
    tone: node.dataset.tone ?? null,
    role: node.getAttribute("role"),
    text: node.textContent,
  }));

// Records the role a feedback line has each time its text is written: a refusal is written into
// an alert, not into a status that turns into one afterwards (finding 2010).
const recordWrites = (locator) =>
  locator.evaluate((node) => {
    const own = Object.getOwnPropertyDescriptor(globalThis.Node.prototype, "textContent");
    const writes = [];
    node.recordedWrites = writes;
    Object.defineProperty(node, "textContent", {
      configurable: true,
      get() {
        return own.get.call(this);
      },
      set(value) {
        writes.push({ text: String(value), role: this.getAttribute("role") });
        own.set.call(this, value);
      },
    });
  });
const rolesWhenWritten = (locator, text) =>
  locator.evaluate(
    (node, written) =>
      node.recordedWrites.filter((write) => write.text === written).map((write) => write.role),
    text,
  );

// A route answer held until the test releases it.
function holdRequests(t) {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let reached;
  const reaching = new Promise((resolve) => {
    reached = resolve;
  });
  return { held, reaching, reached: () => reached(), release: () => release() };
}

// A draft Agent's Credentials tab with an API key Secret chosen for its authentication source.
async function authenticationSourcePage(t, name, { harnessId } = {}) {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(`Status ${name}`, { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    `Status ${name}`,
    nativeValues(name, harnessId ? { harnessId } : {}),
    harnessId ? { executionMode: "dedicated" } : undefined,
  );
  const secret = await fixture.createSecret(namespace.id, "Status key", "synthetic-status-key");
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "credentials"));
  if (!harnessId) {
    await page.getByLabel("Authentication source").selectOption("api_key");
    await selectSecret(page, "API key Secret", secret);
  }
  const save = page.getByRole("button", { name: "Save authentication source" });
  // The form's own feedback line, its last child.
  const feedback = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Reload authentication source" }) })
    .locator(":scope > p")
    .last();
  return {
    fixture,
    namespace,
    agent,
    page,
    save,
    feedback,
    agentUrl: `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`,
  };
}

// Saving the Credentials tab's authentication source and the Repositories editor showed their
// refusals in the grey hint line that also carries progress, unfocused (finding 1966).
test("a refused authentication source save is a focused danger block", async (t) => {
  const { fixture, namespace, agent, page, save } = await authenticationSourcePage(t, "auth");
  // Saved elsewhere while this tab was open: the save's preflight read refuses it.
  const changed = await fixture.request("PATCH", `/namespaces/${namespace.id}/agents/${agent.id}`, {
    body: { configurationId: agent.configurationId, harnessAuth: null },
  });
  assert.equal(changed.status, 200);
  await save.click();
  const refusal = page
    .getByRole("alert")
    .filter({ hasText: "The Configuration changed. Reload authentication source before saving." });
  await refusal.waitFor();
  assertPaint(await statusPaint(refusal), "danger", "authentication refusal");
  const view = await refusalView(refusal);
  assert.equal(view.focused, true, "the refusal has focus");
  assert.equal(view.inView, true, "the refusal is on screen");
});

test("a refused repository access save is a focused danger block", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1600",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(namespace.id, "Status repos", nativeValues("repos"));
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  const access = (defaultProfile) => ({
    configurationId: agent.configurationId,
    repositoryAccess: { defaultProfile, repositories: [{ repositoryRef: "application" }] },
  });
  assert.equal(
    (await fixture.request("PATCH", agentPath, { body: access("git-full") })).status,
    200,
  );
  const { page } = await newPage(t, fixture, { browser });
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "repositories"));
  await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
  // Saved elsewhere while this tab was open.
  assert.equal(
    (await fixture.request("PATCH", agentPath, { body: access("git-write") })).status,
    200,
  );
  await page.locator("#repository-default-git-read").check();
  await page.getByRole("button", { name: "Save repository access" }).click();
  const refusal = page.getByRole("alert").filter({
    hasText: "Repository access changed while you were editing. Reload this draft before saving.",
  });
  await refusal.waitFor();
  assertPaint(await statusPaint(refusal), "danger", "repository refusal");
  const view = await refusalView(refusal);
  assert.equal(view.focused, true, "the refusal has focus");
  assert.equal(view.inView, true, "the refusal is on screen");
});

const AGENT_REFUSAL =
  "You do not have permission to save this Agent. Ask an administrator for Agent update and Configuration read access, plus access to the Secrets, credential sources and Service Account it binds.";

// The API's 403 (not only the preflight conflict above) was the original grey, unfocused hint
// (findings 1966, 2004). A later save's progress is a quiet status again.
test("an API-refused authentication source save is a focused alert, and the next save's progress a status", async (t) => {
  const { page, save, feedback, agentUrl } = await authenticationSourcePage(t, "auth-403");
  await recordWrites(feedback);
  const reads = holdRequests(t);
  let holdNextRead = false;
  await page.route(agentUrl, async (route) => {
    if (route.request().method() === "GET" && holdNextRead) {
      holdNextRead = false;
      reads.reached();
      await reads.held;
    }
    await forbidden(route);
  });
  await save.click();
  const refusal = page.getByRole("alert").filter({ hasText: AGENT_REFUSAL });
  await refusal.waitFor();
  assert.deepEqual(await lineState(feedback), {
    className: "status",
    tone: "danger",
    role: "alert",
    text: AGENT_REFUSAL,
  });
  assertPaint(await statusPaint(refusal), "danger", "authentication 403");
  const view = await refusalView(refusal);
  assert.equal(view.focused, true, "the refusal has focus");
  assert.equal(view.inView, true, "the refusal is on screen");
  assert.deepEqual(await rolesWhenWritten(feedback, AGENT_REFUSAL), ["alert"]);

  // Saving again: while its preflight read runs, the line is quiet progress, not the old refusal.
  holdNextRead = true;
  await save.click();
  await reads.reaching;
  assert.deepEqual(await lineState(feedback), {
    className: "hint",
    tone: null,
    role: "status",
    text: "Saving authentication…",
  });
  reads.release();
  await refusal.waitFor();
});

// Incomplete fields the form cannot catch (a ChatGPT sign-in not finished) refuse the save too.
test("an authentication source save without its ChatGPT sign-in is a focused alert", async (t) => {
  const { page, save, feedback } = await authenticationSourcePage(t, "auth-oauth", {
    harnessId: "codex",
  });
  await page.getByLabel("Authentication source").selectOption("credential_source");
  await save.click();
  const refusal = page
    .getByRole("alert")
    .filter({ hasText: "Complete ChatGPT sign-in before saving." });
  await refusal.waitFor();
  assert.deepEqual(await lineState(feedback), {
    className: "status",
    tone: "danger",
    role: "alert",
    text: "Complete ChatGPT sign-in before saving.",
  });
  assert.equal((await refusalView(refusal)).focused, true, "the refusal has focus");
});

const SECRET_ACCESS_UNCONFIRMED =
  /^Authentication source saved, but this Agent's Secret access could not be confirmed\. /;

// A saved source whose Secret grant was refused is a warning, also when the tab is rebuilt.
test("an authentication source saved with its Secret access unconfirmed stays a warning alert", async (t) => {
  const { fixture, namespace, page, save, feedback } = await authenticationSourcePage(
    t,
    "auth-grant",
  );
  await page.route(`${fixture.origin}/namespaces/${namespace.id}/iam/**`, forbidden);
  await save.click();
  const warning = page.getByRole("alert").filter({ hasText: SECRET_ACCESS_UNCONFIRMED });
  await warning.waitFor();
  const state = await lineState(feedback);
  assert.deepEqual(
    { ...state, text: SECRET_ACCESS_UNCONFIRMED.test(state.text) },
    { className: "status", tone: "warning", role: "alert", text: true },
  );
  assertPaint(await statusPaint(warning), "warning", "unconfirmed Secret access");
  assert.equal((await refusalView(warning)).focused, true, "the warning has focus");

  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  const kept = page.getByRole("alert").filter({
    hasText:
      "Authentication source saved. Retry credential access to confirm this Agent can use the selected Secret.",
  });
  await kept.waitFor();
  assert.deepEqual(
    { ...(await lineState(kept)), text: undefined },
    { className: "status", tone: "warning", role: "alert", text: undefined },
  );
});

// An unknown outcome is a danger alert, also when the tab is rebuilt.
test("an authentication source save with an unknown outcome stays a danger alert", async (t) => {
  const { page, save, agentUrl } = await authenticationSourcePage(t, "auth-unknown");
  await page.route(agentUrl, async (route) => {
    if (route.request().method() === "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 502,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "BAD_GATEWAY", message: "Bad gateway" } }),
    });
  });
  await save.click();
  await page.locator("form > p.status[data-tone=danger][role=alert]").waitFor();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("tab", { name: "Credentials", exact: true }).click();
  const kept = page.getByRole("alert").filter({
    hasText: "Outcome unknown. Reload authentication source before saving again.",
  });
  await kept.waitFor();
  assert.deepEqual(
    { ...(await lineState(kept)), text: undefined },
    { className: "status", tone: "danger", role: "alert", text: undefined },
  );
});

// The Repositories editor's 403 is a focused alert too (finding 2004); an edit or a held
// navigation turns the line back into a quiet status.
test("an API-refused repository access save is a focused alert until the next edit or navigation", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId) => [
    {
      repositoryRef: "application",
      repositoryId: "1601",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  const agent = await fixture.createAgent(namespace.id, "Status repos 403", nativeValues("r403"));
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  assert.equal(
    (
      await fixture.request("PATCH", agentPath, {
        body: {
          configurationId: agent.configurationId,
          repositoryAccess: {
            defaultProfile: "git-full",
            repositories: [{ repositoryRef: "application" }],
          },
        },
      })
    ).status,
    200,
  );
  const { page } = await newPage(t, fixture, { browser });
  await page.route(`${fixture.origin}${agentPath}`, forbidden);
  await login(page, fixture, detailUrl(fixture, namespace.id, agent.id, "draft", "repositories"));
  await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
  const save = page.getByRole("button", { name: "Save repository access" });
  const feedback = page
    .locator("section.agent-card")
    .filter({ has: save })
    .locator(":scope > p")
    .last();
  await recordWrites(feedback);
  const refuse = async () => {
    await save.click();
    const refusal = page.getByRole("alert").filter({ hasText: AGENT_REFUSAL });
    await refusal.waitFor();
    assert.deepEqual(await lineState(feedback), {
      className: "status",
      tone: "danger",
      role: "alert",
      text: AGENT_REFUSAL,
    });
    return refusal;
  };
  await page.locator("#repository-default-git-read").check();
  const refusal = await refuse();
  assertPaint(await statusPaint(refusal), "danger", "repository 403");
  const view = await refusalView(refusal);
  assert.equal(view.focused, true, "the refusal has focus");
  assert.equal(view.inView, true, "the refusal is on screen");
  assert.deepEqual(await rolesWhenWritten(feedback, AGENT_REFUSAL), ["alert"]);

  // An edit (back to the saved access): guidance in a quiet status.
  await page.locator("#repository-default-git-full").check();
  assert.deepEqual(await lineState(feedback), {
    className: "hint",
    tone: null,
    role: "status",
    text: "No repository changes to save.",
  });

  // Refused again, then leaving the tab with the edit unsaved: the hold is a quiet status too.
  await page.locator("#repository-default-git-read").check();
  await refuse();
  await page.getByRole("link", { name: "← Agents", exact: true }).click();
  assert.deepEqual(await lineState(feedback), {
    className: "hint",
    tone: null,
    role: "status",
    text: "Save or cancel repository changes before leaving this tab.",
  });
});

// A member who reads the Agent, its versions and its Configuration, and may change none of them.
function createReader(fixture, namespace, name) {
  return fixture.createAccountWithPolicy(name, (principal) => {
    fixture.policy.roles.push({
      id: `role-${name}`,
      namespaceId: namespace.id,
      permissions: ["namespace", "agent", "agent_revision", "configuration"].map(
        (resourceKind) => ({ action: "read", resourceKind }),
      ),
    });
    fixture.policy.bindings.push({
      id: `binding-${name}`,
      namespaceId: namespace.id,
      subjectKind: "identity",
      subjectId: principal.id,
      roleId: `role-${name}`,
    });
  });
}

const CONFIGURATION_REFUSAL =
  "You do not have permission to save this Configuration. Ask an administrator for Configuration update access, plus Secret operate on each Secret it binds.";

// A reader's refused Configuration save was a status line under the editor, neither announced
// as an alert nor focused, and cut by the fold at 1440 (finding 1991).
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`a reader's refused Configuration save is a focused alert on screen at ${viewport.width}px`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Status config refusal", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Status config", nativeValues("cfg"));
    const reader = await createReader(fixture, namespace, "status-config-reader");
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
      reader.credentials,
    );
    await page.getByRole("button", { name: "Edit Configuration" }).click();
    await openAdvancedSettings(page);
    const editor = page.getByLabel("Configuration JSON");
    await editor.fill(JSON.stringify(nativeValues("edited by a reader"), null, 2));
    await page.getByRole("button", { name: "Save Configuration" }).click();
    const alert = page.getByRole("alert").filter({ hasText: CONFIGURATION_REFUSAL });
    await alert.waitFor();
    const view = await refusalView(alert);
    t.diagnostic(JSON.stringify(view));
    assert.equal(view.focused, true, "the refusal has focus");
    assert.equal(view.inView, true, "the refusal is on screen");
    assertPaint(await statusPaint(alert), "danger", "Configuration refusal");
    // An edit clears it; the line is a status again for the next save's progress.
    await editor.fill(JSON.stringify(nativeValues("edited again"), null, 2));
    assert.equal(
      await page.locator("#configuration-editor-feedback").getAttribute("role"),
      "status",
    );
  });
}

const CONFIGURATION_CHANGED =
  "The saved Configuration changed while you were editing. Reload this draft before saving.";

// The Configuration editor's draft for `agent`, open with an edit, and its feedback line.
async function editConfiguration(page, fixture, namespace, agent, marker, credentials) {
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, "draft", "configuration"),
    credentials,
  );
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  await openAdvancedSettings(page);
  await page.getByLabel("Configuration JSON").fill(JSON.stringify(nativeValues(marker), null, 2));
  return page.locator("#configuration-editor-feedback");
}

// The pre-save reread's conflict was written while the line was still a status, and became an
// alert only afterwards (finding 2010). Holding navigation turns it back into a quiet status.
test("a Configuration save conflict is written into an alert, and a navigation hold is a status", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Status config conflict", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Status conflict", nativeValues("cc"));
  const { page } = await newPage(t, fixture, { browser });
  const feedback = await editConfiguration(page, fixture, namespace, agent, "edited here");
  await recordWrites(feedback);
  // Saved elsewhere while this editor was open.
  await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("other"));
  await page.getByRole("button", { name: "Save Configuration" }).click();
  await page.getByRole("alert").filter({ hasText: CONFIGURATION_CHANGED }).waitFor();
  assert.deepEqual(await lineState(feedback), {
    className: "status",
    tone: "danger",
    role: "alert",
    text: CONFIGURATION_CHANGED,
  });
  assert.deepEqual(await rolesWhenWritten(feedback, CONFIGURATION_CHANGED), ["alert"]);

  await page.getByRole("link", { name: "← Agents", exact: true }).click();
  assert.deepEqual(await lineState(feedback), {
    className: "hint",
    tone: null,
    role: "status",
    text: "Reload this draft before leaving the editor.",
  });
});

// After a refused save the line is an alert; the next save's progress and Cancel each make it a
// quiet status again (finding 2010).
test("a refused Configuration save's alert gives way to a status for progress and Cancel", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Status config resets", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Status resets", nativeValues("cr"));
  const reader = await createReader(fixture, namespace, "status-config-resets");
  const { page } = await newPage(t, fixture, { browser });
  const reads = holdRequests(t);
  let holdNextRead = false;
  await page.route(`**/configurations/${agent.configurationId}`, async (route) => {
    if (route.request().method() === "GET" && holdNextRead) {
      holdNextRead = false;
      reads.reached();
      await reads.held;
    }
    await route.continue();
  });
  const feedback = await editConfiguration(
    page,
    fixture,
    namespace,
    agent,
    "edited by a reader",
    reader.credentials,
  );
  const save = page.getByRole("button", { name: "Save Configuration" });
  const refused = async () => {
    await page.getByRole("alert").filter({ hasText: CONFIGURATION_REFUSAL }).waitFor();
    assert.deepEqual(await lineState(feedback), {
      className: "status",
      tone: "danger",
      role: "alert",
      text: CONFIGURATION_REFUSAL,
    });
  };
  await save.click();
  await refused();

  // Save stays enabled with the draft still edited; its preflight is quiet progress.
  holdNextRead = true;
  await save.click();
  await reads.reaching;
  assert.deepEqual(await lineState(feedback), {
    className: "hint",
    tone: null,
    role: "status",
    text: "Checking Configuration…",
  });
  reads.release();
  await refused();

  // Cancel closes the editor; opened again, its line is a quiet status.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Edit Configuration" }).click();
  assert.deepEqual(
    { ...(await lineState(feedback)), text: undefined },
    { className: "hint", tone: null, role: "status", text: undefined },
  );
});

// Run diagnostics needs Agent operate. A reader without it saw the button enabled beside a
// disabled Stop and Delete, and its 403 landed below the fold at 1440 (finding 1992).
test("Run diagnostics is disabled with its reason for a reader without operate", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Status diagnostics reader", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Diagnostics reader", nativeValues("dr"));
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const reader = await createReader(fixture, namespace, "status-diagnostics-reader");
  const { page } = await newPage(t, fixture, { browser });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    reader.credentials,
  );
  // The same answer that disables Stop disables Run diagnostics.
  await page.getByText("Your access does not include stopping this Agent.").waitFor();
  const observations = page.locator(".version-diagnostics");
  const reason = observations
    .getByRole("status")
    .filter({ hasText: "Your access does not include running diagnostics for this Agent." });
  await reason.waitFor();
  assertPaint(await statusPaint(reason), "info", "diagnostics reason");
  const run = observations.getByRole("button", { name: "Run diagnostics for this version" });
  assert.equal(await run.isDisabled(), true);
});

// A 403 that still happens (the permission answer allowed it, the API refused) comes into view
// below the button, which keeps focus (since #2779).
for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`a refused Run diagnostics brings its alert on screen at ${viewport.width}px`, async (t) => {
    const fixture = await createConsoleAppFixture(t);
    await fixture.bootstrap();
    const namespace = await fixture.createNamespace("Status diagnostics refusal", { ready: true });
    const agent = await fixture.createAgent(namespace.id, "Diagnostics denied", nativeValues("dd"));
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await page.route("**/deployments/*/diagnostics", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "FORBIDDEN", message: "Forbidden" } }),
      }),
    );
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, active.revision.id, "configuration"),
    );
    const observations = page.locator(".version-diagnostics");
    const run = observations.getByRole("button", { name: "Run diagnostics for this version" });
    await run.waitFor();
    // As the live walk did: the button at the bottom of the screen, pressed by pointer.
    await run.evaluate((node) => node.scrollIntoView({ block: "end" }));
    await run.click();
    const alert = observations
      .getByRole("alert")
      .filter({ hasText: "Diagnostics require Agent read and operate access" });
    await alert.waitFor();
    const view = await refusalView(alert);
    t.diagnostic(JSON.stringify(view));
    assert.equal(view.inView, true, "the refusal is on screen");
    assert.deepEqual(
      await run.evaluate((node) => {
        const { top, bottom } = node.getBoundingClientRect();
        return {
          focused: globalThis.document.activeElement === node,
          inView: top >= 0 && bottom <= globalThis.innerHeight,
        };
      }),
      { focused: true, inView: true },
      "the button keeps focus, on screen",
    );
  });
}
