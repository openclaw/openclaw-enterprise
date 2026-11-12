import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { runFixtureCommand } from "./production-rehearsal-custody.ts";

const executeFile = promisify(execFile);

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function lockHolder(lockPath) {
  // A lock file the creator has not written yet reads as 0: wait, never take it over.
  return Number((await readFile(lockPath, "utf8").catch(() => "")).trim());
}

// Removes a lock whose holder died. Takeovers serialize through a breaker file, so a
// waiter that saw the same dead holder can never remove the lock a peer just took.
async function breakStaleLock(lockPath, deadHolder) {
  const breakerPath = `${lockPath}.break`;
  try {
    await writeFile(breakerPath, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    // Judge a breaker by its holder like the lock; a stalled but live holder blocks
    // waiters until the deadline rather than losing exclusion. Age decides only for a
    // breaker whose creator died before writing its pid. Two waiters removing the same
    // dead breaker within one sub-millisecond window could still overlap; that needs a
    // crash inside the breaker's two-call window and is accepted.
    const breakerHolder = await lockHolder(breakerPath);
    if (Number.isInteger(breakerHolder) && breakerHolder > 0) {
      if (!processAlive(breakerHolder)) {
        await rm(breakerPath, { force: true });
      }
      return;
    }
    const age =
      Date.now() - (await stat(breakerPath).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
    if (age > 10_000) {
      await rm(breakerPath, { force: true });
    }
    return;
  }
  try {
    if ((await lockHolder(lockPath)) === deadHolder) {
      await rm(lockPath, { force: true });
    }
  } finally {
    await rm(breakerPath, { force: true });
  }
}

// One lock per lane state directory: concurrent test files in a lane are separate
// processes on one runner. A lock left by a dead process is taken over.
async function withAttachmentLock(lockPath, step, deadline = Date.now() + 120_000) {
  for (;;) {
    try {
      await writeFile(lockPath, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      assert.ok(Date.now() < deadline, `timed out waiting for ${lockPath}`);
      const holder = await lockHolder(lockPath);
      if (Number.isInteger(holder) && holder > 0 && !processAlive(holder)) {
        await breakStaleLock(lockPath, holder);
      }
      await delay(100);
    }
  }
  try {
    return await step();
  } finally {
    await rm(lockPath, { force: true });
  }
}

// A missing registry means no harness file holds the attachment. An unreadable one is
// treated as harness-owned by ordinary callers; strict callers retain it and fail.
async function readHolders(registryPath, strict = false) {
  let registry;
  try {
    registry = JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { connectedByHarness: false, holders: {} };
    }
    assert.ok(!strict, "PostgreSQL attachment registry is unreadable");
    return { connectedByHarness: true, holders: {} };
  }
  if (registry === null || typeof registry !== "object" || Array.isArray(registry)) {
    assert.ok(!strict, "PostgreSQL attachment registry is invalid");
    return { connectedByHarness: true, holders: {} };
  }
  return {
    ...(registry.pendingConnect === true ? { pendingConnect: true } : {}),
    connectedByHarness: registry.connectedByHarness === true,
    holders:
      registry.holders !== null && typeof registry.holders === "object" ? registry.holders : {},
  };
}

async function writeHolders(registryPath, registry) {
  const temporary = `${registryPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(registry), { mode: 0o600 });
    await rename(temporary, registryPath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function liveHolders(registry) {
  return Object.fromEntries(
    Object.entries(registry.holders).filter(([, pid]) => processAlive(pid)),
  );
}

// Connects the lane's PostgreSQL container to its k3d network for in-cluster OCC.
// Files that run concurrently in one lane share the attachment: the first connects,
// and only the last holder disconnects, so no file loses PostgreSQL under a sibling.
// An attachment that existed before any harness connected it is never removed.
/**
 * @param {(cleanup: () => Promise<void>) => unknown} registerCleanup
 * @param {{ signal?: AbortSignal, strictCleanup?: boolean }} [options]
 */
export async function attachPostgresToK3d(registerCleanup, { signal, strictCleanup = false } = {}) {
  signal?.throwIfAborted();
  const statePath = process.env.OPENCLAW_ENTERPRISE_CI_STATE;
  const containerBin = process.env.OCC_DOCKER_BIN ?? "docker";
  assert.ok(statePath, "OPENCLAW_ENTERPRISE_CI_STATE is required for in-cluster OCC");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const cluster = state.resources?.find(
    ({ kind, status }) => kind === "k3d-cluster" && status === "ready",
  );
  const postgres = state.resources?.find(
    ({ kind, status }) => kind === "compose-postgres" && status === "ready",
  );
  assert.ok(cluster?.name, "prepared state must identify the owned k3d cluster");
  assert.ok(postgres?.name, "prepared state must identify the owned PostgreSQL service");
  const discovery = [
    "ps",
    "--filter",
    `label=com.docker.compose.project=${postgres.name}`,
    "--filter",
    "label=com.docker.compose.service=postgres",
    "--format",
    "{{.Names}}",
  ];
  const containerOutput = strictCleanup
    ? await runFixtureCommand(
        containerBin,
        discovery,
        { timeout: 30_000 },
        () => "PostgreSQL attachment discovery failed (output withheld)",
        true,
      )
    : (await executeFile(containerBin, discovery)).stdout;
  const containers = containerOutput.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(containers.length, 1, "prepared PostgreSQL must have exactly one container");
  const postgresContainer = containers[0];
  return attachContainerToK3d(registerCleanup, {
    statePath,
    containerBin,
    cluster,
    container: postgresContainer,
    attachmentName: "postgres",
    signal,
    strictCleanup,
  });
}

// The selected provider belongs to its separately prepared lane. Its attachment
// shares PostgreSQL's holder accounting, without taking ownership of the server.
export async function attachKeycloakToK3d(
  registerCleanup,
  { container, statePath: providerStatePath },
) {
  const statePath = process.env.OPENCLAW_ENTERPRISE_CI_STATE;
  assert.ok(statePath, "OPENCLAW_ENTERPRISE_CI_STATE is required for in-cluster OIDC");
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const providerState =
    providerStatePath === undefined ? state : JSON.parse(await readFile(providerStatePath, "utf8"));
  const cluster = state.resources?.find(
    ({ kind, status }) => kind === "k3d-cluster" && status === "ready",
  );
  assert.ok(cluster?.name, "prepared state must identify the owned k3d cluster");
  assert.ok(
    providerState.resources?.some(
      ({ kind, status, name, owner }) =>
        kind === "keycloak-server" &&
        status === "ready" &&
        name === container &&
        owner === providerState.prefix,
    ),
    "Keycloak container must belong to the selected prepared provider state",
  );
  return attachContainerToK3d(registerCleanup, {
    statePath,
    containerBin: process.env.OCC_DOCKER_BIN ?? "docker",
    cluster,
    container,
    attachmentName: container,
  });
}

async function attachContainerToK3d(
  registerCleanup,
  { statePath, containerBin, cluster, container, attachmentName, signal, strictCleanup = false },
) {
  let cleanupDeadline;
  const execute = async (args) => {
    if (!strictCleanup) {
      return executeFile(containerBin, args);
    }
    const timeout = Math.min(30_000, (cleanupDeadline ?? Infinity) - Date.now());
    assert.ok(timeout > 0, "PostgreSQL attachment cleanup deadline elapsed");
    const stdout = await runFixtureCommand(
      containerBin,
      args,
      { timeout },
      () => "PostgreSQL attachment command failed (output withheld)",
      true,
    );
    assert.ok(
      !cleanupDeadline || Date.now() < cleanupDeadline,
      "PostgreSQL attachment cleanup deadline elapsed",
    );
    return { stdout };
  };
  const serverContainer = `k3d-${cluster.name}-server-0`;
  const { stdout: serverNetworksOutput } = await execute([
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    serverContainer,
  ]);
  const serverNetworks = JSON.parse(serverNetworksOutput);
  const network = Object.keys(serverNetworks).find((name) =>
    name.startsWith(`k3d-${cluster.name}`),
  );
  assert.ok(network, "owned k3d server network must be inspectable");
  const attached = async () => {
    const { stdout } = await execute([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      container,
    ]);
    return Object.hasOwn(JSON.parse(stdout), network);
  };

  const base = join(dirname(statePath), `${attachmentName}-k3d-${cluster.name}`);
  const lockPath = `${base}.lock`;
  const registryPath = `${base}.json`;
  const holder = randomUUID();
  const disconnect = () => execute(["network", "disconnect", "--force", network, container]);
  let releaseRequired = false;
  const release = async () => {
    if (strictCleanup && !releaseRequired) {
      return;
    }
    cleanupDeadline = strictCleanup ? Date.now() + 60_000 : undefined;
    try {
      await withAttachmentLock(
        lockPath,
        async () => {
          assert.ok(
            !cleanupDeadline || Date.now() < cleanupDeadline,
            "PostgreSQL attachment cleanup deadline elapsed",
          );
          const registry = await readHolders(registryPath, strictCleanup);
          assert.ok(
            !registry.pendingConnect,
            "Unconfirmed PostgreSQL connect requires manual reconciliation",
          );
          assert.ok(
            !strictCleanup || Object.hasOwn(registry.holders, holder),
            "PostgreSQL attachment holder record is missing",
          );
          const remaining = liveHolders(registry);
          delete remaining[holder];
          if (Object.keys(remaining).length > 0) {
            await writeHolders(registryPath, { ...registry, holders: remaining });
            return;
          }
          if (registry.connectedByHarness) {
            if (strictCleanup) {
              if (await attached()) {
                await disconnect();
              }
              assert.equal(await attached(), false, "Owned PostgreSQL attachment remains");
            } else {
              await disconnect().catch(() => undefined);
            }
          }
          await rm(registryPath, { force: true });
        },
        cleanupDeadline,
      );
    } catch (error) {
      if (strictCleanup) {
        throw error;
      }
      // Keep the caller's remaining teardown running; lane cleanup reports a leaked attachment.
      console.error(`${attachmentName} k3d network release failed: ${error.message}`);
    }
  };
  if (strictCleanup) {
    registerCleanup(release);
  }
  await withAttachmentLock(lockPath, async () => {
    const registry = await readHolders(registryPath, strictCleanup);
    assert.ok(
      !registry.pendingConnect,
      "Unconfirmed PostgreSQL connect requires manual reconciliation",
    );
    const holders = liveHolders(registry);
    // An attachment no harness file made (connectedByHarness false) stays with its owner.
    let connectedByHarness = registry.connectedByHarness;
    let connectedNow = false;
    const alreadyAttached = await attached();
    // Do not cancel a dispatched connect: finish its bookkeeping and register
    // release before reporting cancellation. New acquisition is fenced here.
    signal?.throwIfAborted();
    if (!alreadyAttached) {
      if (strictCleanup) {
        // Persist before dispatch; a lost reply must not look pre-existing later.
        await writeHolders(registryPath, {
          connectedByHarness: true,
          holders,
          pendingConnect: true,
        });
        releaseRequired = true;
        if (signal?.aborted) {
          await writeHolders(registryPath, registry);
          releaseRequired = false;
          signal.throwIfAborted();
        }
      }
      await execute(["network", "connect", network, container]);
      connectedByHarness = true;
      connectedNow = true;
    }
    try {
      await writeHolders(registryPath, {
        connectedByHarness,
        holders: { ...holders, [holder]: process.pid },
      });
      releaseRequired = true;
    } catch (error) {
      // Without a recorded holder nothing would ever release this connection.
      if (connectedNow && !strictCleanup) {
        await disconnect().catch(() => undefined);
      }
      throw error;
    }
  });
  if (!strictCleanup) {
    registerCleanup(release);
  }
  signal?.throwIfAborted();
  const { stdout: attachedOutput } = await execute([
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks ${JSON.stringify(network)}).IPAddress}}`,
    container,
  ]);
  const address = attachedOutput.trim();
  assert.equal(isIP(address), 4, `${attachmentName} must have an IPv4 address on the k3d network`);
  return address;
}
