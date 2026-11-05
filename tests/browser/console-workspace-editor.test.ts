/// <reference lib="es2025.regexp" />

import { waitForLiveControls } from "./console-agents-ui-test-support.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { Locator, Page } from "playwright";

import type { ControllerWorkspaceFilesAccess } from "../../apps/controller/src/gateway/contracts.ts";
import type { AgentRevision, Permission } from "../../packages/contracts/src/index.ts";
import { DEPLOYMENT_POLL_MS } from "../../apps/controller/src/console/agents/deployment-evidence.mts";
import { WORKSPACE_DEFAULTS } from "../../packages/contracts/src/workspace-defaults.mjs";
import { proxyErrorResponse } from "../helpers/api-error.mjs";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import {
  deploymentStatusResponse,
  apiRequests,
  detailUrl,
  expectNoText,
  holdRequests,
  login,
  nativeValues,
  newPage,
  nonAuthWriteRequests,
  pathRequests,
  settlePageRequests,
  waitForCondition,
  waitForEnabled,
  waitForInputValue,
} from "./console-agents-browser-helpers.ts";

import {
  trackSettledFetches,
  waitForIdleFetches,
  waitForSettledFetches,
} from "./console-fetch-accounting.ts";
import {
  deploymentRecordUrl,
  expectDeploymentOutcome,
} from "./console-deployment-activity-helpers.ts";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";
import {
  callerDenied,
  RESOURCE_NOT_FOUND,
  WORKSPACE_API_UNREACHABLE,
  WORKSPACE_UNREACHABLE,
  tooManyRequestsIn,
} from "../helpers/refusal-text.mjs";

declare global {
  var workspaceBlurs: number;
  var workspaceDisabled: number;
}

async function chooseWorkspaceFile(page: Page, name: string) {
  const picker = page.getByRole("combobox", { name: "Workspace file", exact: true });
  if (await picker.isVisible()) {
    await picker.selectOption(name);
  } else {
    await page.getByRole("tab", { name: new RegExp(name.replace(".", "\\.")) }).click();
  }
}

// Each workspace editor also stays disabled until its own file read lands.
async function waitForWorkspaceEditors(page: Page, names: string[]) {
  await waitForLiveControls(
    page,
    names.map((name) => `workspace-${name}`),
  );
}

test("live workspace drafts survive navigation, stay Agent-scoped, and clear on explicit reload or save", async (t) => {
  const root = await temporaryDirectory(t, "console-workspace-drafts-");
  // Exercise the real Console, Fastify, and IAM paths with disk-backed file transport.
  // This checks UI navigation and file requests, not a live Agent gateway.
  const fixture = await createConsoleAppFixture(t, {
    publicOrigin: true,
    workspaceFilesAccess: {
      async read({ revision, filename }: Parameters<ControllerWorkspaceFilesAccess["read"]>[0]) {
        return {
          status: "ok",
          file: {
            name: filename,
            content: await readFile(join(root, revision.agentId, filename), "utf8"),
          },
        };
      },
      async write({
        revision,
        filename,
        content,
      }: Parameters<ControllerWorkspaceFilesAccess["write"]>[0]) {
        await writeFile(join(root, revision.agentId, filename), content);
        return { status: "ok", file: { name: filename, size: Buffer.byteLength(content) } };
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace navigation", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Workspace draft owner",
    nativeValues("workspace"),
  );
  const other = await fixture.createAgent(
    namespace.id,
    "Other workspace Agent",
    nativeValues("other"),
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  await fixture.seedActiveAgentRevision(namespace.id, other.id);
  for (const owner of [agent, other]) {
    await mkdir(join(root, owner.id));
    for (const name of Object.keys(WORKSPACE_DEFAULTS)) {
      await writeFile(join(root, owner.id, name), `# Saved ${name}\n`);
    }
  }
  // Textareas show CRLF as LF; an untouched read must not enable Save or write.
  const original = "# Saved AGENTS.md\r\n# Windows instructions\r\n";
  await writeFile(join(root, agent.id, "AGENTS.md"), original);
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  const url = detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace");
  await login(page, fixture, url);
  await waitForWorkspaceEditors(page, ["AGENTS.md", "USER.md"]);
  const file = page.getByLabel("AGENTS.md", { exact: true });
  assert.equal(await file.inputValue(), original.replaceAll("\r\n", "\n"));
  assert.equal(
    await page
      .getByRole("button", { name: "Save AGENTS.md", exact: true, includeHidden: true })
      .isEnabled(),
    false,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "Save USER.md", exact: true, includeHidden: true })
      .isEnabled(),
    false,
  );
  assert.equal(await readFile(join(root, agent.id, "AGENTS.md"), "utf8"), original);
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  await chooseWorkspaceFile(page, "AGENTS.md");
  await file.fill("# Unsaved instructions\n");
  await chooseWorkspaceFile(page, "USER.md");
  await page.getByLabel("USER.md", { exact: true }).fill("");
  await page
    .getByRole("tab", { name: "Instructions · AGENTS.md" })
    .getByText("Unsaved", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("AGENTS.md", { exact: true }).isVisible(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("combobox", { name: "Workspace file", exact: true })
    .selectOption("AGENTS.md");
  assert.equal(await file.inputValue(), "# Unsaved instructions\n");
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  await waitForWorkspaceEditors(page, ["AGENTS.md", "USER.md"]);
  assert.equal(await file.inputValue(), "# Unsaved instructions\n");
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByRole("link", { name: "Other workspace Agent", exact: true }).click();
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  await chooseWorkspaceFile(page, "AGENTS.md");
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await file.inputValue(), "# Saved AGENTS.md\n");
  await page.getByRole("link", { name: "← Agents" }).click();
  await page.getByLabel("Search Agents").fill("Workspace draft owner");
  await page.getByRole("link", { name: "Workspace draft owner", exact: true }).click();
  await page.getByRole("tab", { name: "Workspace files", exact: true }).click();
  await waitForWorkspaceEditors(page, ["AGENTS.md"]);
  assert.equal(await file.inputValue(), "# Unsaved instructions\n");
  assert.deepEqual(nonAuthWriteRequests(requests), []);
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/workspace/files/AGENTS.md"),
  );
  await chooseWorkspaceFile(page, "AGENTS.md");
  await page
    .getByRole("button", { name: "Save AGENTS.md", exact: true, includeHidden: true })
    .click();
  assert.equal((await saved).status(), 200);
  assert.equal(
    await readFile(join(root, agent.id, "AGENTS.md"), "utf8"),
    "# Unsaved instructions\n",
  );
  await chooseWorkspaceFile(page, "USER.md");
  await page
    .getByRole("button", { name: "Reload USER.md", exact: true, includeHidden: true })
    .click();
  await page.getByText("USER.md loaded.", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "# Saved USER.md\n");
  await page.getByRole("link", { name: "← Agents" }).click();
  assert.equal(await page.getByLabel("Search Agents").inputValue(), "Workspace draft owner");
  await page.goBack();
  await waitForWorkspaceEditors(page, ["AGENTS.md", "USER.md"]);
  await page.getByText("AGENTS.md loaded.", { exact: true }).waitFor({ state: "attached" });
  assert.equal(
    await page
      .getByRole("button", { name: "Save AGENTS.md", exact: true, includeHidden: true })
      .isDisabled(),
    true,
  );
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "# Saved USER.md\n");
});

// Workspace files are live Agent data. A deployment that finishes while a reader types must not
// rebuild the editors: the old remount dropped focus and caret and flashed the editors disabled
// (finding 1836). Files without unsaved edits are still reread from the new current version.
test("a deployment finishing on the poll keeps a typing reader's Workspace editor and rereads unchanged files", async (t) => {
  const fixture = await createConsoleAppFixture(t, {
    publicOrigin: true,
    workspaceFilesAccess: {
      async read({ revision, filename }: Parameters<ControllerWorkspaceFilesAccess["read"]>[0]) {
        const content =
          filename === "AGENTS.md"
            ? `# Saved ${filename}\n`
            : `# ${filename} served by ${revision.id}\n`;
        return { status: "ok", file: { name: filename, content } };
      },
      async write() {
        throw new Error("no Workspace file may be written");
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Workspace deploy poll", { ready: true });
  const agent = await fixture.createAgent(namespace.id, "Workspace typist", nativeValues("ws"));
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const second = await fixture.deployAgent(namespace.id, agent.id);
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  let status = "running";
  await page.route(deploymentRecordUrl(fixture, namespace.id, agent.id, second.id), (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          deploymentId: second.id,
          namespaceId: namespace.id,
          agentId: agent.id,
          status,
          error: null,
          warnings: [],
          progress: null,
        },
        meta: { requestId: "req_test_workspace_poll" },
      }),
    }),
  );
  await page.clock.install({ time: new Date("2026-10-18T12:00:00Z") });
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, first.revision.id, "workspace"),
  );
  await waitForWorkspaceEditors(page, ["AGENTS.md", "SOUL.md", "USER.md"]);
  const soul = page.getByLabel("SOUL.md", { exact: true });
  const user = page.getByLabel("USER.md", { exact: true });
  assert.equal(await soul.inputValue(), `# SOUL.md served by ${first.revision.id}\n`);
  assert.equal(await user.inputValue(), `# USER.md served by ${first.revision.id}\n`);
  const soulEditor = await soul.elementHandle();
  // The reread of USER.md is held until the reader has typed in it.
  const userPath = `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/USER.md`;
  const userReread = await holdRequests(t, page, `${fixture.origin}${userPath}`, { once: true });
  await expectDeploymentOutcome(page, "In progress", { reveal: false });

  // The reader is typing in AGENTS.md with a selection in the middle of the text.
  const file = page.getByLabel("AGENTS.md", { exact: true });
  const typed = "# Draft instructions\n# Second line\n";
  await file.fill(typed);
  const editor = await file.elementHandle();
  await editor.evaluate((node) => {
    if (!(node instanceof HTMLTextAreaElement)) {
      throw new Error("Expected a Workspace textarea");
    }
    node.focus();
    node.setSelectionRange(8, 20);
    globalThis.workspaceBlurs = 0;
    globalThis.workspaceDisabled = 0;
    node.addEventListener("blur", () => (globalThis.workspaceBlurs += 1));
    new globalThis.MutationObserver(() => {
      if (node.disabled) {
        globalThis.workspaceDisabled += 1;
      }
    }).observe(node, { attributes: true, attributeFilter: ["disabled"] });
  });

  // The worker finishes the deployment; the next poll reads it and the new current version.
  await fixture.activateRevision(namespace.id, agent.id, second.id, first.revision.id);
  status = "succeeded";
  await page.clock.runFor(DEPLOYMENT_POLL_MS);
  await expectDeploymentOutcome(page, "Completed", { folded: false, reveal: false });
  await waitForInputValue(soul, `# SOUL.md served by ${second.id}\n`);
  await userReread.requested;

  assert.deepEqual(
    await editor.evaluate((node) => {
      if (!(node instanceof HTMLTextAreaElement)) {
        throw new Error("Expected a Workspace textarea");
      }
      return {
        connected: node.isConnected,
        focused: node.ownerDocument.activeElement === node,
        selection: [node.selectionStart, node.selectionEnd],
        value: node.value,
        blurs: globalThis.workspaceBlurs,
        disabled: globalThis.workspaceDisabled,
      };
    }),
    {
      connected: true,
      focused: true,
      selection: [8, 20],
      value: typed,
      blurs: 0,
      disabled: 0,
    },
  );
  await page
    .getByText("SOUL.md reloaded with its current contents.", { exact: true })
    .waitFor({ state: "attached" });
  assert.equal(await soulEditor.evaluate((node) => node.isConnected), true);
  await expectNoText(page, "Unsaved edits restored. Reload replaces them with the current file.");
  // Typing goes on at the caret, and nothing was written for the reader.
  await page.keyboard.type("Workspace");
  assert.equal(await file.inputValue(), "# Draft Workspace\n# Second line\n");

  // An edit made while a reread is in flight is kept; the late answer is dropped.
  await chooseWorkspaceFile(page, "USER.md");
  await user.fill("# Typed during the reread\n");
  const answered = page.waitForResponse((response) => response.url().endsWith(userPath));
  userReread.release();
  await answered;
  await expectNoText(page, "USER.md reloaded with its current contents.", () =>
    waitForIdleFetches(page),
  );
  assert.equal(await user.inputValue(), "# Typed during the reread\n");
  assert.equal(
    requests.filter((r) => r.method === "PUT" && r.path.includes("/workspace/files/")).length,
    0,
  );
});

function checkedWorkspaceRevision(
  value: unknown,
): Pick<AgentRevision, "id" | "namespaceId" | "agentId" | "createdAt"> {
  assert.ok(typeof value === "object" && value !== null);
  assert.ok("id" in value && typeof value.id === "string");
  assert.ok("namespaceId" in value && typeof value.namespaceId === "string");
  assert.ok("agentId" in value && typeof value.agentId === "string");
  assert.ok("createdAt" in value && typeof value.createdAt === "string");
  return {
    id: value.id,
    namespaceId: value.namespaceId,
    agentId: value.agentId,
    createdAt: value.createdAt,
  };
}

// Opens the Workspace tab while the first of `count` versions serves. Each makeCurrent() selects
// the next version for service. When it activates, the natural deployment poll reads the Agent
// and rereads the Workspace files in place (finding 1836).
async function openWorkspaceVersions(
  t: TestContext,
  name: string,
  workspaceFilesAccess: ControllerWorkspaceFilesAccess,
  count = 2,
) {
  const fixture = await createConsoleAppFixture(t, {
    publicOrigin: true,
    workspaceFilesAccess,
    recordOperations: true,
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace(name, { ready: true });
  const agent = await fixture.createAgent(namespace.id, name, nativeValues("reread"));
  const first = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const firstRevision = checkedWorkspaceRevision(first.revision);
  const versions = [firstRevision];
  while (versions.length < Math.min(count, 2)) {
    versions.push(checkedWorkspaceRevision(await fixture.deployAgent(namespace.id, agent.id)));
  }
  const { page } = await newPage(t, fixture);
  await trackSettledFetches(page);
  const requests = apiRequests(page, fixture.origin);
  await page.clock.install();
  // Simulate worker status records; Agent activation and workspace transport use the real API.
  const completed = new Set<string>();
  await page.route(
    (url) => url.pathname.startsWith(`/namespaces/${namespace.id}/agents/${agent.id}/deployments/`),
    (route) => {
      const id = new URL(route.request().url()).pathname.split("/").at(-1);
      assert.ok(id !== undefined);
      const revision = versions.find((version) => version.id === id);
      assert.ok(revision);
      return route.fulfill(
        deploymentStatusResponse(revision, {
          status: completed.has(id) ? "succeeded" : "queued",
          attempt: undefined,
          nextAttemptAt: undefined,
        }),
      );
    },
  );
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, firstRevision.id, "workspace"),
  );
  await waitForWorkspaceEditors(page, ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md"]);
  await expectDeploymentOutcome(page, "Queued", { reveal: false });
  // Allow time for the pause command to reach the browser: the sampled time can already be
  // in the past when it arrives. Stay short of the five-second deployment polling interval.
  const now = await page.evaluate(() => Date.now());
  await page.clock.pauseAt(new Date(now + 1000));
  const agentPath = `/namespaces/${namespace.id}/agents/${agent.id}`;
  let current = 0;
  return {
    fixture,
    page,
    requests,
    agentPath,
    versions,
    filePath: (file: string) => `${agentPath}/workspace/files/${file}`,
    form: (file: string) =>
      page.locator("form").filter({ has: page.getByLabel(file, { exact: true }) }),
    async makeCurrent({ waitForPoll = true }: { waitForPoll?: boolean } = {}) {
      await expectDeploymentOutcome(page, "Queued", { reveal: false });
      const nextRevision = versions[current + 1];
      const currentRevision = versions[current];
      assert.ok(nextRevision);
      assert.ok(currentRevision);
      await fixture.activateRevision(namespace.id, agent.id, nextRevision.id, currentRevision.id);
      current += 1;
      completed.add(nextRevision.id);
      if (versions.length < count) {
        versions.push(checkedWorkspaceRevision(await fixture.deployAgent(namespace.id, agent.id)));
      }
      // The real completion poll rereads Agent selection and the new pending deployment.
      const settled = page.clock.runFor(DEPLOYMENT_POLL_MS);
      if (waitForPoll) {
        await settled;
      }
      return { settled };
    },
  };
}

function workspaceStatus(form: Locator) {
  return form.locator('[role="status"]').textContent();
}

// A missing file already says so; rereading it for another version must not add a "could not be
// reread" status, and a reread that answers clears an earlier one (finding 1878). The first load
// of a file the API confirms missing says so plainly, without an error (finding 1909).
test("a Workspace reread keeps a missing file's notice and clears a failed reread once a file reads again", async (t) => {
  // Files whose next read fails; IDENTITY.md is missing until it is given content.
  let failOnce = new Set<string>();
  let identityContent: string | undefined = undefined;
  const saved = new Map<string, string>();
  const { fixture, page, filePath, form, makeCurrent } = await openWorkspaceVersions(
    t,
    "Workspace missing reread",
    {
      async read({ filename }: Parameters<ControllerWorkspaceFilesAccess["read"]>[0]) {
        if (failOnce.delete(filename)) {
          return { status: "unavailable" };
        }
        if (filename === "IDENTITY.md" && identityContent === undefined) {
          return { status: "missing" };
        }
        const content =
          saved.get(filename) ?? (filename === "IDENTITY.md" ? identityContent : `# ${filename}\n`);
        assert.ok(content !== undefined);
        return { status: "ok", file: { name: filename, content } };
      },
      async write({ filename, content }: Parameters<ControllerWorkspaceFilesAccess["write"]>[0]) {
        saved.set(filename, content);
        return { status: "ok", file: { name: filename, size: Buffer.byteLength(content) } };
      },
    },
    6,
  );
  // Settled reads and writes per file, so each step waits for every reread to be applied.
  const settled: Record<string, number> & {
    "AGENTS.md": number;
    "SOUL.md": number;
    "IDENTITY.md": number;
    "USER.md": number;
  } = { "AGENTS.md": 1, "SOUL.md": 1, "IDENTITY.md": 1, "USER.md": 1 };
  const nextVersion = async (failing: string[]) => {
    failOnce = new Set(failing);
    await makeCurrent();
    for (const [file, count] of Object.entries(settled)) {
      settled[file] = count + 1;
      await waitForSettledFetches(page, filePath(file), settled[file]);
    }
  };
  const missingNotice = "IDENTITY.md is missing. Save to create it.";
  const rereadFailed = (file: string) =>
    `${file} could not be reread. Reload to check its current contents.`;
  const identity = form("IDENTITY.md");
  const identityError = identity.locator('[role="alert"]');
  const soul = form("SOUL.md");
  const user = form("USER.md");
  await identity.getByText(missingNotice, { exact: true }).waitFor({ state: "attached" });
  assert.equal(await identityError.textContent(), "");
  await waitForEnabled(
    page.getByRole("button", { name: "Save IDENTITY.md", exact: true, includeHidden: true }),
  );

  // The gateway cannot read SOUL.md; IDENTITY.md is still missing and says nothing new.
  await nextVersion(["SOUL.md"]);
  assert.equal(await workspaceStatus(soul), rereadFailed("SOUL.md"));
  assert.equal(await workspaceStatus(identity), missingNotice);
  assert.equal(await identityError.textContent(), "");

  // SOUL.md reads again, unchanged, so its failure no longer applies. IDENTITY.md cannot be
  // read, which may mean it now exists.
  await nextVersion(["IDENTITY.md"]);
  assert.equal(await workspaceStatus(soul), "");
  assert.equal(await page.getByLabel("SOUL.md", { exact: true }).inputValue(), "# SOUL.md\n");
  assert.equal(await workspaceStatus(identity), rereadFailed("IDENTITY.md"));
  assert.equal(await identityError.textContent(), "");

  // IDENTITY.md reads as missing again, which restores its notice. SOUL.md and USER.md fail;
  // the reader reloads one and saves the other, and their own status replaces the failure.
  await nextVersion(["SOUL.md", "USER.md"]);
  assert.equal(await workspaceStatus(identity), missingNotice);
  assert.equal(await identityError.textContent(), "");
  assert.equal(await workspaceStatus(soul), rereadFailed("SOUL.md"));
  assert.equal(await workspaceStatus(user), rereadFailed("USER.md"));
  await chooseWorkspaceFile(page, "SOUL.md");
  await page
    .getByRole("button", { name: "Reload SOUL.md", exact: true, includeHidden: true })
    .click();
  settled["SOUL.md"] += 1;
  await waitForSettledFetches(page, filePath("SOUL.md"), settled["SOUL.md"]);
  await soul.getByText("SOUL.md loaded.", { exact: true }).waitFor({ state: "attached" });
  await chooseWorkspaceFile(page, "USER.md");
  await page.getByLabel("USER.md", { exact: true }).fill("# Saved USER.md\n");
  await chooseWorkspaceFile(page, "USER.md");
  await page
    .getByRole("button", { name: "Save USER.md", exact: true, includeHidden: true })
    .click();
  settled["USER.md"] += 1;
  await waitForSettledFetches(page, filePath("USER.md"), settled["USER.md"]);
  await user.getByText("USER.md saved.", { exact: true }).waitFor({ state: "attached" });

  // The reader reloads IDENTITY.md, which the API confirms is missing.
  await chooseWorkspaceFile(page, "IDENTITY.md");
  await page
    .getByRole("button", { name: "Reload IDENTITY.md", exact: true, includeHidden: true })
    .click();
  settled["IDENTITY.md"] += 1;
  await waitForSettledFetches(page, filePath("IDENTITY.md"), settled["IDENTITY.md"]);
  await identity
    .getByText("IDENTITY.md is missing. Save to create it.", { exact: true })
    .waitFor({ state: "attached" });
  assert.equal(await identityError.textContent(), "");

  // The next version answers SOUL.md and USER.md unchanged, so the reader's statuses stay.
  // IDENTITY.md is answered by a resource 404, which does not confirm the file is still
  // missing, so the reader learns the reread failed.
  await page.route(
    `${fixture.origin}${filePath("IDENTITY.md")}`,
    (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "NOT_FOUND", message: RESOURCE_NOT_FOUND },
          meta: { requestId: "req_test_workspace_resource_404" },
        }),
      }),
    { times: 1 },
  );
  await nextVersion([]);
  assert.equal(await workspaceStatus(soul), "SOUL.md loaded.");
  assert.equal(await workspaceStatus(user), "USER.md saved.");
  assert.equal(await page.getByLabel("USER.md", { exact: true }).inputValue(), "# Saved USER.md\n");
  assert.equal(await workspaceStatus(identity), rereadFailed("IDENTITY.md"));

  // IDENTITY.md now exists, empty, so the failure and any missing error go.
  identityContent = "";
  await nextVersion([]);
  assert.equal(await identityError.textContent(), "");
  assert.equal(await workspaceStatus(identity), "IDENTITY.md reloaded with its current contents.");
  assert.equal(await workspaceStatus(soul), "SOUL.md loaded.");
});

// After a Reload confirms a file missing, its status is the only missing notice: a failed reread
// replaces it until a reread confirms the file still missing (finding 1885). Only a file last
// read as missing is quiet about a missing answer; one read with content that is then deleted
// reports the failed reread and keeps its last text (finding 1886).
test("a Workspace reread restores a reloaded missing file's notice and reports a deleted file", async (t) => {
  // Files whose next read fails; a file without content is missing.
  let failOnce = new Set<string>();
  const contents = new Map([
    ["AGENTS.md", "# AGENTS.md\n"],
    ["SOUL.md", "# SOUL.md\n"],
    ["USER.md", "# USER.md\n"],
  ]);
  const { page, filePath, form, makeCurrent } = await openWorkspaceVersions(
    t,
    "Workspace reloaded missing reread",
    {
      async read({ filename }: Parameters<ControllerWorkspaceFilesAccess["read"]>[0]) {
        if (failOnce.delete(filename)) {
          return { status: "unavailable" };
        }
        if (!contents.has(filename)) {
          return { status: "missing" };
        }
        const content = contents.get(filename);
        assert.ok(content !== undefined);
        return { status: "ok", file: { name: filename, content } };
      },
      async write() {
        throw new Error("no Workspace file may be written");
      },
    },
    4,
  );
  const settled: Record<string, number> & {
    "AGENTS.md": number;
    "SOUL.md": number;
    "IDENTITY.md": number;
    "USER.md": number;
  } = { "AGENTS.md": 1, "SOUL.md": 1, "IDENTITY.md": 1, "USER.md": 1 };
  const nextVersion = async (failing: string[]) => {
    failOnce = new Set(failing);
    await makeCurrent();
    for (const [file, count] of Object.entries(settled)) {
      settled[file] = count + 1;
      await waitForSettledFetches(page, filePath(file), settled[file]);
    }
  };
  const rereadFailed = (file: string) =>
    `${file} could not be reread. Reload to check its current contents.`;
  const missingNotice = "IDENTITY.md is missing. Save to create it.";
  const identity = form("IDENTITY.md");
  const identityError = identity.locator('[role="alert"]');
  const soul = form("SOUL.md");
  const soulEditor = page.getByLabel("SOUL.md", { exact: true });
  await soul.getByText("SOUL.md loaded.", { exact: true }).waitFor({ state: "attached" });

  // The reader reloads IDENTITY.md, which the API confirms is missing.
  await chooseWorkspaceFile(page, "IDENTITY.md");
  await page
    .getByRole("button", { name: "Reload IDENTITY.md", exact: true, includeHidden: true })
    .click();
  settled["IDENTITY.md"] += 1;
  await waitForSettledFetches(page, filePath("IDENTITY.md"), settled["IDENTITY.md"]);
  await identity.getByText(missingNotice, { exact: true }).waitFor();
  assert.equal(await identityError.textContent(), "");

  const identityTab = page.getByRole("tab", { name: "Identity · IDENTITY.md", exact: true });
  const identityOption = page
    .getByLabel("Workspace file", { exact: true })
    .locator('option[value="IDENTITY.md"]');
  await identityTab.getByText("Missing", { exact: true }).waitFor();
  assert.equal(await identityOption.textContent(), "Identity · IDENTITY.md — Missing");

  // IDENTITY.md cannot be reread. SOUL.md is deleted, and its missing answer is reported as a
  // failed reread, since the editor still shows its last text.
  contents.delete("SOUL.md");
  await nextVersion(["IDENTITY.md"]);
  assert.equal(await workspaceStatus(identity), rereadFailed("IDENTITY.md"));
  assert.equal(await workspaceStatus(soul), rereadFailed("SOUL.md"));
  assert.equal(await soulEditor.inputValue(), "# SOUL.md\n");
  await identityTab.getByText("Needs attention", { exact: true }).waitFor();
  assert.equal(await identityOption.textContent(), "Identity · IDENTITY.md — Needs attention");

  // IDENTITY.md is confirmed missing again, so its notice returns; SOUL.md still reports that
  // its text may be out of date.
  await nextVersion([]);
  assert.equal(await workspaceStatus(identity), missingNotice);
  assert.equal(await identityError.textContent(), "");
  assert.equal(await page.getByLabel("IDENTITY.md", { exact: true }).inputValue(), "");
  await identityTab.getByText("Missing", { exact: true }).waitFor();
  assert.equal(await identityOption.textContent(), "Identity · IDENTITY.md — Missing");
  assert.equal(await workspaceStatus(soul), rereadFailed("SOUL.md"));
  assert.equal(await soulEditor.inputValue(), "# SOUL.md\n");

  // A further confirmed-missing reread leaves the notice as it is.
  await nextVersion([]);
  assert.equal(await workspaceStatus(identity), missingNotice);
  assert.equal(await identityError.textContent(), "");
});

test("a Workspace reread answered after a Reload keeps the Reload's answer", async (t) => {
  const before = "# SOUL.md before the deployment\n";
  let soul = before;
  const { fixture, page, filePath, form, makeCurrent } = await openWorkspaceVersions(
    t,
    "Workspace reread order",
    {
      async read({ filename }: Parameters<ControllerWorkspaceFilesAccess["read"]>[0]) {
        const content = filename === "SOUL.md" ? soul : `# ${filename}\n`;
        return { status: "ok", file: { name: filename, content } };
      },
      async write() {
        throw new Error("no Workspace file may be written");
      },
    },
  );
  const editor = page.getByLabel("SOUL.md", { exact: true });
  // The reread reads SOUL.md from the server, and its answer is held.
  const reread = await holdRequests(t, page, `${fixture.origin}${filePath("SOUL.md")}`, {
    once: true,
    afterServer: true,
  });
  soul = "# SOUL.md read by the reread\n";
  await makeCurrent();
  await reread.requested;
  // Someone restores the file, and the reader's Reload answers before the reread.
  soul = before;
  await chooseWorkspaceFile(page, "SOUL.md");
  await page
    .getByRole("button", { name: "Reload SOUL.md", exact: true, includeHidden: true })
    .click();
  await form("SOUL.md")
    .getByText("SOUL.md loaded.", { exact: true })
    .waitFor({ state: "attached" });
  await waitForSettledFetches(page, filePath("SOUL.md"), 2);
  reread.release();
  await waitForSettledFetches(page, filePath("SOUL.md"), 3);
  assert.equal(await editor.inputValue(), before);
  assert.equal(await workspaceStatus(form("SOUL.md")), "SOUL.md loaded.");
});

// A reader who clicked into a file without editing keeps caret, selection and scroll when the
// file is reread with different contents; assigning the new value alone moved the caret to the
// end, where the next key landed and the editor jumped (finding 1889).
test("a Workspace reread keeps the caret and scroll of a focused, unedited editor", async (t) => {
  const content = (revision: string) =>
    `# SOUL.md served by ${revision}\n` +
    Array.from({ length: 60 }, (_, line) => `line ${line} of SOUL.md for ${revision}\n`).join("");
  const { page, filePath, form, makeCurrent, versions } = await openWorkspaceVersions(
    t,
    "Workspace focused reread",
    {
      async read({ revision, filename }: Parameters<ControllerWorkspaceFilesAccess["read"]>[0]) {
        const text = filename === "SOUL.md" ? content(revision.id) : `# ${filename}\n`;
        return { status: "ok", file: { name: filename, content: text } };
      },
      async write() {
        throw new Error("no Workspace file may be written");
      },
    },
  );
  await chooseWorkspaceFile(page, "SOUL.md");
  const soul = page.getByLabel("SOUL.md", { exact: true });
  assert.ok(versions[0]);
  assert.ok(versions[1]);
  const before = content(versions[0].id);
  const after = content(versions[1].id);
  const start = before.indexOf("line 30 ");
  assert.equal(after.indexOf("line 30 "), start);
  await waitForInputValue(soul, before);
  // The files can load while the detail view is still held back for its overview read, and a
  // hidden editor has no scroll height and takes no focus; wait until SOUL.md is shown and
  // overflows (finding 2034).
  await page.waitForFunction(() => {
    const node = globalThis.document.getElementById("workspace-SOUL.md");
    return node !== null && node.scrollHeight > node.clientHeight;
  });
  // The reader clicks into line 30 and selects a word; the editor scrolls to centre that line.
  // Lines are alike, so the line's share of the text is its share of the scroll height.
  await soul.evaluate((node, offset) => {
    if (!(node instanceof HTMLTextAreaElement)) {
      throw new Error("Expected a Workspace textarea");
    }
    node.focus();
    node.setSelectionRange(offset, offset + 4, "backward");
    const lines = node.value.split("\n").length;
    const line = node.value.slice(0, offset).split("\n").length - 0.5;
    node.scrollTop = (line / lines) * node.scrollHeight - node.clientHeight / 2;
  }, start);
  const editorState = () =>
    soul.evaluate((node) => {
      if (!(node instanceof HTMLTextAreaElement)) {
        throw new Error("Expected a Workspace textarea");
      }
      return {
        focused: node.ownerDocument.activeElement === node,
        selection: [node.selectionStart, node.selectionEnd, node.selectionDirection],
        scrollTop: node.scrollTop,
      };
    });
  const shown = await editorState();
  assert.ok(shown.scrollTop > 0, "SOUL.md must scroll for this test");
  assert.deepEqual(shown.selection, [start, start + 4, "backward"]);

  // The next version serves different contents; the Agent read that rereads the file is started
  // without moving focus, as the deployment poll does.
  await makeCurrent();
  await waitForInputValue(soul, after);
  await form("SOUL.md")
    .getByText("SOUL.md reloaded with its current contents.", { exact: true })
    .waitFor({ state: "attached" });
  await waitForSettledFetches(page, filePath("SOUL.md"), 2);
  assert.deepEqual(await editorState(), { ...shown, focused: true });

  // The next key replaces the selection where the reader left it, and the editor stays put.
  await page.keyboard.type("Q");
  assert.equal(await soul.inputValue(), `${after.slice(0, start)}Q${after.slice(start + 4)}`);
  assert.equal((await editorState()).scrollTop, shown.scrollTop);
});

test("a Workspace version change during a Reload or Save rereads the file once it settles", async (t) => {
  const saved = new Map<string, string>();
  const { fixture, page, requests, filePath, form, makeCurrent, versions } =
    await openWorkspaceVersions(t, "Workspace deferred reread", {
      async read({ revision, filename }: Parameters<ControllerWorkspaceFilesAccess["read"]>[0]) {
        const content = saved.get(filename) ?? `# ${filename} served by ${revision.id}\n`;
        return { status: "ok", file: { name: filename, content } };
      },
      async write({ filename, content }: Parameters<ControllerWorkspaceFilesAccess["write"]>[0]) {
        saved.set(filename, content);
        return { status: "ok", file: { name: filename, size: Buffer.byteLength(content) } };
      },
    });
  const soul = page.getByLabel("SOUL.md", { exact: true });
  const user = page.getByLabel("USER.md", { exact: true });
  // A Reload of SOUL.md reads the first version, and its answer is held.
  const reload = await holdRequests(t, page, `${fixture.origin}${filePath("SOUL.md")}`, {
    once: true,
    afterServer: true,
  });
  await chooseWorkspaceFile(page, "SOUL.md");
  await page
    .getByRole("button", { name: "Reload SOUL.md", exact: true, includeHidden: true })
    .click();
  await reload.requested;
  // A Save of USER.md is held before it reaches the server.
  const save = await holdRequests(t, page, `${fixture.origin}${filePath("USER.md")}`, {
    once: true,
    method: "PUT",
  });
  await chooseWorkspaceFile(page, "USER.md");
  await user.fill("# Saved during the deployment\n");
  await chooseWorkspaceFile(page, "USER.md");
  await page
    .getByRole("button", { name: "Save USER.md", exact: true, includeHidden: true })
    .click();
  await save.requested;

  await makeCurrent();
  assert.ok(versions[1]);
  await waitForInputValue(
    page.getByLabel("AGENTS.md", { exact: true }),
    `# AGENTS.md served by ${versions[1].id}\n`,
  );
  // The Reload answers with the first version; the file is then reread from the second.
  reload.release();
  await waitForInputValue(soul, `# SOUL.md served by ${versions[1].id}\n`);
  await form("SOUL.md")
    .getByText("SOUL.md reloaded with its current contents.", { exact: true })
    .waitFor({ state: "attached" });
  // The Save lands, and the reread after it keeps the saved text.
  const userReads = () => pathRequests(requests, "GET", filePath("USER.md")).length;
  assert.equal(userReads(), 1);
  save.release();
  await form("USER.md").getByText("USER.md saved.", { exact: true }).waitFor({ state: "attached" });
  await waitForCondition(() => userReads() === 2, "USER.md was not reread after its Save");
  await waitForSettledFetches(page, filePath("USER.md"), 3);
  assert.equal(await user.inputValue(), "# Saved during the deployment\n");
  assert.equal(await workspaceStatus(form("USER.md")), "USER.md saved.");
});

// Deletion replaces the page; an Agent read that answers afterwards has nothing to update.
test("an Agent read answered after deletion was requested leaves the Workspace files alone", async (t) => {
  const name = "Workspace deletion read";
  const { fixture, page, requests, agentPath, makeCurrent } = await openWorkspaceVersions(t, name, {
    async read({ revision, filename }: Parameters<ControllerWorkspaceFilesAccess["read"]>[0]) {
      return {
        status: "ok",
        file: { name: filename, content: `# ${filename} served by ${revision.id}\n` },
      };
    },
    async write() {
      throw new Error("no Workspace file may be written");
    },
  });
  // Refresh deployment reads the Agent with the next version current; the answer is held.
  const agentRead = await holdRequests(t, page, `${fixture.origin}${agentPath}`, {
    once: true,
    method: "GET",
    afterServer: true,
  });
  const poll = await makeCurrent({ waitForPoll: false });
  await agentRead.requested;
  await page.clock.resume();
  await page.getByRole("tab", { name: "Configuration", exact: true }).click();
  await page.getByRole("button", { name: "Delete Agent" }).click();
  await page
    .getByRole("dialog", { name: `Delete ${name}?` })
    .getByRole("button", { name: "Permanently delete Agent" })
    .click();
  await page.getByRole("heading", { name: "Deletion queued", exact: true }).waitFor();
  const workspaceReads = () =>
    requests.filter((r) => r.method === "GET" && r.path.startsWith(`${agentPath}/workspace/`))
      .length;
  assert.equal(workspaceReads(), 4);
  agentRead.release();
  await poll.settled;
  await waitForIdleFetches(page);
  await settlePageRequests(page);
  assert.equal(workspaceReads(), 4);
  await page.getByRole("heading", { name: "Deletion queued", exact: true }).waitFor();
});

test("explicit missing-file readback settles an uncertain workspace create without replaying it", async (t) => {
  const root = await temporaryDirectory(t, "console-workspace-missing-");
  let unavailable = false;
  const fixture = await createConsoleAppFixture(t, {
    publicOrigin: true,
    workspaceFilesAccess: {
      async read({ filename }: Parameters<ControllerWorkspaceFilesAccess["read"]>[0]) {
        if (unavailable) {
          return { status: "unavailable" };
        }
        try {
          return {
            status: "ok",
            file: { name: filename, content: await readFile(join(root, filename), "utf8") },
          };
        } catch (cause) {
          return {
            status:
              cause instanceof Error && "code" in cause && cause.code === "ENOENT"
                ? "missing"
                : "unavailable",
          };
        }
      },
      async write({ filename, content }: Parameters<ControllerWorkspaceFilesAccess["write"]>[0]) {
        await writeFile(join(root, filename), content);
        return { status: "ok", file: { name: filename, size: Buffer.byteLength(content) } };
      },
    },
  });
  await fixture.bootstrap();
  const namespace = await fixture.createNamespace("Missing workspace readback", { ready: true });
  const agent = await fixture.createAgent(
    namespace.id,
    "Missing file Agent",
    nativeValues("missing"),
  );
  const active = await fixture.seedActiveAgentRevision(namespace.id, agent.id);
  const path = `/namespaces/${namespace.id}/agents/${agent.id}/workspace/files/USER.md`;
  const { page } = await newPage(t, fixture);
  const requests = apiRequests(page, fixture.origin);
  let dropped = false;
  await page.route(fixture.origin + path, async (route) => {
    if (route.request().method() === "PUT" && !dropped) {
      dropped = true;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  const missingAgent = await fixture.request(
    "GET",
    `/namespaces/${namespace.id}/agents/agt_${randomUUID()}/workspace/files/USER.md`,
  );
  assert.equal(missingAgent.status, 404);
  assert.deepEqual(missingAgent.body.error, {
    code: "NOT_FOUND",
    message: RESOURCE_NOT_FOUND,
  });
  const answerWithMissingAgent = () =>
    page.route(
      fixture.origin + path,
      (route) => {
        assert.equal(route.request().method(), "GET");
        return route.fulfill({ status: missingAgent.status, json: missingAgent.body });
      },
      { times: 1 },
    );
  await answerWithMissingAgent();
  await login(
    page,
    fixture,
    detailUrl(fixture, namespace.id, agent.id, active.revision.id, "workspace"),
  );
  const editor = page.getByLabel("USER.md", { exact: true });
  const save = page.getByRole("button", { name: "Save USER.md", exact: true, includeHidden: true });
  const reload = page.getByRole("button", {
    name: "Reload USER.md",
    exact: true,
    includeHidden: true,
  });
  const form = page.locator("form").filter({ has: editor });
  // An unavailable Agent does not tell us its file is absent, even on the first read.
  await chooseWorkspaceFile(page, "USER.md");
  await form.getByText("File unavailable or missing.", { exact: false }).waitFor();
  assert.equal(await editor.isDisabled(), true);
  await reload.click();
  await waitForWorkspaceEditors(page, ["USER.md"]);
  await chooseWorkspaceFile(page, "USER.md");
  await editor.fill("# Interrupted first create\n");
  await save.click();
  await form.getByText("Outcome unknown.", { exact: false }).waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal((await fixture.request("GET", path)).status, 404);
  const writeRequests = () => pathRequests(requests, "PUT", path);
  assert.equal(writeRequests().length, 1);
  // A formal resource 404, unlike file absence, cannot settle this unknown write.
  await answerWithMissingAgent();
  await reload.click();
  await form.getByText("File unavailable or missing.", { exact: false }).waitFor();
  assert.equal(await editor.isDisabled(), true);
  assert.equal(await save.isDisabled(), true);
  assert.equal(writeRequests().length, 1);
  // A real IAM refusal also leaves the draft guarded. Restore the fixture's own grant afterwards.
  const administrator = fixture.policy.roles[0];
  assert.ok(administrator);
  const permissions = administrator.permissions;
  administrator.permissions = permissions.filter(
    (permission: Permission) =>
      !(permission.action === "read" && permission.resourceKind === "agent"),
  );
  await reload.click();
  // The API names the read grant its own denial checked (finding 2534).
  await form
    .getByText(new RegExp(`^${RegExp.escape(callerDenied("Agent read", `Agent ${agent.id}`))}`))
    .waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(writeRequests().length, 1);
  administrator.permissions = permissions;
  unavailable = true;
  await reload.click();
  await form.getByText(WORKSPACE_UNREACHABLE, { exact: false }).waitFor();
  assert.equal(await editor.isDisabled(), true);
  assert.equal(await save.isDisabled(), true);
  assert.equal(writeRequests().length, 1);
  unavailable = false;
  // A rate limit says how long to wait instead of blaming the gateway (finding 2538).
  await page.route(
    fixture.origin + path,
    (route) =>
      route.request().method() === "GET"
        ? route.fulfill({ ...proxyErrorResponse(429), headers: { "retry-after": "30" } })
        : route.fallback(),
    { times: 1 },
  );
  await reload.click();
  await form.getByText(tooManyRequestsIn(30), { exact: false }).waitFor();
  // A request that never reached the API says so, not that the gateway is down.
  await page.route(
    fixture.origin + path,
    (route) => (route.request().method() === "GET" ? route.abort() : route.fallback()),
    { times: 1 },
  );
  await reload.click();
  await form.getByText(WORKSPACE_API_UNREACHABLE, { exact: true }).waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(writeRequests().length, 1);
  const reply = page.waitForResponse(
    (response) => response.url() === fixture.origin + path && response.request().method() === "GET",
  );
  await reload.click();
  const missingFile = await reply;
  assert.equal(missingFile.status(), 404);
  const missingFileBody: unknown = await missingFile.json();
  assert.ok(
    typeof missingFileBody === "object" && missingFileBody !== null && "error" in missingFileBody,
  );
  assert.deepEqual(missingFileBody.error, {
    code: "NOT_FOUND",
    message: "The requested workspace file was not found.",
  });
  await form
    .getByText("USER.md is missing. Save to create it.", { exact: true })
    .waitFor({ state: "attached" });
  await waitForEnabled(editor);
  assert.equal(await editor.inputValue(), "", "explicit Reload discards the uncertain draft");
  assert.equal(writeRequests().length, 1, "readback never automatically repeats a write");
  await chooseWorkspaceFile(page, "USER.md");
  await editor.fill("# Deliberate replacement create\n");
  // The controller saves USER.md. A success naming SOUL.md cannot confirm that write,
  // and a later read naming SOUL.md cannot authorize a replacement of USER.md either.
  await page.route(
    fixture.origin + path,
    async (route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      const body: unknown = await response.json();
      assert.ok(typeof body === "object" && body !== null && "data" in body && "meta" in body);
      const { data, meta } = body;
      assert.ok(typeof data === "object" && data !== null && "name" in data);
      assert.equal(data.name, "USER.md");
      await route.fulfill({ response, json: { data: { ...data, name: "SOUL.md" }, meta } });
    },
    { times: 2 },
  );
  await save.click();
  await form.getByText("Outcome unknown.", { exact: false }).waitFor();
  assert.equal(await save.isDisabled(), true);
  assert.equal(await readFile(join(root, "USER.md"), "utf8"), "# Deliberate replacement create\n");
  await reload.click();
  await form.getByText(WORKSPACE_UNREACHABLE, { exact: false }).waitFor();
  assert.equal(await save.isDisabled(), true);
  await reload.click();
  await form.getByText("USER.md loaded.", { exact: true }).waitFor({ state: "attached" });
  assert.equal(await editor.inputValue(), "# Deliberate replacement create\n");
  assert.equal(writeRequests().length, 2);
});
