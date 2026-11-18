import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import {
  observeEmbeddedGateway,
  terminatedEmbeddedGateway,
} from "../../apps/controller/src/drivers/compute/docker/embedded-gateway-recovery.ts";
import {
  dockerGatewayRevision,
  fakeDockerEngine,
  installDockerFixture,
  prepareDockerRevision,
  readRecord,
  stringArray,
  tenant,
  withModelKey,
  type DockerRequest,
} from "./docker-compute-fixture.ts";

export function registerEmbeddedRecoveryCases() {
  test("embedded recovery requires the observed container incarnation and its original state mounts", async () => {
    const { live, stopped, volume, namespace, engine } = embeddedRecoveryInspection();
    const observed = await observeEmbeddedGateway(engine, live, volume.Name);
    assert.ok(observed);
    assert.deepEqual(
      await terminatedEmbeddedGateway(engine, observed, stopped, volume.Name),
      namespace,
    );
    for (const candidate of [
      live,
      { ...stopped, State: { ...stopped.State, StartedAt: "2026-10-20T12:08:00Z" } },
      { ...stopped, Id: "c".repeat(64) },
    ]) {
      assert.equal(
        await terminatedEmbeddedGateway(engine, observed, candidate, volume.Name),
        undefined,
      );
    }
    volume.CreatedAt = "2026-10-20T12:10:00Z";
    assert.equal(
      await terminatedEmbeddedGateway(engine, observed, stopped, volume.Name),
      undefined,
    );
    for (const candidate of [
      { ...live, HostConfig: { ...live.HostConfig, PidMode: "host" } },
      { ...live, HostConfig: { ...live.HostConfig, SecurityOpt: [] } },
      {
        ...live,
        Mounts: [
          ...live.Mounts,
          { Type: "bind", Destination: "/home/node/.openclaw/state/openclaw.sqlite" },
        ],
      },
      { ...live, HostConfig: { ...live.HostConfig, Tmpfs: { "/usr/local": "" } } },
    ]) {
      assert.equal(await observeEmbeddedGateway(assert.fail, candidate, volume.Name), undefined);
    }
  });

  test("Docker dispatches embedded recovery only while Engine can verify the old state volume", async () => {
    await withModelKey(async () => {
      for (const unavailable of [undefined, "at removal", "at replacement"]) {
        let previous:
          (ReturnType<typeof embeddedRecoveryInspection> & { name: string }) | undefined;
        const {
          containers,
          createDriver,
          request: lifecycle,
        } = fakeDockerEngine((name, created) => {
          if (previous) {
            return created;
          }
          const mounts: unknown = readRecord(created.Config.HostConfig).Mounts;
          assert.ok(Array.isArray(mounts));
          const entries: readonly unknown[] = mounts;
          const state = entries
            .map(readRecord)
            .find(({ Target }) => Target === "/home/node/.openclaw");
          assert.ok(state && typeof state.Source === "string");
          previous = { name, ...embeddedRecoveryInspection(state.Source) };
          previous.live.Config.Labels = created.Config.Labels;
          assert.ok(created.State.Health);
          previous.live.State.Health = created.State.Health;
          return previous.live;
        });
        const driver = createDriver();
        const revision = dockerGatewayRevision(driver);
        const workspaceSetup = {
          id: "existing",
          namespaceId: tenant.id,
          agentId: revision.agentId,
          completed: true,
        };
        // The workspace already exists. Exercise normal Gateway creation, observation and replacement.

        let removed = false;
        installDockerFixture(driver, {
          initializeWorkspace: async () => true,
          request: async (method, path, data, expected, timeoutMs) => {
            if (previous) {
              const { name, live, volume, engine } = previous;
              if (method === "POST" && path.startsWith("/containers/" + live.Id + "/stop?")) {
                // The old Gateway has already exited (304 from Engine).
                return "";
              }
              if (method === "DELETE" && path.startsWith("/containers/" + live.Id + "?")) {
                removed = containers.delete(name);
                return "";
              }
              if (
                method === "GET" &&
                path === "/volumes/" + volume.Name &&
                !live.State.Running &&
                unavailable === (removed ? "at replacement" : "at removal")
              ) {
                throw new Error("Docker volume inspection failed");
              }
              if (
                path.includes(live.Id) ||
                path.startsWith("/exec/") ||
                path.startsWith("/volumes/")
              ) {
                return engine(method, path, data, expected);
              }
            }
            return lifecycle(method, path, data, expected, timeoutMs);
          },
        });
        assert.equal(
          (await prepareDockerRevision(driver, revision, { workspaceSetup })).ready,
          true,
        );
        assert.ok(previous);
        previous.live.State = previous.stopped.State;
        const successor = { ...revision, revision: 2, id: revision.id + "-replacement" };
        assert.equal(
          (await prepareDockerRevision(driver, successor, { workspaceSetup })).ready,
          true,
        );
        assert.equal(
          removed,
          true,
          "an unavailable recovery proof must not prevent normal removal",
        );
        const command = stringArray(readRecord(containers.get(previous.name)?.Config).Cmd);
        const program = inflateRawSync(Buffer.from(command.slice(2).join(""), "base64")).toString(
          "utf8",
        );
        assert.equal(program.includes("--terminated-namespace"), unavailable === undefined);
        if (unavailable === undefined) {
          assert.ok(
            program.includes(JSON.stringify(previous.namespace)),
            "the preamble carries this exact owner",
          );
        }
      }
    });
  });
}

function embeddedRecoveryInspection(volumeName = "agent-state") {
  const state: {
    Status: string;
    Running: boolean;
    Pid: number;
    StartedAt: string;
    Health?: { Status: string };
    FinishedAt?: string;
  } = { Status: "running", Running: true, Pid: 42, StartedAt: "2026-10-20T12:05:00Z" };
  const config: { User: string; Env: string[]; Labels?: Record<string, string> } = {
    User: "1000:1000",
    Env: ["NODE_OPTIONS=--require=/tmp/untrusted", "PATH=/tmp"],
  };
  const live = {
    Id: "a".repeat(64),
    State: state,
    Config: config,
    HostConfig: {
      PidMode: "",
      Privileged: false,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      Tmpfs: { "/home/node": "", "/tmp": "" },
    },
    Mounts: [{ Type: "volume", Name: volumeName, Destination: "/home/node/.openclaw", RW: true }],
  };
  const volume = {
    Name: volumeName,
    Driver: "local",
    Scope: "local",
    CreatedAt: "2026-10-20T12:00:00Z",
  };
  const namespace = {
    platform: "linux",
    identity: "d64275ef-a30a-4a02-917d-adb75653f494",
    host: "old-gateway",
    pidNsInode: "4026533123",
    pidNsInitStartTicks: 12345,
  };
  const execId = "b".repeat(64);
  const engine: DockerRequest = async (method, path, body) => {
    if (method === "GET" && path === "/volumes/" + volumeName) {
      return volume;
    }
    if (method === "POST" && path.endsWith("/exec")) {
      const request = readRecord(body);
      assert.equal(request.User, "65534:65534");
      assert.deepEqual(request.Env, ["NODE_OPTIONS=", "PATH="]);
      return { Id: execId };
    }
    if (method === "POST" && path === "/exec/" + execId + "/start") {
      return JSON.stringify(namespace);
    }
    if (method === "GET" && path === "/exec/" + execId + "/json") {
      return { Running: false, ExitCode: 0, ContainerID: live.Id };
    }
    assert.equal(path, "/containers/" + live.Id + "/json");
    return live;
  };
  const stopped = {
    ...live,
    State: {
      ...live.State,
      Status: "exited",
      Running: false,
      Pid: 0,
      FinishedAt: "2026-10-20T12:10:00Z",
    },
  };
  return { live, stopped, volume, namespace, engine };
}
