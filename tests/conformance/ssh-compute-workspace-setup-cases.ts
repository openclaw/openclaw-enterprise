import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ComputeRevisionContext,
  OpenClawConfigurationDocument,
} from "../../packages/contracts/src/index.ts";
import { bind, fixture, missing, readRecord, revision, tenant } from "./ssh-compute-fixture.ts";

test("SSH setup failures withhold activation, preserve private input, and reject foreign workspaces", async (t) => {
  for (const scenario of [
    "foreign Agent",
    "foreign workspace",
    "unsupported roster",
    "native failure",
  ]) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      assert.equal((await f.driver.ensureNamespace(tenant)).namespaceReady, true);
      const configuration: OpenClawConfigurationDocument =
        scenario === "foreign workspace"
          ? { agents: { defaults: { workspace: "/tmp/foreign-workspace" } } }
          : scenario === "unsupported roster"
            ? { agents: { entries: { helper: {} } } }
            : {};
      const first = revision(f.driver, 1, "agent-ssh-setup", configuration);
      bind(f.driver, first);
      const content = "private-setup-content-must-not-leak";
      const context: ComputeRevisionContext = {
        secretEnvironment: [],
        harnessAuth: { method: "runtime" },
        workspaceSetup: {
          id: "setup-ssh",
          namespaceId: tenant.id,
          agentId: scenario === "foreign Agent" ? "another-agent" : first.agentId,
          files: { "AGENTS.md": content },
          completed: false,
        },
      };
      assert.equal(f.driver.supportsWorkspaceSetup, true);
      await assert.rejects(f.driver.prepareRevision(first, context), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes(content), false);
        return /SSH/.test(error.message);
      });
      await missing(join(f.agentDir(first), "workspace-setup.json"));
      await missing(join(f.agentDir(first), "current"));
      await missing(join(f.units, f.unit(first)));
      const snapshot = await readFile(join(f.revisionDir(first), "openclaw.json"), "utf8");
      assert.equal(snapshot.includes(content), false);
      const marker = await readFile(join(f.revisionDir(first), "revision.json"), "utf8");
      assert.equal(marker.includes(content), false);
    });
  }
});

test("SSH setup reads the main roster entry under any letter case, like Kubernetes and Docker", async (t) => {
  // The fixture has no runuser, so a stand-in records the workspace the helper chose.
  const bin = await mkdtemp(join(tmpdir(), "occ-ssh-runuser-"));
  const runuser = join(bin, "runuser");
  await writeFile(
    runuser,
    `#!/bin/sh\nprintf '%s' "$OPENCLAW_WORKSPACE_DIR" > "$OCC_SSH_FIXTURE_STATE/setup-workspace"\n`,
  );
  await chmod(runuser, 0o755);
  const previousPath = process.env.PATH;
  t.after(async () => {
    await rm(bin, { recursive: true, force: true });
  });
  for (const key of ["Main", " MAIN "]) {
    await t.test(JSON.stringify(key), async (t) => {
      const f = await fixture(t, {}, `${bin}:${previousPath}`);
      assert.equal((await f.driver.ensureNamespace(tenant)).namespaceReady, true);
      const agentId = "agent-ssh-roster";
      const workspace = join(f.agentDir({ agentId }), "state", "roster");
      // The entry's workspace wins over the defaults, as for the literal main key.
      const configuration = {
        agents: {
          defaults: { workspace: "/tmp/foreign-workspace" },
          entries: { [key]: { workspace } },
        },
      };
      const first = revision(f.driver, 1, agentId, configuration);
      bind(f.driver, first);
      const prepared = await f.driver.prepareRevision(first, {
        secretEnvironment: [],
        harnessAuth: { method: "runtime" },
        workspaceSetup: {
          id: "setup-ssh-roster",
          namespaceId: tenant.id,
          agentId,
          files: { "AGENTS.md": "roster" },
          completed: false,
        },
      });
      assert.equal(prepared.ready, true);
      assert.equal(await readFile(join(f.state, "setup-workspace"), "utf8"), workspace);
      assert.equal(
        (await readRecord(join(f.agentDir(first), "workspace-setup.json"))).completed,
        true,
      );
    });
  }
  // As in the shared rule, the roster holds exactly one main entry: two keys that both name
  // main, an empty roster and a null entry are refused before setup runs.
  const invalidRosters: OpenClawConfigurationDocument[] = [
    { main: {}, Main: {} },
    {},
    { Main: null },
  ];
  for (const entries of invalidRosters) {
    await t.test(`refuses ${JSON.stringify(entries)}`, async (t) => {
      const f = await fixture(t, {}, `${bin}:${previousPath}`);
      assert.equal((await f.driver.ensureNamespace(tenant)).namespaceReady, true);
      const refused = revision(f.driver, 1, "agent-ssh-refused", { agents: { entries } });
      bind(f.driver, refused);
      await assert.rejects(
        f.driver.prepareRevision(refused, {
          secretEnvironment: [],
          harnessAuth: { method: "runtime" },
          workspaceSetup: {
            id: "setup-ssh-refused",
            namespaceId: tenant.id,
            agentId: refused.agentId,
            files: { "AGENTS.md": "roster" },
            completed: false,
          },
        }),
        /SSH helper rejected host or revision configuration/,
      );
      // The helper withholds its reason; the stand-in never ran, so the roster refused it.
      await missing(join(f.state, "setup-workspace"));
      await missing(join(f.agentDir(refused), "workspace-setup.json"));
    });
  }
});
