import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  InstallationDeploymentInventory,
  InstallationDeploymentInventoryAgent,
  InstallationDeploymentInventoryNamespace,
} from "@openclaw-enterprise/contracts";

// The command fixture also accepts deliberately malformed JSON and raw stdout.
// Undefined object fields are omitted when the fixture serializes its state.
type JsonObject = { readonly [key: string]: JsonValue | undefined };
type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

type FixtureOptions = {
  agent?: true;
  controllerOnly?: true;
  candidates?: true;
  inventoryRequiresApi?: true;
  activeRevisionResponse?: JsonObject | string;
  inventoryNamespaces?: readonly (InstallationDeploymentInventoryNamespace | JsonObject)[];
  inventoryResponses?: readonly (InstallationDeploymentInventory | JsonObject | string)[];
};

type UpgradeState = {
  api: number;
  worker: number;
  version: number;
  dispatches: number;
  inventoryReadCount?: number;
  preflight?: { created?: readonly { kind: string; name: string; uid: string }[] };
};

type UpgradeFixture = {
  directory: string;
  evidence: string;
  run(...args: string[]): Promise<unknown>;
  failNext(fault: string): Promise<void>;
  state(): Promise<UpgradeState>;
  events(): Promise<string[]>;
};

const emptyInventory: InstallationDeploymentInventory = {
  installationId: "ins_test",
  namespaces: [],
};

const readyNamespace = {
  id: "ns_test",
  status: "ready",
} satisfies Pick<InstallationDeploymentInventoryNamespace, "id" | "status">;

const retainedAgent = {
  id: "agt_test",
  status: "active",
  desiredRuntimeState: "running",
  executionMode: "embedded",
  activeRevisionId: "rev_old",
  deploymentInProgress: false,
} satisfies InstallationDeploymentInventoryAgent;

export function restartInventory(
  repositoryWorkerRestart:
    | InstallationDeploymentInventoryAgent["repositoryWorkerRestart"]
    | "missing" = "reverification-supported",
  revision = retainedAgent.activeRevisionId,
): InstallationDeploymentInventory {
  const agent: InstallationDeploymentInventoryAgent = {
    ...retainedAgent,
    activeRevisionId: revision,
    ...(repositoryWorkerRestart === "missing" ? {} : { repositoryWorkerRestart }),
  };
  return {
    ...emptyInventory,
    namespaces: [{ ...readyNamespace, agents: [agent] }],
  };
}

function assertWritersUntouched(state: UpgradeState): void {
  assert.equal(state.version, 1);
  assert.equal(state.api, 1);
  assert.equal(state.worker, 1);
  assert.equal(state.dispatches, 0);
}

export function registerRetainedFleetPreflightTests(
  fixture: (t: TestContext, options: FixtureOptions) => Promise<UpgradeFixture>,
  injectedFault: { code: number },
): void {
  // Run the actual upgrade shell with independent command responses and real JSON tools.
  // This protects refusal before quiescence; it does not prove a live cluster upgrade.
  test("controller-only upgrades refuse incompatible active Harness snapshots before writes", async (t) => {
    const snapshot = {
      id: "rev_old",
      namespaceId: "ns_test",
      agentId: "agt_test",
      configuration: { privateSetting: "tenant-native-value" },
      harness: { id: "codex", version: "1", mode: "dedicated", overrides: {}, configuration: {} },
    };
    for (const [name, response, readFailure = false] of [
      [
        "missing settings",
        { ...snapshot, harness: { id: "codex", version: "1", mode: "dedicated" } },
      ],
      ["null settings", { ...snapshot, harness: { ...snapshot.harness, configuration: null } }],
      ["array overrides", { ...snapshot, harness: { ...snapshot.harness, overrides: [] } }],
      ["wrong revision", { ...snapshot, id: "rev_other" }],
      [
        "unreadable snapshot",
        {
          id: snapshot.id,
          namespaceId: snapshot.namespaceId,
          agentId: snapshot.agentId,
          configurationReadError: { code: "SAVED_CONFIGURATION_UNREADABLE", field: "plugins" },
        },
      ],
      ["denied read", "denied"],
      ["empty snapshot output", ""],
      ["malformed snapshot output", "{"],
      ["failed read after valid output", snapshot, true],
      ["duplicate snapshots", `${JSON.stringify(snapshot)}\n${JSON.stringify(snapshot)}`],
      [
        "invalid snapshot followed by valid snapshot",
        `${JSON.stringify({ ...snapshot, id: "rev_other" })}\n${JSON.stringify(snapshot)}`,
      ],
    ] as const) {
      await t.test(name, async (t) => {
        const f = await fixture(t, {
          agent: true,
          controllerOnly: true,
          activeRevisionResponse: response,
        });
        if (readFailure) {
          await f.failNext("revision-read-failure");
        }
        await assert.rejects(
          f.run(),
          readFailure || response === "denied"
            ? /cannot read active revision/u
            : /missing or unreadable saved Harness settings/u,
        );
        assert.deepEqual(await f.events(), ["revision-read rev_old"]);
        const state = await f.state();
        assertWritersUntouched(state);
        assert.deepEqual(state.preflight?.created ?? [], []);
        const inventoryFiles = await readdir(join(f.evidence, "inventory"));
        if (readFailure) {
          assert.deepEqual(
            inventoryFiles.filter((file) => file.endsWith(".json")),
            ["deployment-inventory.json", "restart-preflight.json"],
          );
        }
        for (const file of inventoryFiles) {
          assert.doesNotMatch(
            await readFile(join(f.evidence, "inventory", file), "utf8"),
            /tenant-native-value/u,
          );
        }
      });
    }
    const agent = {
      id: "agt_valid",
      status: "active",
      desiredRuntimeState: "stopped",
      executionMode: "dedicated",
      activeRevisionId: "rev_old",
      deploymentInProgress: false,
    } satisfies InstallationDeploymentInventoryAgent;
    const namespace = {
      ...readyNamespace,
      agents: [agent],
    } satisfies InstallationDeploymentInventoryNamespace;
    // One valid row must not hide another row whose state cannot be classified.
    for (const [name, field, value] of [
      ["missing deployment state", "deploymentInProgress", undefined],
      ["null deployment state", "deploymentInProgress", null],
      ["nonboolean deployment state", "deploymentInProgress", "false"],
      ["missing desired runtime state", "desiredRuntimeState", undefined],
      ["unknown desired runtime state", "desiredRuntimeState", "unknown"],
      ["missing Agent status", "status", undefined],
      ["missing Agent ID", "id", undefined],
      ["unknown execution mode", "executionMode", "unknown"],
      ["null active revision", "activeRevisionId", null],
    ] as const) {
      await t.test(name, async (t) => {
        const invalid = {
          ...agent,
          id: "agt_test",
          desiredRuntimeState: "running",
          [field]: value,
        };
        const f = await fixture(t, {
          controllerOnly: true,
          inventoryNamespaces: [{ ...namespace, agents: [invalid, agent] }],
        });
        await assert.rejects(f.run(), /deployment inventory/u);
        assert.deepEqual(await f.events(), []);
        const state = await f.state();
        assert.deepEqual(state.preflight?.created ?? [], []);
        assertWritersUntouched(state);
      });
    }
    for (const [name, namespaces] of [
      ["missing Namespaces", undefined],
      ["nonarray Namespaces", {}],
      ["missing Agents", [{ ...namespace, agents: undefined }]],
      ["missing Namespace ID", [{ ...namespace, id: undefined }]],
      ["unknown Namespace status", [{ ...namespace, status: "unknown" }]],
    ] as const) {
      await t.test(name, async (t) => {
        // The same common inventory gate protects runtime upgrades as well.
        const f = await fixture(t, {
          inventoryResponses: [{ installationId: "ins_test", namespaces }],
        });
        await assert.rejects(f.run(), /deployment inventory/u);
        assert.deepEqual(await f.events(), []);
        const state = await f.state();
        assert.deepEqual(state.preflight?.created ?? [], []);
        assertWritersUntouched(state);
      });
    }
    const pendingDedicatedNamespace: InstallationDeploymentInventoryNamespace = {
      ...readyNamespace,
      agents: [
        {
          id: "agt_test",
          status: "active",
          desiredRuntimeState: "running",
          executionMode: "dedicated",
          activeRevisionId: "rev_old",
          deploymentInProgress: true,
        },
      ],
    };
    await t.test(
      "pending deployment refuses before reading an about-to-change snapshot",
      async (t) => {
        const f = await fixture(t, {
          controllerOnly: true,
          inventoryNamespaces: [pendingDedicatedNamespace],
        });
        await assert.rejects(f.run(), /nonterminal Agent work/u);
        assert.deepEqual(await f.events(), []);
        const state = await f.state();
        assertWritersUntouched(state);
        assert.deepEqual(state.preflight?.created ?? [], []);
      },
    );
    await t.test("a stopped Agent may omit its active revision", async (t) => {
      const { activeRevisionId, ...stopped } = agent;
      const f = await fixture(t, {
        controllerOnly: true,
        inventoryNamespaces: [{ ...namespace, agents: [stopped] }],
      });
      await f.run();
      assert.ok(existsSync(join(f.evidence, "completed")));
      assert.equal(
        (await f.events()).some((event) => event.startsWith("revision-read")),
        false,
      );
    });
    await t.test("valid snapshot preserves controller-only behavior", async (t) => {
      const f = await fixture(t, {
        agent: true,
        controllerOnly: true,
        activeRevisionResponse: snapshot,
      });
      await f.run();
      assert.equal((await f.state()).dispatches, 0);
      assert.ok(existsSync(join(f.evidence, "completed")));
      assert.equal((await f.events())[0], "revision-read rev_old");
      const files = await readdir(join(f.evidence, "inventory"));
      const summaries = files.filter(
        (file) =>
          file.endsWith(".json") &&
          ![
            "deployment-inventory.json",
            "restart-preflight.json",
            "before-stop.json",
            "before-stop-selection.json",
          ].includes(file),
      );
      assert.equal(summaries.length, 1);
      assert.deepEqual(
        JSON.parse(await readFile(join(f.evidence, "inventory", summaries[0]!), "utf8")),
        {
          namespaceId: "ns_test",
          agentId: "agt_test",
          revisionId: "rev_old",
          savedHarnessSettings: "readable",
        },
      );
    });
  });

  // These cases exercise the shipped shell and real jq against external command
  // responses. Driver integration separately proves the server's assessment.
  test("repository restart preflight refuses unsafe or incomplete retained fleets before writes", async (t) => {
    const unsafeDisposition =
      /Namespace "ns_test", Agent "agt_test", revision "rev_old": (original-worker-required|unknown)/u;
    const futureInventory = {
      ...emptyInventory,
      namespaces: [
        {
          ...readyNamespace,
          agents: [{ ...retainedAgent, repositoryWorkerRestart: "future-value" }],
        },
      ],
    };
    for (const [name, response, expected] of [
      ...(["original-worker-required", "unknown", "missing"] as const).map(
        (disposition) => [disposition, restartInventory(disposition), unsafeDisposition] as const,
      ),
      ["future-value", futureInventory, unsafeDisposition],
      ["denied", "denied", /cannot read the complete deployment inventory/u],
      ["empty output", "", /inventory is incomplete/u],
      [
        "multiple documents",
        JSON.stringify(restartInventory()) + "\n" + JSON.stringify(restartInventory()),
        /inventory is incomplete/u,
      ],
      // A later valid document must not hide an earlier ownership mismatch.
      [
        "invalid inventory followed by valid inventory",
        JSON.stringify({ installationId: "ins_other", namespaces: [] }) +
          "\n" +
          JSON.stringify(restartInventory()),
        /inventory is incomplete/u,
      ],
    ] as const) {
      await t.test(name, async (t) => {
        const f = await fixture(t, { controllerOnly: true, inventoryResponses: [response] });
        await assert.rejects(f.run(), expected);
        assert.deepEqual(await f.events(), []);
        const state = await f.state();
        assert.deepEqual(state.preflight?.created ?? [], []);
        assertWritersUntouched(state);
      });
    }
  });

  test("repository restart preflight refreshes selections immediately before stopping writers", async (t) => {
    for (const [name, initial, fresh] of [
      [
        "new revision",
        restartInventory(),
        restartInventory("reverification-supported", "rev_changed"),
      ],
      ["changed assessment", restartInventory(), restartInventory("not-applicable")],
      ["new Agent", emptyInventory, restartInventory()],
      ["lost access", restartInventory(), "denied"],
    ] as const) {
      await t.test(name, async (t) => {
        const f = await fixture(t, {
          controllerOnly: true,
          inventoryResponses: [initial, fresh],
        });
        await assert.rejects(
          f.run(),
          /inventory selections or repository restart assessments changed|cannot read the complete deployment inventory/u,
        );
        const state = await f.state();
        assert.equal(state.inventoryReadCount, 2);
        assertWritersUntouched(state);
        assert.equal(
          (await f.events()).some((event) => event.startsWith("scale-")),
          false,
        );
      });
    }
  });

  test("repository restart preflight permits positively assessed or empty fleets without deploying", async (t) => {
    for (const [name, inventory] of [
      ["supported", restartInventory()],
      ["no repository access", restartInventory("not-applicable")],
      ["empty", emptyInventory],
    ] as const) {
      await t.test(name, async (t) => {
        const f = await fixture(t, {
          controllerOnly: true,
          inventoryResponses: [inventory, inventory],
        });
        await f.run();
        const state = await f.state();
        assert.equal(state.inventoryReadCount, 2);
        assert.equal(state.dispatches, 0);
        assert.equal(state.version, 2);
        assert.equal((await f.events()).filter((event) => event.startsWith("scale-")).length, 2);
      });
    }
  });

  test("repository restart preflight resumes prospectively only while the worker still runs", async (t) => {
    await t.test(
      "stopped API must be available for fresh inventory before the remaining stop",
      async (t) => {
        const inventory = restartInventory();
        const f = await fixture(t, {
          controllerOnly: true,
          inventoryRequiresApi: true,
          inventoryResponses: [
            inventory,
            inventory,
            inventory,
            restartInventory("original-worker-required"),
            inventory,
          ],
        });
        await f.failNext("fail-scale-worker");
        await assert.rejects(f.run(), injectedFault);
        assert.deepEqual(
          (await f.events()).filter((event) => event.startsWith("scale-")),
          ["scale-api"],
        );
        await assert.rejects(f.run("--resume"), /Restore access to the existing API/u);
        assert.equal((await f.state()).api, 0);
        assert.equal((await f.state()).worker, 1);
        assert.equal((await f.state()).version, 1);
        assert.equal((await f.state()).dispatches, 0);
        // Once the operator restores the old API, an unsafe fresh assessment still
        // refuses. Earlier positive evidence cannot authorize the remaining stop.
        const state = await f.state();
        state.api = 1;
        await writeFile(join(f.directory, "state.json"), JSON.stringify(state));
        await assert.rejects(f.run("--resume"), /original-worker-required/u);
        assert.equal((await f.state()).api, 1);
        await f.run("--resume");
        assert.equal((await f.state()).dispatches, 0);
        assert.equal((await f.events()).filter((event) => event === "scale-worker").length, 1);
      },
    );
    await t.test(
      "after stopping both writers recovery does not replay stops or reread inventory",
      async (t) => {
        const inventory = restartInventory();
        const f = await fixture(t, {
          controllerOnly: true,
          candidates: true,
          inventoryResponses: [inventory, inventory, "denied"],
        });
        await f.failNext("lost-secret-response");
        await assert.rejects(f.run(), injectedFault);
        const count = (await f.state()).inventoryReadCount;
        assert.equal((await f.state()).worker, 0);
        assert.equal(existsSync(join(f.evidence, "helm-started")), false);
        await f.run("--resume");
        const [retry] = (await readdir(f.evidence)).filter((name) =>
          name.startsWith("upgrade-preflight-resume."),
        );
        assert.ok(retry && existsSync(join(f.evidence, retry, "startup-preflight-passed")));
        assert.equal((await f.state()).inventoryReadCount, count);
        assert.equal((await f.events()).filter((event) => event.startsWith("scale-")).length, 2);
        assert.equal((await f.state()).dispatches, 0);
      },
    );
  });
}
