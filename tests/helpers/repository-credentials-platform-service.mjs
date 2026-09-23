import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { join } from "node:path";
import { createResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { createPlatformClock } from "../fixtures/repository-credentials/platform-clock.mjs";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";
import { serviceConfigurationData } from "../fixtures/repository-credentials/builders.mjs";
import { defaultRegistryRepositories } from "../fixtures/repository-credentials/registry.mjs";
import { createRegistryMaterial } from "../fixtures/repository-credentials/registry/material.mjs";
import { startRegistryProviderFixtures } from "../fixtures/repository-credentials/registry/provider.mjs";
import { appModule, credentialDriverModule } from "../fixtures/repository-credentials/runtime.mjs";

async function within(promise, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("credential child deadline exceeded")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function ownChild(resources, signal) {
  signal?.throwIfAborted();
  const child = fork(
    new URL("./repository-credentials-platform-service-child.mjs", import.meta.url),
    [],
    {
      execArgv: [],
      env: {
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        ...(process.env.REPOSITORY_CREDENTIALS_APP_ROOT
          ? { REPOSITORY_CREDENTIALS_APP_ROOT: process.env.REPOSITORY_CREDENTIALS_APP_ROOT }
          : {}),
      },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  let receipt;
  let pending;
  let expectedExit = false;
  const closed = Promise.withResolvers();
  const fail = () => pending?.reject(new Error("credential child unavailable"));
  child.once("error", fail);
  child.once("disconnect", fail);
  child.once("close", (code, signal) => {
    receipt = { pid: child.pid, code, signal };
    fail();
    closed.resolve(receipt);
  });
  child.on("message", (message) => {
    if (pending && message?.type === pending.type && message.offset === pending.offset) {
      pending.resolve(message);
    } else {
      fail();
    }
  });
  const abort = () => {
    expectedExit = true;
    child.kill("SIGKILL");
  };
  async function terminate(terminationSignal) {
    expectedExit = true;
    if (!receipt) {
      child.kill(terminationSignal);
    }
    try {
      return await within(closed.promise);
    } catch (error) {
      child.kill("SIGKILL");
      await within(closed.promise, 5_000);
      throw error;
    } finally {
      if (receipt) {
        signal?.removeEventListener("abort", abort);
      }
    }
  }
  async function stop() {
    if (receipt) {
      assert.equal(expectedExit, true, "credential child exited without an owned termination");
      return;
    }
    const result = await terminate("SIGTERM");
    assert.equal(result.code, 0, "credential child must finish graceful cleanup");
    assert.equal(result.signal, null);
  }
  // Register ownership before startup IPC or any asynchronous readiness work.
  resources.after(stop);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) {
    abort();
  }
  return {
    pid: child.pid,
    get alive() {
      return receipt === undefined;
    },
    stop,
    async kill() {
      assert.equal(receipt, undefined, "kill requires a live owned child");
      const result = await terminate("SIGKILL");
      assert.equal(result.code, null);
      assert.equal(result.signal, "SIGKILL");
      return result;
    },
    async command(message, type, offset) {
      assert.equal(pending, undefined, "credential lifecycle commands must be serialized");
      assert.equal(receipt, undefined, "credential child has exited");
      const reply = Promise.withResolvers();
      pending = { ...reply, type, offset };
      try {
        child.send(message, (error) => {
          if (error) {
            fail();
          }
        });
        return await within(reply.promise);
      } catch (error) {
        try {
          await terminate("SIGKILL");
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            "credential child command and cleanup failed",
            { cause: cleanup },
          );
        }
        throw error;
      } finally {
        pending = undefined;
      }
    },
  };
}

export async function startRepositoryPlatformService(context, options = {}) {
  const resources = createResourceScope({ cleanupTimeoutMs: 30_000 });
  try {
    assert.ok(options.gateway?.listen, "select a fixed credential gateway listener");
    const clock = createPlatformClock();
    const tls = options.tls ?? (await createTlsMaterial(resources));
    const namespaceId = options.namespaceId ?? "namespace-fixture";
    const providerId = "github-fixture";
    const maximumDurationSeconds = 172800;
    const definitions = defaultRegistryRepositories.map((entry) =>
      entry.repositoryRef === "repo-a"
        ? { ...entry, pushRefAllowlist: ["refs/heads/native-feature", "refs/heads/agent/*"] }
        : entry,
    );
    const material = await createRegistryMaterial(resources, {
      definitions,
      namespaceId,
      providerId,
      maximumDurationSeconds,
    });
    const [{ validateServiceConfig }, { UnixRepositoryCredentialControlClient }] =
      await Promise.all([
        credentialDriverModule("configuration"),
        appModule("providers/repository-credentials/control-client"),
      ]);
    const config = validateServiceConfig(
      serviceConfigurationData({
        gateway: {
          publicOrigin: "https://credentials.example.test",
          controlSocket: join(material.directory, "control.sock"),
          ...options.gateway,
        },
        sessionPolicy: { maximumDurationSeconds },
      }),
    );
    const providers = await startRegistryProviderFixtures(resources, {
      definitions,
      clock,
      tls,
      keyPair: material.keyPair,
    });
    const control = new UnixRepositoryCredentialControlClient({
      controlSocket: config.gateway.controlSocket,
    });
    let current;
    let generation = 0;
    let offset = 0;
    let busy = false;
    async function exclusive(action) {
      assert.equal(busy, false, "credential lifecycle operation already in progress");
      busy = true;
      try {
        options.signal?.throwIfAborted();
        return await action();
      } finally {
        busy = false;
      }
    }
    async function start() {
      assert.ok(!current?.alive, "join the previous service before replacement");
      current = ownChild(resources, options.signal);
      try {
        await current.command(
          {
            type: "start",
            input: {
              registryFile: material.registryFile,
              privateKeyFile: material.privateKeyFile,
              providerId,
              config,
              offset,
              keyFile: tls.keyFile,
              certFile: tls.certFile,
              apiOrigin: providers.apiOrigin,
              gitOrigin: providers.gitOrigin,
            },
          },
          "ready",
          offset,
        );
        await control.health(AbortSignal.timeout(5_000));
      } catch (error) {
        if (current.alive) {
          try {
            await current.kill();
          } catch (cleanup) {
            throw new AggregateError([error, cleanup], "credential startup and cleanup failed", {
              cause: cleanup,
            });
          }
        }
        throw error;
      }
      generation += 1;
    }
    await exclusive(start);
    context.after(() => resources.close());
    return {
      namespaceId,
      providerId,
      config,
      tls,
      registryFile: material.registryFile,
      repositories: providers.repositories,
      get process() {
        return { pid: current.pid, generation, alive: current.alive };
      },
      status: (sessionId) => control.status(sessionId, AbortSignal.timeout(5_000)),
      start: () => exclusive(start),
      kill: () => exclusive(() => current.kill()),
      restart: () =>
        exclusive(async () => {
          await current.stop();
          await start();
        }),
      clock: {
        wallNow: clock.wallNow,
        advance: (milliseconds) =>
          exclusive(async () => {
            assert.ok(Number.isSafeInteger(milliseconds) && milliseconds >= 0);
            const next = offset + milliseconds;
            assert.ok(Number.isSafeInteger(next));
            offset = next;
            await clock.advance(milliseconds);
            await current.command({ type: "advance", offset: next }, "advanced", next);
          }),
      },
      close: () => resources.close(),
    };
  } catch (error) {
    await resources.close(error);
  }
}
