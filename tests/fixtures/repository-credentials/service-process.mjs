import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { lstat, unlink } from "node:fs/promises";
import { request } from "node:https";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { appModule, appRoot } from "./runtime.mjs";
import { createControlledClock } from "./clock.mjs";
import { cleanEnvironment, createTlsMaterial } from "./process.mjs";
import { createResourceScope } from "./resources.mjs";
import { createServiceConfiguration } from "./service.mjs";
import {
  startGitHubFixture,
  fixtureInstallationId,
  fixtureRepository,
  fixtureRepositoryId,
} from "./github.mjs";
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
  child.stderr.on("data", collect);
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
  {
    holdIssuance = false,
    revokeStatus = 204,
    bound = false,
    shutdownGraceMs,
    namespaceId = "namespace-fixture",
    sessions = 1,
  } = {},
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
  let accepted;
  const issuanceAccepted = new Promise((resolve) => {
    accepted = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const registryMaterial = bound
    ? await createRegistryMaterial(resources, {
        definitions: [
          {
            repositoryRef: "repo-a",
            repository: fixtureRepository,
            repositoryId: fixtureRepositoryId,
          },
        ],
        namespaceId,
        backendId: "github-fixture",
        maximumDurationSeconds: 172800,
      })
    : undefined;
  if (registryMaterial) {
    ownedDirectories.push(registryMaterial.directory);
  }
  const github = await startGitHubFixture(resources, {
    clock,
    tls,
    keyPair: registryMaterial?.keyPair,
    revokeStatus,
    beforeIssueResponse: () => accepted(),
    issueResponseGate: holdIssuance ? () => gate : undefined,
  });
  resources.after(release);
  const { callControl } = await appModule("drivers/repo/github/credentials/client/operator");
  let input = { durationSeconds: 86400, profile: "git-full" };
  if (registryMaterial) {
    const { loadGitHubRepositoryRegistry } = await appModule(
      "composition/repository-credentials/registry",
    );
    const { resolveGitHubRepositoryBinding } = await appModule(
      "drivers/repo/github/credentials/registry",
    );
    const registry = await loadGitHubRepositoryRegistry(
      registryMaterial.registryFile,
      "github-fixture",
    );
    const binding = resolveGitHubRepositoryBinding(registry, {
      namespaceId,
      repositoryRef: "repo-a",
      profile: "git-full",
    });
    input = {
      ...input,
      namespaceId,
      repositoryRef: binding.repositoryRef,
      expectedBinding: binding.grant,
      deadlineWallMs: clock.wallNow() + 86400000,
    };
  }
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
      privateKey: github.privateKey.export({ type: "pkcs8", format: "pem" }),
      wallMs: clock.wallNow(),
      ...(registryMaterial
        ? {
            registryFile: registryMaterial.registryFile,
            privateKeyFile: registryMaterial.privateKeyFile,
          }
        : {}),
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
    admissionId,
    open: (id, recoverOnly = false, durableAdmission = false) =>
      control(
        "POST",
        "/v1/sessions",
        {
          ...input,
          ...(recoverOnly ? { recoverOnly } : {}),
          ...(durableAdmission ? { durableAdmission } : {}),
        },
        id,
      ),
    status: (id) => control("GET", `/v1/sessions/${id}`),
    close: (id) => control("POST", `/v1/sessions/${id}/close`),
    waitForIssuance: () => within(issuanceAccepted, "provider issuance gate was not reached"),
    loseIssuanceResponse() {
      github.disconnectAfterMutation(
        "POST",
        `/app/installations/${fixtureInstallationId}/access_tokens`,
      );
      release();
    },
    async advance(milliseconds, wallDelta = milliseconds) {
      await clock.advance(milliseconds, wallDelta);
      const result = await processOwner.call("advance", { milliseconds, wallDelta });
      assert.equal(result.wallMs, clock.wallNow());
    },
    request(opened) {
      return new Promise((resolve, reject) => {
        const outgoing = request(
          {
            hostname: "127.0.0.1",
            port: generation.port,
            path: "/repos/fixture/repository",
            ca: tls.ca,
            agent: false,
            headers: {
              host: "credentials.example.test",
              authorization: `Bearer ${opened.bearer}`,
            },
          },
          (incoming) => {
            const chunks = [];
            incoming.on("data", (chunk) => chunks.push(chunk));
            incoming.once("error", reject);
            incoming.once("end", () =>
              resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString() }),
            );
          },
        );
        const timer = setTimeout(
          () => outgoing.destroy(new Error("service fixture request timed out")),
          5000,
        );
        outgoing.once("close", () => clearTimeout(timer));
        outgoing.once("error", reject);
        outgoing.end();
      });
    },
  };
}
