import { DockerComputeDriver } from "../../apps/controller/src/drivers/compute/docker/index.ts";
import { admitLoggingConfiguration } from "../../packages/contracts/src/index.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createHarnessConfiguration } from "../helpers/harness-configuration.mjs";
import { composeCleanupCase, composeDevelopmentCase } from "./docker-compute-compose-cases.ts";
import {
  containerCount,
  docker,
  dockerJson,
  engineName,
  executionModes,
  LABEL_AGENT,
  LABEL_NAMESPACE,
  LABEL_ROLE,
  podmanSelected,
  providerModel,
  runtimeImages,
  selected,
  waitFor,
  waitForContainers,
} from "./docker-compute-test-engine.ts";

test(
  `${engineName} Compose cleanup preserves the selected engine and removes volumes only when requested`,
  {
    skip: selected
      ? false
      : "Set OCC_TEST_DOCKER_COMPUTE_REAL=1 or OCC_TEST_PODMAN_COMPUTE_REAL=1 for real Compose cleanup.",
    timeout: 300_000,
  },
  composeCleanupCase,
);

test(
  `${engineName} Compose development drives Docker Compute networks, auth, cleanup, and Harness authentication refusal`,
  {
    skip: selected
      ? false
      : "Set OCC_TEST_DOCKER_COMPUTE_REAL=1 or OCC_TEST_PODMAN_COMPUTE_REAL=1 plus Compose runtime image variables and OPENAI_API_KEY to run the real Docker Compute proof.",
    timeout: 1_200_000,
  },
  composeDevelopmentCase,
);

for (const setupMode of executionModes) {
  test(
    `Docker ${setupMode} workspace setup guards first runtime and preserves files across container replacement`,
    {
      skip:
        selected && !podmanSelected
          ? false
          : "Select the real Docker Compute suite with pinned runtime images.",
      timeout: 300_000,
    },
    async (context) => {
      // This is real Docker Driver evidence only. OCC admits no Docker deployment (the
      // Compose journey above asserts that refusal), so no Agent workflow reaches this path.
      const { gateway: gatewayImage, agent: agentImage } = runtimeImages();
      const driver = new DockerComputeDriver({
        images: { gateway: gatewayImage, agent: agentImage },
      });
      const namespace = {
        id: `ns-workspace-${randomUUID()}`,
        name: "Workspace setup proof",
        status: "ready",
        createdAt: new Date().toISOString(),
      };
      const agentId = `agent-workspace-${randomUUID()}`;
      const revision = {
        id: `rev-workspace-${randomUUID()}`,
        namespaceId: namespace.id,
        agentId,
        revision: 1,
        configurationId: `cfg-workspace-${randomUUID()}`,
        configurationKind: "agent",
        configurationGeneration: 1,
        configuration: admitLoggingConfiguration(
          createHarnessConfiguration(
            setupMode === "embedded" ? "openclaw" : "codex",
            providerModel,
          ),
          "info",
        ),
        harness: {
          id: setupMode === "embedded" ? "openclaw" : "codex",
          version: "2026.9.1",
          mode: setupMode,
        },
        compute: { id: driver.id, implementation: driver.implementation },
        // OCC admits every revision with a durable execution admission; Docker Compute
        // supports only unprotected execution (no egress plan) and refuses a revision without one.
        executionAdmission: { version: 2, mode: "unprotected" },
        servicePrincipalId: `sp-workspace-${randomUUID()}`,
        createdAt: namespace.createdAt,
      };
      const setup = {
        id: `setup-${randomUUID()}`,
        namespaceId: namespace.id,
        agentId,
        completed: false,
        files: {
          "AGENTS.md":
            "# Initial workspace instructions\nPreserve this content before first use.\n",
          "SOUL.md": "",
          "IDENTITY.md": "# Identity\n- **Name:** Workspace proof\n",
          "USER.md": "# User\n- **Name:** Integration operator\n",
        },
      };
      const binding = { namespace, agent: { id: agentId, namespaceId: namespace.id } };
      context.after(async () => {
        const result = await driver.deleteNamespace(namespace);
        assert.equal(
          result.namespaceDeleted,
          true,
          "owned containers, volumes, and network must be removed",
        );
      });
      await driver.preflight();
      assert.equal((await driver.ensureNamespace(namespace)).namespaceReady, true);
      assert.equal((await driver.prepareRevision(revision, { workspaceSetup: setup })).ready, true);
      const filters = [
        [LABEL_NAMESPACE, namespace.id],
        [LABEL_AGENT, agentId],
        [LABEL_ROLE, "gateway"],
      ];
      let [gateway] = await waitForContainers(filters, 1, "initialized gateway");
      const workspace = "/home/node/.openclaw/workspace";
      const readFiles = async () => {
        const { stdout } = await docker([
          "exec",
          gateway.Id,
          "node",
          "-e",
          `const fs=require('node:fs'); console.log(JSON.stringify(Object.fromEntries(['AGENTS.md','SOUL.md','IDENTITY.md','USER.md'].map(n=>[n,fs.readFileSync(${JSON.stringify(workspace)}+'/'+n,'utf8')]))));`,
        ]);
        return JSON.parse(stdout);
      };
      assert.deepEqual(await readFiles(), setup.files);
      if (setupMode === "dedicated") {
        const [harness] = await waitForContainers(
          [
            [LABEL_NAMESPACE, namespace.id],
            [LABEL_AGENT, agentId],
            [LABEL_ROLE, "agent"],
          ],
          1,
          "initialized Harness",
        );
        const { stdout } = await docker([
          "exec",
          harness.Id,
          "node",
          "-e",
          "const fs=require('node:fs'); const pid=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).find(p=>{try{return fs.readFileSync('/proc/'+p+'/comm','utf8').trim()==='codex'}catch{return false}}); if(!pid)throw Error('native Codex process missing'); const cwd=fs.readlinkSync('/proc/'+pid+'/cwd'); console.log(JSON.stringify({cwd,files:Object.fromEntries(['AGENTS.md','SOUL.md','IDENTITY.md','USER.md'].map(n=>[n,fs.readFileSync(cwd+'/'+n,'utf8')]))}));",
        ]);
        const observed = JSON.parse(stdout);
        assert.equal(observed.cwd, "/home/node/workspace");
        assert.deepEqual(
          observed.files,
          setup.files,
          "actual Harness cwd must contain the initialized native workspace",
        );
      }
      assert.equal(
        JSON.stringify(gateway.Config).includes(setup.files["AGENTS.md"]),
        false,
        "initial documents must not leak into container configuration",
      );
      assert.equal(
        await containerCount([
          [LABEL_NAMESPACE, namespace.id],
          [LABEL_ROLE, "workspace-setup"],
        ]),
        0,
        "private initializer container must be removed",
      );
      // A genuine filesystem edit stands in for a later workspace owner; this does not
      // claim native gateway RPC or HTTP authorization proof.
      await docker([
        "exec",
        gateway.Id,
        "node",
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(workspace + "/AGENTS.md")},'later workspace edit\\n')`,
      ]);
      await driver.stopRevision(revision);
      const nextRevision = { ...revision, id: revision.id + "-next", revision: 2 };
      const completed = { ...setup, completed: true };
      delete completed.files;
      assert.equal(
        (await driver.prepareRevision(nextRevision, { workspaceSetup: completed })).ready,
        true,
      );
      [gateway] = await waitForContainers(filters, 1, "replacement gateway");
      assert.equal((await readFiles())["AGENTS.md"], "later workspace edit\n");
      assert.equal(
        (await driver.prepareRevision(nextRevision, { workspaceSetup: setup })).ready,
        true,
      );
      assert.equal(
        (await readFiles())["AGENTS.md"],
        "later workspace edit\n",
        "lost completion acknowledgement cannot replay initial contents",
      );
      await driver.stopRevision(nextRevision);
      await assert.rejects(
        driver.prepareRevision(nextRevision, {
          workspaceSetup: { ...completed, id: completed.id + "-wrong" },
        }),
        /Workspace initialization failed/,
      );
      assert.equal(
        await containerCount(filters),
        0,
        "a mismatched marker must block runtime start",
      );
      assert.equal(
        (await driver.prepareRevision(nextRevision, { workspaceSetup: completed })).ready,
        true,
      );
      [gateway] = await waitForContainers(filters, 1, "gateway for direct restart");
      await docker([
        "exec",
        gateway.Id,
        "node",
        "-e",
        `require('node:fs').unlinkSync(${JSON.stringify(workspace + "/.oce-workspace-setup.json")})`,
      ]);
      // Restart the already-created gateway to exercise its command guard, not Compute reconciliation.
      await docker(["restart", gateway.Id]);
      await waitFor("restart to fail closed after marker loss", async () => {
        const [current] = await dockerJson(["inspect", gateway.Id]);
        return current.State.Running === false && current.State.ExitCode !== 0;
      });
      if (setupMode === "dedicated") {
        const [harness] = await waitForContainers(
          [
            [LABEL_NAMESPACE, namespace.id],
            [LABEL_AGENT, agentId],
            [LABEL_ROLE, "agent"],
          ],
          1,
          "Harness for direct restart",
        );
        await docker(["restart", harness.Id]);
        await waitFor("Harness restart to fail closed after marker loss", async () => {
          const [current] = await dockerJson(["inspect", harness.Id]);
          return current.State.Running === false && current.State.ExitCode !== 0;
        });
      }
      await driver.stopRevision(nextRevision);
      await driver.deleteAgentRuntimeCredentials(binding);
      await assert.rejects(
        driver.prepareRevision(nextRevision, { workspaceSetup: completed }),
        /storage is missing/,
      );
    },
  );
}
