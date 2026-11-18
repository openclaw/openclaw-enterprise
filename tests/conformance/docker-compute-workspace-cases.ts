import assert from "node:assert/strict";
import test from "node:test";
import {
  admitLoggingConfiguration,
  type OpenClawConfigurationDocument,
  type WorkspaceSetup,
} from "../../packages/contracts/src/index.ts";
import { ConfigurationHarnessError } from "../../packages/occ/src/index.ts";
import { createTestKubernetesComputeDriver } from "../helpers/kubernetes-compute.mjs";
import { withEnvironment } from "../helpers/environment.ts";
import {
  dockerAgentRevision,
  dockerDriver,
  installDockerFixture,
  namespaceLabels,
  parseJson,
  prepareDockerRevision,
  readContainerCreate,
  readRecord,
  stopDockerRevision,
  stringArray,
  tenant,
  type CreatedContainer,
  type ContainerCreate,
} from "./docker-compute-fixture.ts";

export function registerWorkspaceCases() {
  // These checks exercise the real Driver at Docker's API boundary. Container exit
  // status is an external observation; native file writes are covered separately by
  // the shared initializer and selected real-runtime Agent journey.
  for (const mode of ["embedded", "dedicated"] as const) {
    test(`Docker ${mode} workspace setup blocks execution, delivers privately, and retains Agent storage`, async () => {
      const driver = dockerDriver();
      const revision = {
        ...dockerAgentRevision(driver, {
          id: `revision-workspace-${mode}`,
          agentId: `agent-workspace-${mode}`,
          mode,
        }),
        configurationId: "cfg-workspace",
        configuration: admitLoggingConfiguration(
          mode === "dedicated"
            ? { agents: { entries: { main: { workspace: "/home/node/workspace" } } } }
            : {},
          "info",
        ),
        servicePrincipalId: "sp-workspace",
      };
      const completed: WorkspaceSetup = {
        id: "setup-private",
        namespaceId: tenant.id,
        agentId: revision.agentId,
        completed: true,
      };
      const setup = {
        ...completed,
        completed: false,
        files: { "AGENTS.md": "private-initial-instructions\n", "USER.md": "" },
      } satisfies WorkspaceSetup;
      const volumes = new Map<string, Record<string, unknown>>();
      const containers = new Map<string, CreatedContainer>();
      const creations: ContainerCreate[] = [];
      const deliveries: unknown[] = [];
      let initializerExit = 1;
      let setupFinished = false;
      let runtimeStarts = 0;
      // A lost setup start response (Docker started setup, the Driver sees a request timeout),
      // then a failed inspect of that setup container.
      let loseSetupStart = false;
      let failSetupInspect = false;
      const requestTimeout = () =>
        new DOMException("The operation was aborted due to timeout", "TimeoutError");
      const isSetup = (container: CreatedContainer | undefined) =>
        container?.Config.Labels["org.openclaw.enterprise.role"] === "workspace-setup";
      installDockerFixture(driver, {
        request: async (method, path, body) => {
          const url = new URL(path, "http://docker.invalid");
          if (method === "GET" && url.pathname.startsWith("/networks/")) {
            return { Labels: namespaceLabels };
          }
          if (method === "POST" && url.pathname === "/volumes/create") {
            const volume = readRecord(structuredClone(body));
            assert.ok(typeof volume.Name === "string");
            volumes.set(volume.Name, volume);
            return body;
          }
          if (url.pathname.startsWith("/volumes/")) {
            const name = decodeURIComponent(url.pathname.slice("/volumes/".length));
            if (method === "GET") {
              return volumes.get(name);
            }
            if (method === "DELETE") {
              volumes.delete(name);
              return "";
            }
          }
          if (method === "GET" && url.pathname === "/volumes") {
            const filter = url.searchParams.get("filters");
            assert.ok(filter);
            const labels = stringArray(readRecord(parseJson(filter)).label);
            return {
              Volumes: [...volumes.values()].filter((volume) =>
                labels.every((label) => {
                  const separator = label.indexOf("=");
                  return (
                    readRecord(volume.Labels)[label.slice(0, separator)] ===
                    label.slice(separator + 1)
                  );
                }),
              ),
            };
          }
          if (method === "POST" && url.pathname === "/containers/create") {
            const name = url.searchParams.get("name");
            assert.ok(name);
            const creation = readContainerCreate(body);
            creations.push(structuredClone(creation));
            containers.set(name, { Config: creation, State: { Running: false, ExitCode: 0 } });
            return {};
          }
          const [, encodedName, action] =
            /^\/containers\/([^/]+)(?:\/(\w+))?$/.exec(url.pathname) ?? [];
          const name = decodeURIComponent(encodedName ?? "");
          if (method === "GET" && action === "json") {
            if (failSetupInspect && isSetup(containers.get(name))) {
              failSetupInspect = false;
              throw requestTimeout();
            }
            return containers.get(name);
          }
          if (method === "PUT" && action === "archive") {
            assert.ok(Buffer.isBuffer(body));
            assert.equal(url.searchParams.get("path"), "/run");
            const length = Number.parseInt(
              body.subarray(124, 136).toString().replace(/\0.*$/, ""),
              8,
            );
            deliveries.push(parseJson(body.subarray(512, 512 + length).toString()));
            assert.equal(body.subarray(100, 108).toString(), "0000600\0");
            return "";
          }
          if (method === "POST" && action === "start") {
            const container = containers.get(name);
            assert.ok(container);
            if (isSetup(container)) {
              assert.equal(deliveries.length > 0, true);
              if (loseSetupStart) {
                loseSetupStart = false;
                failSetupInspect = true;
                container.State = { Running: true };
                throw requestTimeout();
              }
              container.State = { Running: false, ExitCode: initializerExit };
              setupFinished = initializerExit === 0;
            } else {
              assert.equal(
                setupFinished,
                true,
                "no runtime process can start before setup succeeds",
              );
              runtimeStarts += 1;
              container.State = { Running: true, Health: { Status: "healthy" } };
            }
            return "";
          }
          if (method === "POST" && action === "stop") {
            const container = containers.get(name);
            if (container !== undefined) {
              container.State = { Running: false, ExitCode: 0 };
            }
            return "";
          }
          if (method === "DELETE" && encodedName !== undefined) {
            containers.delete(name);
            return "";
          }
          throw new Error(`Unexpected Docker API request ${method} ${path}`);
        },
      });
      await withEnvironment({ OPENAI_API_KEY: "fixture-model-key" }, async () => {
        for (const agents of [
          null,
          "invalid",
          { list: [] },
          { entries: null },
          { entries: [] },
          { entries: {} },
          { entries: { main: null } },
          { entries: { other: {} } },
          { entries: { main: {}, other: {} } },
        ]) {
          await assert.rejects(
            prepareDockerRevision(
              driver,
              { ...revision, configuration: { ...revision.configuration, agents } },
              { workspaceSetup: setup },
            ),
            /Configuration setting agents\.entries must hold only main, or be omitted, for initial workspace files/,
          );
          assert.equal(volumes.size, 0, "invalid roster must not create storage");
          assert.equal(creations.length, 0, "invalid roster must not create containers");
          assert.equal(deliveries.length, 0, "invalid roster must not deliver private content");
        }
        await assert.rejects(
          prepareDockerRevision(driver, revision, { workspaceSetup: setup }),
          /Workspace initialization failed/,
        );
        assert.equal(runtimeStarts, 0);
        assert.equal(containers.size, 0, "failed initializer and private payload must be removed");
        assert.equal(volumes.size, 2, "retry retains exact-Agent durable storage");

        // The start response is lost after Docker started setup, and the inspect that would
        // tell a running setup from a stopped one fails too. The attempt fails, but the Driver
        // must leave the setup: removal would SIGKILL a setup that may hold OpenClaw's state
        // lock (finding 3115).
        loseSetupStart = true;
        await assert.rejects(prepareDockerRevision(driver, revision, { workspaceSetup: setup }), {
          name: "TimeoutError",
        });
        assert.equal(
          failSetupInspect,
          false,
          "the Driver inspected the setup after the failed start",
        );
        const leftSetup = [...containers.values()].find(isSetup);
        assert.equal(
          leftSetup?.State.Running,
          true,
          "a setup that may run is not stopped or removed",
        );
        // The next attempt inspects it again: while it runs, the attempt is unready and leaves it.
        assert.equal(
          (await prepareDockerRevision(driver, revision, { workspaceSetup: setup })).ready,
          false,
        );
        assert.equal([...containers.values()].find(isSetup), leftSetup);
        assert.ok(leftSetup);
        assert.equal(leftSetup.State.Running, true);
        assert.equal(runtimeStarts, 0, "no runtime starts while setup may run");
        // The setup ends on its own; the attempt below removes it and proceeds normally.
        leftSetup.State = { Running: false, ExitCode: 0 };
        initializerExit = 0;
        assert.equal(
          (await prepareDockerRevision(driver, revision, { workspaceSetup: setup })).ready,
          true,
        );
        assert.deepEqual(
          deliveries.at(-1),
          setup,
          "empty and nonempty values survive archive delivery",
        );
        assert.equal(JSON.stringify(creations).includes(setup.files["AGENTS.md"]), false);
        const initializer = creations.find(
          (entry) => entry.Labels["org.openclaw.enterprise.role"] === "workspace-setup",
        );
        assert.ok(initializer);
        const host = readRecord(initializer.HostConfig);
        assert.equal(host.NetworkMode, "none");
        assert.equal(readRecord(host.LogConfig).Type, "none");
        const mounts: unknown = host.Mounts;
        assert.ok(Array.isArray(mounts));
        const mounted: readonly unknown[] = mounts;
        const source = (target: string) => {
          const mount = mounted.map(readRecord).find(({ Target }) => Target === target);
          assert.ok(mount, `expected a workspace mount at ${target}`);
          return mount.Source;
        };
        assert.equal(
          source("/home/node/.openclaw/workspace"),
          source("/home/node/workspace"),
          "native workspace and Harness cwd must refer to the same durable files",
        );
        assert.notEqual(source("/home/node/.openclaw"), source("/home/node/workspace"));

        for (const container of containers.values()) {
          assert.deepEqual(readRecord(container.Config.HostConfig).Mounts, mounts);
        }
        await stopDockerRevision(driver, revision);
        assert.equal(containers.size, 0);
        assert.equal(volumes.size, 2, "stop preserves setup state and user edits");
        assert.equal(
          (
            await prepareDockerRevision(
              driver,
              { ...revision, id: revision.id + "-next", revision: 2 },
              { workspaceSetup: completed },
            )
          ).ready,
          true,
        );
        assert.deepEqual(
          deliveries.at(-1),
          completed,
          "recreation verifies metadata without sending original contents",
        );
        for (const container of containers.values()) {
          assert.deepEqual(readRecord(container.Config.HostConfig).Mounts, mounts);
        }
        await stopDockerRevision(driver, { ...revision, id: revision.id + "-next", revision: 2 });
        volumes.set("unrelated", {
          Name: "unrelated",
          Labels: {
            ...namespaceLabels,
            "org.openclaw.enterprise.agent-id": "another-agent",
            "org.openclaw.enterprise.role": "workspace",
          },
        });
        await driver.deleteAgentRuntimeCredentials({
          namespace: tenant,
          agent: {
            id: revision.agentId,
            namespaceId: tenant.id,
            name: "Docker workspace Agent",
            desiredRuntimeState: "stopped",
            status: "deleting",
            configurationId: revision.configurationId,
            backendId: revision.backendId,
            executionMode: mode,
            gatewayManagedMode: revision.gatewayManagedMode,
            harnessAuth: null,
            servicePrincipalId: revision.servicePrincipalId,
            createdAt: revision.createdAt,
          },
        });
        assert.deepEqual([...volumes.keys()], ["unrelated"]);
        await assert.rejects(
          prepareDockerRevision(driver, revision, { workspaceSetup: completed }),
          /storage is missing/,
        );
        await assert.rejects(
          prepareDockerRevision(driver, revision, {
            workspaceSetup: { ...setup, agentId: "another-agent" },
          }),
          /exact Agent/,
        );
        await assert.rejects(
          prepareDockerRevision(
            driver,
            {
              ...revision,
              configuration: admitLoggingConfiguration(
                { agents: { entries: { main: { workspace: "/outside" } } } },
                "info",
              ),
            },
            { workspaceSetup: setup },
          ),
          /Configuration setting agents\.entries\.main\.workspace must be \/home\/node\/\.openclaw\/workspace or \/home\/node\/workspace, or unset/,
        );
      });
    });
  }

  // Docker Compute applies the workspace setup rule Kubernetes Compute shares, so Agent save,
  // provisioning and preparation name the same setting with the same text on both Drivers.
  test("Docker workspace setup refusals match Kubernetes Compute's and name the setting at save", async () => {
    const docker = dockerDriver();
    const kubernetes = createTestKubernetesComputeDriver("docker-workspace-parity");
    const dedicated = { id: "codex", version: "1", mode: "dedicated" } as const;
    const refusal = (
      driver: Pick<typeof docker, "validateWorkspaceSetup">,
      harness: Parameters<typeof docker.validateWorkspaceSetup>[0],
      configuration: OpenClawConfigurationDocument,
    ) => {
      try {
        driver.validateWorkspaceSetup(harness, configuration);
      } catch (error) {
        assert.ok(error instanceof ConfigurationHarnessError, String(error));
        return error.message;
      }
      return undefined;
    };
    for (const agents of [
      { list: [] },
      { entries: { other: {} } },
      { entries: { main: {}, other: {} } },
      { entries: { main: { workspace: "/outside" } } },
      { defaults: { workspace: "/home/node/.openclaw/workspace/nested" } },
    ]) {
      const message = refusal(docker, dedicated, { agents });
      assert.match(message ?? "", /^Configuration setting agents\./, JSON.stringify(agents));
      assert.equal(message, refusal(kubernetes, dedicated, { agents }), JSON.stringify(agents));
    }
    for (const agents of [
      undefined,
      { entries: { main: {} } },
      { entries: { main: { workspace: "/home/node/workspace" } } },
      { defaults: { workspace: "/home/node/.openclaw/workspace" } },
    ]) {
      const configuration = agents === undefined ? {} : { agents };
      assert.equal(refusal(docker, dedicated, configuration), undefined, JSON.stringify(agents));
      assert.equal(refusal(kubernetes, dedicated, configuration), undefined);
    }
    // Docker mounts one volume at both paths on every topology, and writes the files after
    // native bootstrap, so it alone accepts the Harness path on embedded OpenClaw and refuses
    // skipped bootstrap; both are named settings too.
    const embedded = { id: "openclaw", version: "1", mode: "embedded" } as const;
    const harnessPath = { agents: { defaults: { workspace: "/home/node/workspace" } } };
    assert.equal(refusal(docker, embedded, harnessPath), undefined);
    assert.equal(
      refusal(kubernetes, embedded, harnessPath),
      "Configuration setting agents.defaults.workspace must be /home/node/.openclaw/workspace, or unset, for initial workspace files.",
    );
    const skippedBootstrap: [OpenClawConfigurationDocument, string][] = [
      [{ defaults: { skipBootstrap: true } }, "agents.defaults.skipBootstrap"],
      [
        { entries: { main: { skipOptionalBootstrapFiles: true } } },
        "agents.entries.main.skipOptionalBootstrapFiles",
      ],
    ];
    for (const [agents, setting] of skippedBootstrap) {
      assert.equal(
        refusal(docker, embedded, { agents }),
        `Configuration setting ${setting} must not be true for initial workspace files: Docker Compute writes them after native bootstrap.`,
      );
    }
  });
}
