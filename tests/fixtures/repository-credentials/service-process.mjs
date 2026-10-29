import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { appModule, appRoot } from "./runtime.mjs";
import { createControlledClock } from "./clock.mjs";
import { cleanEnvironment, createTlsMaterial } from "./process.mjs";
import { createResourceScope } from "./resources.mjs";
import { createServiceConfiguration } from "./service.mjs";
import { startGitHubFixture, fixtureRepository, fixtureRepositoryId } from "./github.mjs";
import { createRegistryMaterial } from "./registry/material.mjs";

async function within(promise, message, timeoutMs = 5000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function launchService(resources) {
  const child = fork(new URL("./service-process-child.mjs", import.meta.url), [], {
    env: cleanEnvironment({ REPOSITORY_CREDENTIALS_APP_ROOT: appRoot }),
    execArgv: [],
    serialization: "advanced",
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const pending = new Map();
  let sequence = 0;
  let outputBytes = 0;
  let stderr = "";
  let failure;
  let receipt;
  const closed = new Promise((resolve) => {
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
    const result = await within(closed, "service fixture death was not joined");
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
  const collect = (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes > 65536) {
      failure = new Error("service fixture output overflow");
      child.kill("SIGKILL");
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", (chunk) => {
    collect(chunk);
    stderr += chunk;
  });
  child.on("message", ({ id, result, error }) => {
    const request = pending.get(id);
    if (request) {
      pending.delete(id);
      if (error) {
        request.reject(new Error("service fixture command failed"));
      } else {
        request.resolve(result);
      }
    }
  });
  return {
    stop,
    stderr: () => stderr,
    async stopGracefully() {
      if (!receipt) {
        assert.equal(child.kill("SIGTERM"), true, "owned service termination must be sent");
      }
      return within(closed, "service fixture graceful shutdown was not joined", 15000);
    },
    async call(command, input) {
      const id = ++sequence;
      const response = new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.send({ id, command, input }, (error) => {
          if (error) {
            pending.delete(id);
            reject(new Error("service fixture IPC failed"));
          }
        });
      });
      try {
        return await within(response, "service fixture command timed out");
      } finally {
        pending.delete(id);
      }
    },
  };
}

export async function startServiceProcessFixture(
  t,
  { shutdownGraceMs, namespaceId = "namespace-fixture", sessions = 1 } = {},
) {
  const resources = createResourceScope();
  const ownedDirectories = [];
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
  const config = { ...base, gateway: { ...base.gateway, listen: "127.0.0.1:0" } };
  const registryMaterial = await createRegistryMaterial(resources, {
    definitions: [
      { repositoryRef: "repo-a", repository: fixtureRepository, repositoryId: fixtureRepositoryId },
    ],
    namespaceId,
    backendId: "github-fixture",
    maximumDurationSeconds: 172800,
  });
  ownedDirectories.push(registryMaterial.directory);
  const github = await startGitHubFixture(resources, {
    clock,
    tls,
  });
  const [{ callControl }, { loadGitHubRepositoryRegistry }, { resolveGitHubRepositoryBinding }] =
    await Promise.all([
      appModule("drivers/repo/github/credentials/client/operator"),
      appModule("composition/repository-credentials/registry"),
      appModule("drivers/repo/github/credentials/registry"),
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
  const input = {
    durationSeconds: 86400,
    profile: binding.profile,
    namespaceId,
    repositoryRef: binding.repositoryRef,
    expectedBinding: binding.grant,
    deadlineWallMs: clock.wallNow() + 86400000,
  };
  let processOwner;
  let generation;
  let socketIdentity;

  async function start() {
    assert.equal(processOwner, undefined, "join the previous service before replacement");
    processOwner = launchService(resources);
    generation = await processOwner.call("start", {
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
  const control = (method, path, body, id = admissionId()) =>
    callControl(
      config.gateway.controlSocket,
      { method, path, ...(body === undefined ? {} : { body }) },
      id,
    );
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
    stderr: () => processOwner.stderr(),
    admissionId,
    open: (id, recoverOnly = false, durableAdmission = false) =>
      control(
        "POST",
        "/v1/sessions",
        {
          ...input,
          ...(recoverOnly ? { recoverOnly } : {}),
          ...(durableAdmission ? { durableAdmission, preparedOnly: true } : {}),
        },
        id,
      ),
    status: (id) => control("GET", `/v1/sessions/${id}`),
    close: (id) => control("POST", `/v1/sessions/${id}/close`),
  };
}
