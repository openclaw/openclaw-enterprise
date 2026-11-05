import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { BrowserContextOptions, Locator, Page, Route } from "playwright";

import type { AgentWire, NamespaceWire } from "../../packages/contracts/src/api/resources.ts";
import type { PermissionAction } from "../../packages/contracts/src/index.ts";

import { CodexPluginDriver } from "../../apps/controller/src/drivers/plugin/index.ts";
import { apiErrorResponse, proxyErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { createReadyConsoleNamespace } from "../helpers/console-ready-namespace.mjs";
import {
  consoleViewports,
  detailUrl,
  fileBrowser,
  hasFocus,
  holdRequests,
  login,
  nativeValues,
  newPage,
  selectSecret,
  statusTone,
  grantStaleConfigurationUpdate,
} from "./console-agents-browser-helpers.mjs";
import {
  createRepositoryLaunchFixture,
  openAdvancedSettings,
  withholdPermissionSummary,
} from "./console-agents-test-support.mjs";
import {
  AGENT_SAVE_DENIED,
  CONFIGURATION_SAVE_DENIED,
  DIAGNOSTICS_DENIED,
  notIncluded,
  RELOAD_DRAFT_BEFORE_SAVING,
  REPOSITORY_ACCESS_CHANGED,
  REPOSITORY_EDITS_PENDING,
} from "../helpers/refusal-text.mjs";

// Errors, warnings and notices share one status block (UX plan C1): a wash in the tone's
// design-token colour, with the text in the body colour. Errors and warnings retain a stripe;
// the version-selection notice has a quieter border. A refusal after a request takes
// focus and comes into view; Share Agent left its refusal unfocused above the form, so a reader
// at phone width heard nothing (findings 1862, 1864).
//
// Each top-level test starts one console for the cases that share its setup; each case is a
// subtest with its own Agent and browser context.

// One Chromium for the file; each case still gets its own context.
const browser = fileBrowser();

type ConsoleFixture = Awaited<ReturnType<typeof createConsoleAppFixture>>;
type RGB = { r: number; g: number; b: number };

// A status block's tone, whether its stripe and wash are the tone's tokens, and the contrast of
// its text with the wash laid over the surface beneath it.
const statusPaint = (locator: Locator) =>
  locator.evaluate((node) => {
    const view = globalThis;
    const tokenColor = (name: string, property: "color" | "backgroundColor" = "color") => {
      const probe = globalThis.document.createElement("span");
      probe.style[property] = `var(--color-${name})`;
      globalThis.document.body.append(probe);
      const value = view.getComputedStyle(probe)[property];
      probe.remove();
      return value;
    };
    const rgba = (value: string) => {
      const [r, g, b, a = 1] = (value.match(/[\d.]+/g) ?? []).map(Number);
      if (r === undefined || g === undefined || b === undefined) {
        throw new Error(`Expected an RGB color, received ${value}`);
      }
      return { r, g, b, a };
    };
    // The wash is translucent: lay each background over the one beneath until an opaque one.
    const layers = [];
    for (let at: Element | null = node; at; at = at.parentElement) {
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
    const linear = (channel: number) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ({ r, g, b }: RGB) =>
      0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    const contrast = (color: RGB) => {
      const text = luminance(color);
      const surface = luminance(backdrop);
      return (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05);
    };
    const style = view.getComputedStyle(node);
    const tone = node.getAttribute("data-tone");
    if (!tone) {
      throw new Error("Expected a status with a tone");
    }
    return {
      status: node.classList.contains("status"),
      tone,
      stripe: style.borderLeftColor === tokenColor(tone) && style.borderLeftWidth === "3px",
      wash: style.backgroundColor === tokenColor(`${tone}-subtle`, "backgroundColor"),
      bodyText: style.color === tokenColor("text"),
      contrast: Math.round(contrast(rgba(style.color)) * 100) / 100,
    };
  });

function assertPaint(
  paint: Awaited<ReturnType<typeof statusPaint>>,
  tone: "info" | "warning" | "danger",
  label: string,
  stripe = true,
) {
  assert.deepEqual(
    { ...paint, contrast: paint.contrast >= 4.5 },
    { status: true, tone, stripe, wash: true, bodyText: true, contrast: true },
    `${label}: ${JSON.stringify(paint)}`,
  );
}

// Whether a refusal has focus and is on screen.
const refusalView = (locator: Locator) =>
  locator.evaluate((node) => {
    const { top, bottom } = node.getBoundingClientRect();
    return {
      focused: globalThis.document.activeElement === node,
      // Whole, with room for its focus ring (3 px plus a 2 px offset).
      inView: top >= 5 && top < globalThis.innerHeight && bottom <= globalThis.innerHeight - 5,
      rect: [Math.round(top), Math.round(bottom), globalThis.innerHeight, globalThis.scrollY],
    };
  });

// A refusal that has focus and is whole on screen.
async function assertFocusedInView(t: TestContext, locator: Locator) {
  const view = await refusalView(locator);
  t.diagnostic(JSON.stringify(view));
  assert.equal(view.focused, true, "the refusal has focus");
  assert.equal(view.inView, true, "the refusal is on screen");
}

// Whether `locator` is whole on screen, and where it is.
const onScreen = (locator: Locator) =>
  locator.evaluate((node) => {
    const { top, bottom } = node.getBoundingClientRect();
    return {
      inView: top >= 0 && bottom <= globalThis.innerHeight,
      below: top >= globalThis.innerHeight,
      rect: [Math.round(top), Math.round(bottom), globalThis.innerHeight, globalThis.scrollY],
    };
  });

// The API's 403 carries a request ID, which the console shows with a refusal.
const FORBIDDEN_REQUEST_ID = "req_00000000-0000-4000-8000-000000000403";
const FORBIDDEN = apiErrorResponse(403, "FORBIDDEN", "Forbidden", {
  requestId: FORBIDDEN_REQUEST_ID,
});

// The API's 403 for a policy write.
const forbidden = async (route: Route) => {
  if (route.request().method() === "GET") {
    await route.continue();
    return;
  }
  await route.fulfill(FORBIDDEN);
};

// Records the role a feedback line has each time its text is written: a refusal is written into
// an alert, not into a status that turns into one afterwards (finding 2010).
async function recordWrites(locator: Locator) {
  const recording = await locator.evaluateHandle((node) => {
    const { get, set } =
      Object.getOwnPropertyDescriptor(globalThis.Node.prototype, "textContent") ?? {};
    if (!get || !set) {
      throw new Error("Expected the textContent getter and setter");
    }
    const writes: { text: string; role: string | null }[] = [];
    Object.defineProperty(node, "textContent", {
      configurable: true,
      get() {
        return get.call(node);
      },
      set(value) {
        writes.push({ text: String(value), role: node.getAttribute("role") });
        set.call(node, value);
      },
    });
    return { node, writes };
  });
  return (text: string) =>
    locator.evaluate(
      (current, { recording: { node, writes }, text }) => {
        if (current !== node) {
          throw new Error("Feedback element was replaced after write recording began");
        }
        return writes.filter((write) => write.text === text).map((write) => write.role);
      },
      { recording, text },
    );
}

// A feedback line read in full: its class, tone, role and text.
const lineState = (locator: Locator) => statusTone(locator, { text: true });
const dangerAlert = (text: string) => ({
  className: "status",
  tone: "danger",
  role: "alert",
  text,
});
const quietStatus = (text: string) => ({ className: "hint", tone: null, role: "status", text });

// A member who reads the Agent, its versions and its Configuration, and may change none of them.
function createReader(fixture: ConsoleFixture, namespace: NamespaceWire, name: string) {
  return createAgentMember(fixture, namespace, name, ["read"]);
}

const SHARE_REFUSAL =
  "Sharing policy requires Installation administration. Your other Agent controls remain available according to their own permissions.";

test("Share Agent refusals", async (t) => {
  const fixture = await createConsoleAppFixture(t, { provisionedPeople: ["status-recipient"] });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Status refusal");
  // The removal case really shares, which leaves a Role that a later share in the same Namespace
  // would reuse without the refused write; it gets a Namespace of its own.
  const removalNamespace = await fixture.createNamespace("Status removal");
  const iam = (target: NamespaceWire) => `${fixture.origin}/namespaces/${target.id}/iam`;
  const policyPath = iam(namespace);
  let agents = 0;
  // An Agent page at `viewport` with its Share Agent panel's form filled in for the provisioned
  // person.
  async function sharingPage(
    t: TestContext,
    viewport: BrowserContextOptions["viewport"],
    target = namespace,
  ) {
    agents += 1;
    const agent = await fixture.createAgent(
      target.id,
      `Status Agent ${agents}`,
      nativeValues(`status-${agents}`),
    );
    const { page } = await newPage(t, fixture, { browser, context: { viewport } });
    await login(page, fixture, detailUrl(fixture, target.id, agent.id, "draft", "access"));
    const panel = page.getByRole("region", { name: "Share Agent", exact: true });
    const [recipient] = fixture.provisionedAccounts;
    assert.ok(recipient, "Share recipient was provisioned");
    await panel.getByLabel("Existing person’s Principal ID").fill(recipient.principal.id);
    await panel.getByRole("checkbox").check();
    return { page, panel };
  }

  for (const viewport of [...consoleViewports].reverse()) {
    await t.test(
      `a Share Agent refusal is a focused danger block on screen at ${viewport.width}px`,
      async (t) => {
        const { page, panel } = await sharingPage(t, viewport);
        // The policy read succeeds; the first write is refused.
        await page.route(`${policyPath}/roles`, forbidden);
        // Submitted from the keyboard, as a reader who then hears the outcome would.
        await panel.getByRole("button", { name: "Share Agent", exact: true }).focus();
        await page.keyboard.press("Enter");
        const alert = panel.getByRole("alert").filter({ hasText: SHARE_REFUSAL });
        await alert.waitFor();
        await assertFocusedInView(t, alert);
        // Every existing word is kept.
        assert.equal(
          await alert.textContent(),
          `${SHARE_REFUSAL} Refresh sharing to inspect current policy before another change. Request ID: ${FORBIDDEN_REQUEST_ID}`,
        );
        assertPaint(await statusPaint(alert), "danger", "Share refusal");
      },
    );
  }

  // A reader who moved focus out of Share Agent while the request ran keeps it there: the
  // refusal is shown, but it does not pull focus back (finding 1984).
  await t.test("a Share Agent refusal leaves focus where the reader moved it", async (t) => {
    const { page, panel } = await sharingPage(t, { width: 1440, height: 900 });
    const write = await holdRequests(t, page, `${policyPath}/roles`, {
      method: "POST",
      fulfill: FORBIDDEN,
    });
    await panel.getByRole("button", { name: "Share Agent", exact: true }).focus();
    await page.keyboard.press("Enter");
    await write.requested;
    const elsewhere = page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("link")
      .first();
    await elsewhere.focus();
    write.release();
    const alert = panel.getByRole("alert").filter({ hasText: SHARE_REFUSAL });
    await alert.waitFor();
    assert.equal(await hasFocus(elsewhere), true, "focus stays where the reader moved it");
    assert.equal((await refusalView(alert)).focused, false, "the refusal does not take focus");
  });

  // Remove binding sits below the grants list, and its refusal shows above the form. On a phone
  // whose visible area is short (a small screen, or the browser's bars shown), the refusal was
  // above the fold and unfocused: the reader saw the list collapse and nothing else.
  await t.test(
    "a refused binding removal at 390px brings its refusal on screen with focus",
    async (t) => {
      const { page, panel } = await sharingPage(t, { width: 390, height: 560 }, removalNamespace);
      await panel.getByRole("button", { name: "Share Agent", exact: true }).click();
      await panel.getByText("Agent access is shared.", { exact: false }).waitFor();
      await page.route(`${iam(removalNamespace)}/access-bindings/*`, forbidden);
      const remove = panel.getByRole("button", { name: "Remove binding", exact: true }).first();
      await remove.focus();
      await page.keyboard.press("Enter");
      const alert = panel.getByRole("alert").filter({ hasText: SHARE_REFUSAL });
      await alert.waitFor();
      await assertFocusedInView(t, alert);
      assertPaint(await statusPaint(alert), "danger", "removal refusal");
    },
  );
});

test("Notices and the sign-in alert", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();

  // A warning and an informational notice on the same tab: the API-key plugin warning and the
  // note on which version the tab edits.
  await t.test(
    "warning and info notices use their tone's token colours with readable text",
    async (t) => {
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
      assertPaint(await statusPaint(info), "info", "version notice", false);
    },
  );

  // An empty live block keeps its place in the accessibility tree with no box: a live region
  // announces a change only if it was in the tree before the change. The sign-in alert stays
  // empty while the request runs, then the same node takes the refusal.
  await t.test(
    "an empty alert block stays in the accessibility tree until its refusal arrives",
    async (t) => {
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
      const signIn = await holdRequests(t, page, "**/api/auth/sign-in/email");
      await page.getByLabel("Email", { exact: true }).fill(fixture.credentials.email);
      await page.getByLabel("Password").fill("not-the-password");
      await page.getByRole("button", { name: "Sign in" }).click();
      await signIn.requested;
      const pending = await signInAlert();
      assert.equal(await page.locator("form p.status[role=alert]").textContent(), "");
      assert.equal(pending.role, "alert", "the empty alert is in the accessibility tree");
      const box = await page.locator("form p.status[role=alert]").boundingBox();
      assert.equal(box?.height, 0, "the empty alert takes no space");
      signIn.release();
      await page.getByText("Could not sign in. Check your email and password.").waitFor();
      const refused = await signInAlert();
      assert.deepEqual(refused, { backendNodeId: pending.backendNodeId, role: "alert" });
    },
  );
});

const SECRET_ACCESS_REFUSED =
  /^Authentication source saved, but the request to grant this Agent access to the selected Secret was refused\. /;

test("Authentication source save outcomes", async (t) => {
  const fixture = await createConsoleAppFixture(t);
  await fixture.bootstrap();

  // A draft Agent's Credentials tab, in a Namespace of its own, with an API key Secret chosen
  // for its authentication source.
  async function authenticationSourcePage(
    t: TestContext,
    name: string,
    { harnessId }: { harnessId?: string } = {},
  ) {
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
      namespace,
      agent,
      page,
      save,
      feedback,
      agentUrl: `${fixture.origin}/namespaces/${namespace.id}/agents/${agent.id}`,
    };
  }

  // Saving the Credentials tab's authentication source showed its refusal in the grey hint line
  // that also carries progress, unfocused (finding 1966).
  await t.test("a refused authentication source save is a focused danger block", async (t) => {
    const { namespace, agent, page, save } = await authenticationSourcePage(t, "auth");
    // Saved elsewhere while this tab was open: the save's preflight read refuses it.
    const changed = await fixture.request(
      "PATCH",
      `/namespaces/${namespace.id}/agents/${agent.id}`,
      { body: { configurationId: agent.configurationId, harnessAuth: null } },
    );
    assert.equal(changed.status, 200);
    await save.click();
    const refusal = page.getByRole("alert").filter({
      hasText: "The Configuration changed. Reload authentication source before saving.",
    });
    await refusal.waitFor();
    assertPaint(await statusPaint(refusal), "danger", "authentication refusal");
    await assertFocusedInView(t, refusal);
  });

  // The API's 403 (not only the preflight conflict above) was the original grey, unfocused hint
  // (findings 1966, 2004). A later save's progress is a quiet status again.
  await t.test(
    "an API-refused authentication source save is a focused alert, and the next save's progress a status",
    async (t) => {
      const { page, save, feedback, agentUrl } = await authenticationSourcePage(t, "auth-403");
      const rolesWhenWritten = await recordWrites(feedback);
      await page.route(agentUrl, forbidden);
      await save.click();
      const refusal = page.getByRole("alert").filter({ hasText: AGENT_SAVE_DENIED });
      await refusal.waitFor();
      assert.deepEqual(await lineState(feedback), dangerAlert(AGENT_SAVE_DENIED));
      assertPaint(await statusPaint(refusal), "danger", "authentication 403");
      await assertFocusedInView(t, refusal);
      assert.deepEqual(await rolesWhenWritten(AGENT_SAVE_DENIED), ["alert"]);

      // Saving again: while its preflight read runs, the line is quiet progress, not the old
      // refusal.
      const read = await holdRequests(t, page, agentUrl, { method: "GET", once: true });
      await save.click();
      await read.requested;
      assert.deepEqual(await lineState(feedback), quietStatus("Saving authentication…"));
      read.release();
      await refusal.waitFor();
    },
  );

  // Incomplete fields the form cannot catch (a ChatGPT sign-in not finished) refuse the save too.
  await t.test(
    "an authentication source save without its ChatGPT sign-in is a focused alert",
    async (t) => {
      const { page, save, feedback } = await authenticationSourcePage(t, "auth-oauth", {
        harnessId: "codex",
      });
      await page.getByLabel("Authentication source").selectOption("credential_source");
      await save.click();
      const refusal = page
        .getByRole("alert")
        .filter({ hasText: "Complete ChatGPT sign-in before saving." });
      await refusal.waitFor();
      assert.deepEqual(
        await lineState(feedback),
        dangerAlert("Complete ChatGPT sign-in before saving."),
      );
      assert.equal((await refusalView(refusal)).focused, true, "the refusal has focus");
    },
  );

  // A saved source whose Secret grant was refused is a warning, also when the tab is rebuilt.
  await t.test(
    "an authentication source saved with its Secret grant refused stays a warning alert",
    async (t) => {
      const { namespace, page, save, feedback } = await authenticationSourcePage(t, "auth-grant");
      await page.route(`${fixture.origin}/namespaces/${namespace.id}/iam/**`, forbidden);
      await save.click();
      const warning = page.getByRole("alert").filter({ hasText: SECRET_ACCESS_REFUSED });
      await warning.waitFor();
      const state = await lineState(feedback);
      assert.deepEqual(
        { ...state, text: SECRET_ACCESS_REFUSED.test(state.text) },
        { className: "status", tone: "warning", role: "alert", text: true },
      );
      assertPaint(await statusPaint(warning), "warning", "refused Secret grant");
      assert.equal((await refusalView(warning)).focused, true, "the warning has focus");

      await page.getByRole("tab", { name: "Configuration", exact: true }).click();
      await page.getByRole("tab", { name: "Credentials", exact: true }).click();
      // The rebuilt tab repeats the shared grant warning (finding 2259).
      const kept = page.getByRole("alert").filter({
        hasText:
          "Authentication source saved, but the request to grant this Agent access to the selected Secret was refused. Granting it needs Installation administration access: ask an Installation administrator to open this Agent's Credentials and select Save authentication source. Select Retry credential access once you have that access.",
      });
      await kept.waitFor();
      assert.deepEqual(await statusTone(kept), {
        className: "status",
        tone: "warning",
        role: "alert",
      });
    },
  );

  // An unknown outcome is a danger alert, also when the tab is rebuilt.
  await t.test(
    "an authentication source save with an unknown outcome stays a danger alert",
    async (t) => {
      const { page, save, agentUrl } = await authenticationSourcePage(t, "auth-unknown");
      // A gateway in front of the API answers 502 (the API never does), with its own page and no
      // API envelope: the save may or may not have reached the API.
      await page.route(agentUrl, async (route) => {
        if (route.request().method() === "GET") {
          await route.continue();
          return;
        }
        await route.fulfill(proxyErrorResponse(502));
      });
      await save.click();
      await page.locator("form > p.status[data-tone=danger][role=alert]").waitFor();
      await page.getByRole("tab", { name: "Configuration", exact: true }).click();
      await page.getByRole("tab", { name: "Credentials", exact: true }).click();
      const kept = page.getByRole("alert").filter({
        hasText: "Outcome unknown. Reload authentication source before saving again.",
      });
      await kept.waitFor();
      assert.deepEqual(await statusTone(kept), {
        className: "status",
        tone: "danger",
        role: "alert",
      });
    },
  );
});

test("Repository access save refusals", async (t) => {
  const { fixture, namespace } = await createRepositoryLaunchFixture(t, (namespaceId: string) => [
    {
      repositoryRef: "application",
      repositoryId: "1600",
      repository: "example/application",
      namespaces: [{ namespaceId, profiles: ["git-read", "git-write", "git-full"] }],
    },
  ]);
  // A draft Agent whose saved access gives the repository Contributor (git-full) by default.
  async function repositoryAgent(name: string, marker: string) {
    const agent = await fixture.createAgent(namespace.id, name, nativeValues(marker));
    const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
    const access = (defaultProfile: "git-full" | "git-write") => ({
      configurationId: agent.configurationId,
      repositoryAccess: { defaultProfile, repositories: [{ repositoryRef: "application" }] },
    });
    assert.equal(
      (await fixture.request("PATCH", agentPath, { body: access("git-full") })).status,
      200,
    );
    return { agent, agentPath, access };
  }

  // The Repositories editor showed its refusal in the grey hint line that also carries progress,
  // unfocused (finding 1966).
  await t.test("a refused repository access save is a focused danger block", async (t) => {
    const { agent, agentPath, access } = await repositoryAgent("Status repos", "repos");
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
      hasText: REPOSITORY_ACCESS_CHANGED,
    });
    await refusal.waitFor();
    assertPaint(await statusPaint(refusal), "danger", "repository refusal");
    await assertFocusedInView(t, refusal);
  });

  // The Repositories editor's 403 is a focused alert too (finding 2004); an edit or a held
  // navigation turns the line back into a quiet status.
  await t.test(
    "an API-refused repository access save is a focused alert until the next edit or navigation",
    async (t) => {
      const { agent, agentPath } = await repositoryAgent("Status repos 403", "r403");
      const { page } = await newPage(t, fixture, { browser });
      await page.route(`${fixture.origin}${agentPath}`, forbidden);
      await login(
        page,
        fixture,
        detailUrl(fixture, namespace.id, agent.id, "draft", "repositories"),
      );
      await page.getByText("Contributor · Agent default", { exact: true }).waitFor();
      const save = page.getByRole("button", { name: "Save repository access" });
      const feedback = page
        .locator("section.agent-card")
        .filter({ has: save })
        .locator(":scope > p")
        .last();
      const rolesWhenWritten = await recordWrites(feedback);
      const refuse = async () => {
        await save.click();
        const refusal = page.getByRole("alert").filter({ hasText: AGENT_SAVE_DENIED });
        await refusal.waitFor();
        assert.deepEqual(await lineState(feedback), dangerAlert(AGENT_SAVE_DENIED));
        return refusal;
      };
      await page.locator("#repository-default-git-read").check();
      const refusal = await refuse();
      assertPaint(await statusPaint(refusal), "danger", "repository 403");
      await assertFocusedInView(t, refusal);
      assert.deepEqual(await rolesWhenWritten(AGENT_SAVE_DENIED), ["alert"]);

      // An edit (back to the saved access): guidance in a quiet status.
      await page.locator("#repository-default-git-full").check();
      assert.deepEqual(await lineState(feedback), quietStatus("No repository changes to save."));

      // Refused again, then leaving the tab with the edit unsaved: the hold is a quiet status too.
      await page.locator("#repository-default-git-read").check();
      await refuse();
      await page.getByRole("link", { name: "← Agents", exact: true }).click();
      assert.deepEqual(await lineState(feedback), quietStatus(REPOSITORY_EDITS_PENDING));
    },
  );
});

test("Configuration save outcomes", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Status configuration");
  const reader = await createReader(fixture, namespace, "status-config-reader");
  let agents = 0;
  const newAgent = () => {
    agents += 1;
    return fixture.createAgent(namespace.id, `Status config ${agents}`, nativeValues(`c${agents}`));
  };
  // The Configuration editor's draft for `agent`, open with an edit, and its feedback line.
  async function editConfiguration(
    page: Page,
    agent: AgentWire,
    marker: string,
    credentials?: ConsoleFixture["credentials"],
  ) {
    if (credentials) {
      await grantStaleConfigurationUpdate(page);
    }
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

  // A reader's refused Configuration save was a status line under the editor, neither announced
  // as an alert nor focused, and cut by the fold at 1440 (finding 1991).
  for (const viewport of consoleViewports) {
    await t.test(
      `a reader's refused Configuration save is a focused alert on screen at ${viewport.width}px`,
      async (t) => {
        const agent = await newAgent();
        const { page } = await newPage(t, fixture, { browser, context: { viewport } });
        await editConfiguration(page, agent, "edited by a reader", reader.credentials);
        await page.getByRole("button", { name: "Save Configuration" }).click();
        const alert = page.getByRole("alert").filter({ hasText: CONFIGURATION_SAVE_DENIED });
        await alert.waitFor();
        await assertFocusedInView(t, alert);
        assertPaint(await statusPaint(alert), "danger", "Configuration refusal");
        // An edit clears it; the line is a status again for the next save's progress.
        await page
          .getByLabel("Configuration JSON")
          .fill(JSON.stringify(nativeValues("edited again"), null, 2));
        assert.equal(
          await page.locator("#configuration-editor-feedback").getAttribute("role"),
          "status",
        );
      },
    );
  }

  // The pre-save reread's conflict was written while the line was still a status, and became an
  // alert only afterwards (finding 2010). Holding navigation turns it back into a quiet status.
  await t.test(
    "a Configuration save conflict is written into an alert, and a navigation hold is a status",
    async (t) => {
      const agent = await newAgent();
      const { page } = await newPage(t, fixture, { browser });
      const feedback = await editConfiguration(page, agent, "edited here");
      const rolesWhenWritten = await recordWrites(feedback);
      // Saved elsewhere while this editor was open.
      await fixture.updateConfiguration(namespace.id, agent.configurationId, nativeValues("other"));
      await page.getByRole("button", { name: "Save Configuration" }).click();
      await page.getByRole("alert").filter({ hasText: RELOAD_DRAFT_BEFORE_SAVING }).waitFor();
      assert.deepEqual(await lineState(feedback), dangerAlert(RELOAD_DRAFT_BEFORE_SAVING));
      assert.deepEqual(await rolesWhenWritten(RELOAD_DRAFT_BEFORE_SAVING), ["alert"]);

      await page.getByRole("link", { name: "← Agents", exact: true }).click();
      assert.deepEqual(
        await lineState(feedback),
        quietStatus("Reload this draft before leaving the editor."),
      );
    },
  );

  // After a refused save the line is an alert; the next save's progress and Cancel each make it
  // a quiet status again (finding 2010).
  await t.test(
    "a refused Configuration save's alert gives way to a status for progress and Cancel",
    async (t) => {
      const agent = await newAgent();
      const { page } = await newPage(t, fixture, { browser });
      const feedback = await editConfiguration(
        page,
        agent,
        "edited by a reader",
        reader.credentials,
      );
      const save = page.getByRole("button", { name: "Save Configuration" });
      const refused = async () => {
        await page.getByRole("alert").filter({ hasText: CONFIGURATION_SAVE_DENIED }).waitFor();
        assert.deepEqual(await lineState(feedback), dangerAlert(CONFIGURATION_SAVE_DENIED));
      };
      await save.click();
      await refused();

      // Save stays enabled with the draft still edited; its preflight is quiet progress.
      const read = await holdRequests(t, page, `**/configurations/${agent.configurationId}`, {
        method: "GET",
        once: true,
      });
      await save.click();
      await read.requested;
      assert.deepEqual(await lineState(feedback), quietStatus("Checking Configuration…"));
      read.release();
      await refused();

      // Cancel closes the editor; opened again, its line is a quiet status.
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Edit Configuration" }).click();
      assert.deepEqual(await statusTone(feedback), {
        className: "hint",
        tone: null,
        role: "status",
      });
    },
  );

  // A Configuration save that ends in a conflict or an unknown outcome moves focus to Reload
  // draft and brings its message, under the buttons, into view (finding 2009).
  for (const outcome of [
    {
      name: "conflict",
      // The API's stale-generation refusal.
      response: apiErrorResponse(409, "RESOURCE_CONFLICT", "Conflict.", {
        details: [{ path: "/expectedGeneration", code: "INVALID_VALUE" }],
      }),
      text: RELOAD_DRAFT_BEFORE_SAVING,
    },
    {
      name: "unknown outcome",
      response: apiErrorResponse(500, "INTERNAL_ERROR", "Held."),
      text: "Outcome unknown. Configuration may have been saved. Reload this draft before saving again.",
    },
  ]) {
    await t.test(`a Configuration save ${outcome.name} brings its message on screen`, async (t) => {
      const agent = await newAgent();
      const { page } = await newPage(t, fixture, {
        browser,
        context: { viewport: { width: 1440, height: 900 } },
      });
      const write = await holdRequests(
        t,
        page,
        `${fixture.origin}/namespaces/${namespace.id}/configurations/${agent.configurationId}`,
        { method: "PATCH", fulfill: outcome.response },
      );
      const feedback = await editConfiguration(page, agent, "edited");
      const save = page.getByRole("button", { name: "Save Configuration" });
      await save.click();
      await write.requested;
      // The reader scrolls while the save runs: the buttons at the bottom of the screen, the
      // line under them out of sight.
      await save.evaluate((node) => node.scrollIntoView({ block: "end" }));
      const before = await onScreen(feedback);
      assert.equal(before.below, true, `the message starts below the fold: ${before.rect}`);
      write.release();
      await page.getByText(outcome.text, { exact: true }).waitFor();
      assert.equal(
        await hasFocus(page.getByRole("button", { name: "Reload draft" })),
        true,
        "Reload draft has focus",
      );
      const after = await onScreen(feedback);
      t.diagnostic(JSON.stringify(after));
      assert.equal(after.inView, true, "the message is on screen");
    });
  }
});

// A member who reads the Agent's Namespace, versions and Configuration, with `agentActions` on
// the Agent itself.
function createAgentMember(
  fixture: ConsoleFixture,
  namespace: NamespaceWire,
  name: string,
  agentActions: PermissionAction[],
) {
  return fixture.createAccountWithPolicy(name, (principal) => {
    fixture.policy.roles.push({
      id: `role-${name}`,
      namespaceId: namespace.id,
      permissions: [
        ...(["namespace", "agent_revision", "configuration"] as const).map((resourceKind) => ({
          action: "read" as const,
          resourceKind,
        })),
        ...agentActions.map((action) => ({ action, resourceKind: "agent" as const })),
      ],
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

// Resolves once the page has read the Agent's permission answer, failed or not. The count goes up
// one microtask before the console acts on the answer, and the console decides its controls in the
// same microtask chain; waitForFunction checks in a later task, so they are settled by then.
async function watchPermissionAnswer(page: Page, agentId: string) {
  await page.addInitScript((suffix) => {
    const json = globalThis.Response.prototype.json;
    const probe = Object.assign(globalThis, { permissionAnswers: 0 });
    globalThis.Response.prototype.json = function readJson() {
      const read = json.call(this);
      if (this.url && new URL(this.url).pathname.endsWith(suffix)) {
        const answered = () => {
          probe.permissionAnswers += 1;
        };
        read.then(answered, answered);
      }
      return read;
    };
  }, `/agents/${agentId}/permissions`);
  return () =>
    page.waitForFunction(
      () =>
        "permissionAnswers" in window &&
        typeof window.permissionAnswers === "number" &&
        window.permissionAnswers > 0,
    );
}

// A diagnostics run that answers with one passing check, counting its requests.
async function answerDiagnostics(page: Page, revisionId: string) {
  const runs: string[] = [];
  await page.route("**/deployments/*/diagnostics", (route) => {
    runs.push(route.request().method());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          revisionId,
          observedAt: "2026-10-19T09:00:01.000Z",
          checks: [
            {
              component: "slack",
              check: "authentication",
              state: "succeeded",
              checkedAt: "2026-10-19T09:00:01.000Z",
            },
          ],
        },
        meta: { requestId: "req_test_diagnostics_status" },
      }),
    });
  });
  return runs;
}

const DIAGNOSTICS_REASON = DIAGNOSTICS_DENIED;

test("Run diagnostics access and outcomes", async (t) => {
  const { fixture, namespace } = await createReadyConsoleNamespace(t, "Status diagnostics");
  const reader = await createReader(fixture, namespace, "status-diagnostics-reader");
  let agents = 0;
  // An Agent with an active version, and that version's diagnostics section and Run button.
  async function activeAgent() {
    agents += 1;
    const agent = await fixture.createAgent(
      namespace.id,
      `Diagnostics ${agents}`,
      nativeValues(`d${agents}`),
    );
    const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
    return { agent, revision: active.revision };
  }
  const openVersion = async (
    page: Page,
    { agent, revision }: Awaited<ReturnType<typeof activeAgent>>,
    credentials?: ConsoleFixture["credentials"],
  ) => {
    await login(
      page,
      fixture,
      detailUrl(fixture, namespace.id, agent.id, revision.id, "deployment"),
      credentials,
    );
    const observations = page.locator(".version-diagnostics");
    const run = observations.getByRole("button", { name: "Run diagnostics for this version" });
    return { observations, run };
  };

  // Run diagnostics needs Agent operate. A reader without it saw the button enabled beside a
  // disabled Stop and Delete (now hidden), and its 403 landed below the fold at 1440 (finding 1992).
  await t.test(
    "Run diagnostics is disabled with its reason for a reader without operate",
    async (t) => {
      const version = await activeAgent();
      const { page } = await newPage(t, fixture, { browser });
      const { observations, run } = await openVersion(page, version, reader.credentials);
      // The same answer that hides the Stop row disables Run diagnostics.
      await page.waitForFunction(
        () => globalThis.document.querySelector<HTMLElement>("section.stop-note")?.hidden === true,
      );
      const reason = observations.getByRole("status").filter({ hasText: DIAGNOSTICS_REASON });
      await reason.waitFor();
      assertPaint(await statusPaint(reason), "info", "diagnostics reason");
      assert.equal(await run.isDisabled(), true);
    },
  );

  // A 403 that still happens (the permission answer allowed it, the API refused) comes into view
  // below the button, which keeps focus (since #2779).
  for (const viewport of consoleViewports) {
    await t.test(
      `a refused Run diagnostics brings its alert on screen at ${viewport.width}px`,
      async (t) => {
        const version = await activeAgent();
        const { page } = await newPage(t, fixture, { browser, context: { viewport } });
        await page.route("**/deployments/*/diagnostics", (route) => route.fulfill(FORBIDDEN));
        const { observations, run } = await openVersion(page, version);
        await run.waitFor();
        // As the live walk did: the button at the bottom of the screen, pressed by pointer.
        await run.evaluate((node) => node.scrollIntoView({ block: "end" }));
        await run.click();
        const alert = observations.getByRole("alert").filter({
          // An Installation administrator grants access, not a Namespace one (finding 2260).
          hasText: notIncluded(
            "running diagnostics for this version",
            "Agent read and operate on this Agent and AgentRevision read on this version",
          ),
        });
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
      },
    );
  }

  // Agent operate, and nothing else, decides Run diagnostics; without a permission answer the
  // button stays enabled and the API decides (finding 2008).
  for (const caller of [
    { name: "a member with operate but not update", agentActions: ["read", "operate"], runs: true },
    { name: "a member with update but not operate", agentActions: ["read", "update"], runs: false },
    { name: "an administrator whose permission answer is withheld", withheld: true, runs: true },
  ] satisfies {
    name: string;
    agentActions?: PermissionAction[];
    withheld?: boolean;
    runs: boolean;
  }[]) {
    await t.test(
      `Run diagnostics is ${caller.runs ? "enabled" : "disabled"} for ${caller.name}`,
      async (t) => {
        const version = await activeAgent();
        const member = caller.agentActions
          ? await createAgentMember(
              fixture,
              namespace,
              `status-diagnostics-${caller.agentActions.join("-")}`,
              caller.agentActions,
            )
          : null;
        const { page } = await newPage(t, fixture, { browser });
        const answered = await watchPermissionAnswer(page, version.agent.id);
        const runs = await answerDiagnostics(page, version.revision.id);
        if (caller.withheld) {
          await withholdPermissionSummary(page, fixture, namespace.id, version.agent.id);
        }
        const { observations, run } = await openVersion(page, version, member?.credentials);
        await run.waitFor();
        await answered();
        const reason = observations.getByRole("status").filter({ hasText: DIAGNOSTICS_REASON });
        if (!caller.runs) {
          await reason.waitFor();
          assert.equal(await run.isDisabled(), true);
          assert.deepEqual(runs, []);
          return;
        }
        assert.equal(await reason.count(), 0);
        assert.equal(await run.isEnabled(), true);
        await run.click();
        await observations.getByText(/^Observed /).waitFor();
        assert.deepEqual(runs, ["POST"]);
      },
    );
  }

  // Only a refusal scrolls: a result, below the button the reader pressed, stays where it is so
  // the page does not jump under the pointer (finding 2009).
  await t.test("a successful Run diagnostics leaves the page where it was", async (t) => {
    const version = await activeAgent();
    const { page } = await newPage(t, fixture, {
      browser,
      context: { viewport: { width: 1440, height: 900 } },
    });
    await answerDiagnostics(page, version.revision.id);
    // The waiting line (shown after 250 ms) takes focus and so scrolls; time stands still, so a
    // slow answer never shows it.
    await page.clock.install({ time: new Date("2026-10-19T09:00:00Z") });
    await page.clock.pauseAt(new Date("2026-10-19T09:00:01Z"));
    const { observations, run } = await openVersion(page, version);
    await run.waitFor();
    await run.evaluate((node) => node.scrollIntoView({ block: "end" }));
    const scrolled = await page.evaluate(() => globalThis.scrollY);
    await run.click();
    const observed = observations.getByText(/^Observed /);
    await observed.waitFor();
    assert.equal((await onScreen(observed)).below, true, "the result is below the fold");
    assert.equal(
      await page.evaluate(() => globalThis.scrollY),
      scrolled,
      "the page did not scroll",
    );
    assert.equal(await hasFocus(run), true, "the button keeps focus");
  });
});
