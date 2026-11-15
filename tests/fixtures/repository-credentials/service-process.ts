import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { Stats } from "node:fs";
import { lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { ControlRequest } from "../../../apps/controller/src/drivers/repo/access/control-contracts.ts";
import type { RepositoryCredentialBoundSessionInput } from "../../../apps/controller/src/drivers/repo/access/service-contracts.ts";
import { within } from "../../helpers/wait-for.mjs";
import { appModule, appRoot } from "./runtime.mjs";
import { createControlledClock } from "./clock.mjs";
import { cleanEnvironment, createTlsMaterial } from "./process.mjs";
import { createResourceScope } from "./resources.mjs";
import { createServiceConfiguration } from "./service.mjs";
import { startGitHubFixture, fixtureRepository, fixtureRepositoryId } from "./github.mjs";
import { createRegistryMaterial, type FixtureOwner } from "./registry/material.ts";
import type { GitHubFixture } from "./registry/provider.ts";
import type { ServiceProcessRequest, ServiceProcessGeneration } from "./service-process-child.ts";

type ExitReceipt = {
  code: number | null;
  signal: NodeJS.Signals | null;
  pid: number | undefined;
};
type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};
type StartInput = Extract<ServiceProcessRequest, { command: "start" }>["input"];

function launchService(resources: FixtureOwner) {
  const child = fork(new URL("./service-process-child.ts", import.meta.url), [], {
    env: cleanEnvironment({ REPOSITORY_CREDENTIALS_APP_ROOT: appRoot }),
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const pending = new Map<number, PendingRequest>();
  const maximumOutputBytes = 65_536;
  let sequence = 0;
  let outputBytes = 0;
  let stderr = "";
  let failure: Error | undefined;
  let receipt: ExitReceipt | undefined;
  const closed = new Promise<ExitReceipt>((resolve) => {
    child.once("error", () => {
      failure = new Error("service fixture spawn failed");
    });
    child.once("close", (code, signal) => {
      receipt = { code, signal, pid: child.pid };
      for (const { reject } of pending.values()) {
        reject(new Error("service fixture exited before replying"));
      }
      pending.clear();
      resolve(receipt);
    });
  });
  const stop = async () => {
    if (!receipt) {
      assert.equal(child.kill("SIGKILL"), true, "owned service termination must be sent");
    }
    const result = await within(closed, "service fixture death was not joined", 5_000);
    if (failure) {
      throw failure;
    }
    assert.equal(result.code, null, "the fixture must observe abrupt process death");
    assert.equal(result.signal, "SIGKILL");
    return result;
  };
  resources.after(async () => {
    if (!receipt) {
      await stop();
    }
  });
  const collect = (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > maximumOutputBytes) {
      failure = new Error("service fixture output overflow");
      child.kill("SIGKILL");
      return false;
    }
    return true;
  };
  child.stdout!.on("data", collect);
  child.stderr!.on("data", (chunk: Buffer) => {
    if (collect(chunk)) {
      stderr += chunk;
    }
  });
  child.on("message", (reply: unknown) => {
    if (!reply || typeof reply !== "object" || !("id" in reply) || typeof reply.id !== "number") {
      return;
    }
    const request = pending.get(reply.id);
    if (request) {
      pending.delete(reply.id);
      if ("result" in reply && !("error" in reply)) {
        request.resolve(reply.result);
      } else {
        request.reject(new Error("service fixture command failed"));
      }
    }
  });
  async function start(input: StartInput): Promise<ServiceProcessGeneration> {
    const id = ++sequence;
    const request: ServiceProcessRequest = { id, command: "start", input };
    const response = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.send(request, (error) => {
        if (error) {
          pending.delete(id);
          reject(new Error("service fixture IPC failed"));
        }
      });
    });
    let result: unknown;
    try {
      result = await within(response, "service fixture command got no answer", 5_000);
    } finally {
      pending.delete(id);
    }
    if (
      !result ||
      typeof result !== "object" ||
      !("pid" in result) ||
      typeof result.pid !== "number" ||
      result.pid !== child.pid ||
      !("port" in result) ||
      typeof result.port !== "number" ||
      !Number.isInteger(result.port) ||
      result.port < 1 ||
      result.port > 65_535
    ) {
      throw new Error("service fixture returned an invalid generation");
    }
    return { pid: result.pid, port: result.port };
  }

  return {
    start,
    stop,
    stderr: () => stderr,
    async stopGracefully() {
      if (!receipt) {
        assert.equal(child.kill("SIGTERM"), true, "owned service termination must be sent");
      }
      return within(closed, "service fixture graceful shutdown was not joined", 15_000);
    },
  };
}

type ServiceProcessOptions = {
  shutdownGraceMs?: number;
  namespaceId?: string;
  sessions?: number;
};

export async function startServiceProcessFixture(
  t: FixtureOwner,
  { shutdownGraceMs, namespaceId = "namespace-fixture", sessions = 1 }: ServiceProcessOptions = {},
) {
  const resources = createResourceScope();
  const ownedDirectories: string[] = [];
  t.after(async () => {
    await resources.close();
    for (const directory of ownedDirectories) {
      await assert.rejects(lstat(directory), { code: "ENOENT" });
    }
  });
  const clock = createControlledClock(1_800_000_000_000);
  const tls = await createTlsMaterial(resources);
  ownedDirectories.push(dirname(tls.keyFile));
  const base = await createServiceConfiguration(resources, {
    sessions,
    ...(shutdownGraceMs === undefined ? {} : { shutdownGraceMs }),
  });
  ownedDirectories.push(dirname(base.gateway.controlSocket));
  const config: StartInput["config"] = {
    ...base,
    gateway: { ...base.gateway, listen: "127.0.0.1:0" },
  };
  const registryMaterial = await createRegistryMaterial(resources, {
    definitions: [
      { repositoryRef: "repo-a", repository: fixtureRepository, repositoryId: fixtureRepositoryId },
    ],
    namespaceId,
    backendId: "github-fixture",
    maximumDurationSeconds: 172800,
  });
  ownedDirectories.push(registryMaterial.directory);
  const githubOptions = { clock, tls };
  const github: GitHubFixture = await startGitHubFixture(resources, githubOptions);
  const [{ callControl }, { loadGitHubRepositoryRegistry }, { resolveGitHubRepositoryBinding }]: [
    typeof import("../../../apps/controller/src/drivers/repo/github/access/client/operator.ts"),
    typeof import("../../../apps/controller/src/composition/repository-credentials/registry.ts"),
    typeof import("../../../apps/controller/src/drivers/repo/github/access/registry.ts"),
  ] = await Promise.all([
    appModule("drivers/repo/github/access/client/operator"),
    appModule("composition/repository-credentials/registry"),
    appModule("drivers/repo/github/access/registry"),
  ]);
  const registry = await loadGitHubRepositoryRegistry(
    registryMaterial.registryFile,
    "github-fixture",
  );
  const binding = resolveGitHubRepositoryBinding(registry, {
    namespaceId,
    repositoryRef: "repo-a",
    profile: "git-write",
  });
  const input: RepositoryCredentialBoundSessionInput = {
    durationSeconds: 86400,
    profile: binding.profile,
    namespaceId,
    repositoryRef: binding.repositoryRef,
    expectedBinding: binding.grant,
    deadlineWallMs: clock.wallNow() + 86400000,
  };
  let processOwner: ReturnType<typeof launchService> | undefined;
  let generation: ServiceProcessGeneration;
  let socketIdentity: Stats;

  async function start() {
    assert.equal(processOwner, undefined, "join the previous service before replacement");
    const owner = launchService(resources);
    processOwner = owner;
    generation = await owner.start({
      config,
      tls,
      origin: github.origin,
      wallMs: clock.wallNow(),
      registryFile: registryMaterial.registryFile,
      socketPath: join(dirname(config.gateway.controlSocket), "prepared-git-use.sock"),
    });
    socketIdentity = await lstat(config.gateway.controlSocket);
    return generation;
  }
  async function kill() {
    assert.ok(processOwner, "the fixture must own a running service");
    const death = await processOwner.stop();
    assert.equal(death.code, null);
    assert.equal(death.signal, "SIGKILL");
    assert.equal(death.pid, generation.pid);
    processOwner = undefined;
    // This source refuses a stale socket. Fixture ownership permits removing only
    // this inode after death; this is not product restart or recovery behavior.
    const stale = await lstat(config.gateway.controlSocket);
    assert.equal(stale.isSocket(), true);
    assert.equal(stale.dev, socketIdentity.dev);
    assert.equal(stale.ino, socketIdentity.ino);
    await unlink(config.gateway.controlSocket);
    return death;
  }
  async function shutdown(expectedCode = 0) {
    assert.ok(processOwner, "the fixture must own a running service");
    const result = await processOwner.stopGracefully();
    assert.equal(
      result.code,
      expectedCode,
      "the fixture must observe the expected shutdown outcome",
    );
    assert.equal(result.signal, null);
    assert.equal(result.pid, generation.pid);
    processOwner = undefined;
    return result;
  }
  const admissionId = () => `${clock.wallNow()}-${randomUUID()}`;
  const control = (request: ControlRequest, id = admissionId()) =>
    callControl(config.gateway.controlSocket, request, id);
  await start();
  return {
    github,
    clock,
    config,
    input,
    start,
    kill,
    shutdown,
    generation: () => generation,
    tls,
    // The running process's log lines (each JSON line is one event), for log assertions.
    stderr() {
      assert.ok(processOwner, "the fixture must own a running service");
      return processOwner.stderr();
    },
    admissionId,
    open: (id: string, recoverOnly = false, durableAdmission = false) =>
      control(
        {
          method: "POST",
          path: "/v1/sessions",
          body: {
            ...input,
            ...(recoverOnly ? { recoverOnly: true } : {}),
            ...(durableAdmission ? { durableAdmission: true, preparedOnly: true } : {}),
          },
        },
        id,
      ),
    status: (id: string) => control({ method: "GET", path: `/v1/sessions/${id}` }),
    close: (id: string) => control({ method: "POST", path: `/v1/sessions/${id}/close` }),
  };
}
