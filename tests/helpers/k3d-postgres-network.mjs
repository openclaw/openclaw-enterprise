import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

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
async function withAttachmentLock(lockPath, registryPath, step) {
  const deadline = Date.now() + 120_000;
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
  let result;
  let failure;
  try {
    result = await step();
  } catch (error) {
    failure = { error };
  }
  try {
    await rm(lockPath, { force: true });
  } catch (error) {
    const unlockFailure = Object.assign(
      new Error(
        `Could not remove attachment lock ${lockPath} (${error.code ?? error.name}). ` +
          "Stop this lane's participants and fix filesystem access. Confirm the lock holder " +
          `cannot resume before clearing the lock. Reconcile ${registryPath} before retrying any attachment operation.`,
        { cause: error },
      ),
      { code: error.code },
    );
    if (!failure) {
      throw unlockFailure;
    }
    const primaryFailure = failure.error;
    throw Object.assign(
      new AggregateError(
        [primaryFailure, unlockFailure],
        `${primaryFailure?.message ?? String(primaryFailure)}. ${unlockFailure.message}`,
        { cause: primaryFailure },
      ),
      { code: primaryFailure?.code },
    );
  }
  if (failure) {
    throw failure.error;
  }
  return result;
}

async function readHolders(registryPath) {
  let contents;
  try {
    contents = await readFile(registryPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { connectedByHarness: false, holders: {} };
    }
    throw error;
  }
  let registry;
  try {
    registry = JSON.parse(contents);
  } catch (error) {
    throw new Error(`invalid attachment registry JSON in ${registryPath}`, { cause: error });
  }
  assert.ok(
    typeof registry?.connectedByHarness === "boolean" &&
      registry.holders &&
      typeof registry.holders === "object" &&
      !Array.isArray(registry.holders) &&
      Object.values(registry.holders).every((pid) => Number.isSafeInteger(pid) && pid > 0),
    `invalid attachment holders in ${registryPath}`,
  );
  const { attachment, pendingConnect, pendingRelease, connectRollback } = registry;
  if (attachment !== undefined) {
    assert.ok(
      isFullId(attachment?.networkId) &&
        isFullId(attachment?.containerId) &&
        (attachment.endpointId === undefined || isFullId(attachment.endpointId)),
      `invalid attachment IDs in ${registryPath}`,
    );
  }
  if (
    pendingConnect !== undefined ||
    pendingRelease !== undefined ||
    connectRollback !== undefined
  ) {
    assert.ok(
      ((pendingConnect === true && pendingRelease === undefined) ||
        (pendingRelease === true && pendingConnect === undefined)) &&
        (connectRollback === undefined || (connectRollback === true && pendingRelease === true)) &&
        attachment &&
        registry.connectedByHarness &&
        Object.keys(registry.holders).length === 0,
      `invalid pending attachment in ${registryPath}`,
    );
  }
  return registry;
}

async function writeHolders(registryPath, registry) {
  const temporary = `${registryPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(registry), { mode: 0o600 });
    await rename(temporary, registryPath);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
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
export async function attachPostgresToK3d(registerCleanup) {
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
  const { stdout: containerOutput } = await executeFile(containerBin, [
    "ps",
    "--filter",
    `label=com.docker.compose.project=${postgres.name}`,
    "--filter",
    "label=com.docker.compose.service=postgres",
    "--no-trunc",
    "--format",
    "{{.ID}}",
  ]);
  const containers = containerOutput.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(containers.length, 1, "prepared PostgreSQL must have exactly one container");
  const postgresContainer = containers[0];
  assert.ok(isFullId(postgresContainer), "prepared PostgreSQL must have a full container ID");
  return attachContainerToK3d(registerCleanup, {
    statePath,
    containerBin,
    cluster,
    container: postgresContainer,
    attachmentName: "postgres",
    preservePublishedPort: true,
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

function isFullId(id) {
  return typeof id === "string" && /^[a-f0-9]{64}$/.test(id);
}

function sameAttachment(left, right) {
  return left?.networkId === right.networkId && left?.containerId === right.containerId;
}

async function inspectNetwork(containerBin, reference) {
  const { stdout } = await executeFile(containerBin, ["network", "inspect", reference]);
  const networks = JSON.parse(stdout);
  assert.ok(Array.isArray(networks) && networks.length === 1, "expected one k3d network");
  const id = networks[0]?.Id ?? networks[0]?.id;
  const name = networks[0]?.Name ?? networks[0]?.name;
  assert.ok(isFullId(id) && typeof name === "string" && name, "invalid k3d network identity");
  const { Containers, containers } = networks[0];
  return { id, name, containers: Containers === undefined ? containers : Containers };
}

async function inspectContainerId(containerBin, reference) {
  const { stdout } = await executeFile(containerBin, ["inspect", "--format", "{{.Id}}", reference]);
  const id = stdout.trim();
  assert.ok(isFullId(id), "container must have a full ID");
  return id;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function containerNetworks(containerBin, reference) {
  const { stdout } = await executeFile(containerBin, [
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    reference,
  ]);
  const networks = JSON.parse(stdout);
  assert.ok(isRecord(networks), "container network membership could not be verified");
  return networks;
}

async function inspectBoundNetwork(inspect, network) {
  const inspected = await inspect(network.id);
  assert.equal(inspected.id, network.id, "container network membership ID changed");
  assert.equal(inspected.name, network.name, "container network membership name changed");
  return inspected;
}

function observeMembership(containerBin) {
  const membership = new Map();
  const invalidListings = new Set();
  const key = (networkId, containerId) => `${networkId}:${containerId}`;
  const conflict = (networkId, containerId) =>
    membership.get(key(networkId, containerId)) ??
    (invalidListings.has(networkId) ? "invalid network member listing" : undefined);

  return {
    async inspect(reference) {
      const inspected = await inspectNetwork(containerBin, reference);
      const { id, containers } = inspected;
      if (isRecord(containers)) {
        for (const [containerId, member] of Object.entries(containers)) {
          if (isFullId(containerId)) {
            membership.set(
              key(id, containerId),
              isRecord(member)
                ? `network ${id} lists container ${containerId} but its own network inventory omits the network`
                : `invalid member entry for container ${containerId} on network ${id}`,
            );
          }
        }
      } else if (containers !== undefined) {
        invalidListings.add(id);
      }
      return inspected;
    },
    recordEndpoints(containerId, networkIds) {
      for (const networkId of networkIds) {
        const pair = key(networkId, containerId);
        if (!membership.has(pair)) {
          membership.set(
            pair,
            `container ${containerId} reported membership on network ${networkId}`,
          );
        }
      }
    },
    conflict,
    assertAbsent(...attachments) {
      for (const { networkId, containerId } of attachments) {
        const reason = conflict(networkId, containerId);
        assert.ok(reason === undefined, reason);
      }
    },
  };
}

async function corroborateMembership(containerBin, containerId, network, allowFilter) {
  if (network.containers !== undefined || !allowFilter) {
    return (
      isRecord(network.containers) &&
      Object.hasOwn(network.containers, containerId) &&
      isRecord(network.containers[containerId])
    );
  }

  // Older engines omit the member listing. The filter can suppress lookup
  // errors, so only a positive, full container ID can corroborate membership.
  const { stdout } = await executeFile(containerBin, [
    "ps",
    "--filter",
    `network=${network.id}`,
    "--filter",
    `id=${containerId}`,
    "--no-trunc",
    "--format",
    "{{.ID}}",
  ]);
  return stdout.trim() === containerId;
}

async function inspectMembership(
  containerBin,
  containerId,
  networks,
  network,
  { inspect, recordEndpoints, conflict },
  { server = false, networkInspectedById = false } = {},
) {
  const seen = new Set();
  for (const [name, endpoint] of Object.entries(networks)) {
    assert.ok(
      name && name !== network.id && isRecord(endpoint),
      "container network membership has an invalid endpoint identity",
    );
    let id = endpoint.NetworkID;
    if (id === name || !isFullId(id)) {
      const missing = id === undefined || id === "";
      assert.ok(
        id === name || (missing && server && name === network.name),
        "container network membership has an invalid endpoint identity",
      );
      const resolved = name === network.name ? network : await inspect(name);
      assert.equal(resolved.name, name, "container network membership name changed");
      assert.equal(
        name === network.name,
        resolved.id === network.id,
        "container network membership name and ID disagree",
      );
      const inspected =
        name === network.name && networkInspectedById
          ? network
          : await inspectBoundNetwork(inspect, resolved);
      assert.ok(
        await corroborateMembership(containerBin, containerId, inspected, !missing),
        `${server ? "k3d server" : "container network"} membership could not be verified by full ID`,
      );
      id = resolved.id;
    }
    assert.notEqual(name, id, "container network membership has an ambiguous endpoint identity");
    assert.equal(
      name === network.name,
      id === network.id,
      "container network membership name and ID disagree",
    );
    assert.ok(!seen.has(id), "container network membership contains a duplicate network ID");
    seen.add(id);
  }
  recordEndpoints(containerId, seen);
  if (seen.has(network.id)) {
    return networks[network.name];
  }

  // Read back the bound network unless a read already contradicts the
  // complete container inventory. The caller checks contradictions at the
  // decision boundary before using the absence.
  if (!conflict(network.id, containerId)) {
    await inspectBoundNetwork(inspect, network);
  }
  return undefined;
}

function corroboratedEndpointId(network, containerId, endpoint) {
  const { containers } = network;
  if (containers !== undefined) {
    assert.ok(isRecord(containers), "invalid network member listing");
    assert.ok(Object.hasOwn(containers, containerId), "network member listing omits the container");
    assert.ok(isRecord(containers[containerId]), "invalid network member entry for the container");
  }
  const endpointId = endpoint.EndpointID;
  const memberId = containers?.[containerId]?.EndpointID;
  assert.ok(
    [endpointId, memberId].every((id) => id === undefined || id === "" || isFullId(id)),
    "invalid attachment endpoint identity",
  );
  // Empty or omitted IDs are the legacy representation. A full ID must
  // appear on both sides before granting ownership of that endpoint.
  assert.ok(
    (endpointId || undefined) === (memberId || undefined),
    "attachment endpoint identities disagree",
  );
  return endpointId || undefined;
}

async function supportsGatewayPriority(containerBin) {
  try {
    const { stdout: help } = await executeFile(containerBin, ["network", "connect", "--help"]);
    if (!/^\s*--gw-priority(?:\s|[=,]|$)/m.test(help)) {
      return false;
    }
    const { stdout } = await executeFile(containerBin, ["version", "--format", "{{json .}}"]);
    const version = JSON.parse(stdout);
    return [version?.Client?.ApiVersion, version?.Server?.ApiVersion].every((api) => {
      const parts = typeof api === "string" && /^(\d+)\.(\d+)$/.exec(api);
      if (!parts) {
        return false;
      }
      const major = Number(parts[1]);
      const minor = Number(parts[2]);
      return (
        Number.isSafeInteger(major) &&
        Number.isSafeInteger(minor) &&
        (major > 1 || (major === 1 && minor >= 48))
      );
    });
  } catch {
    // A failed read-only probe leaves the engine's existing connect command available.
    return false;
  }
}

async function attachContainerToK3d(
  registerCleanup,
  { statePath, containerBin, cluster, container, attachmentName, preservePublishedPort = false },
) {
  const base = join(dirname(statePath), `${attachmentName}-k3d-${cluster.name}`);
  const lockPath = `${base}.lock`;
  const registryPath = `${base}.json`;
  const holder = randomUUID();

  const pendingError = ({ attachment, pendingConnect, connectRollback }, outcome, cause) => {
    let operation = pendingConnect ? "connect" : "disconnect";
    if (connectRollback) {
      operation = "disconnect to roll back a successful connect after a holder write failure";
    }
    const { networkId, containerId, endpointId } = attachment;
    const error = new Error(
      `Pending k3d ${operation} in ${registryPath} for network ${networkId} and container ${containerId}` +
        `${endpointId ? ` (recorded endpoint ${endpointId})` : ""}. ` +
        `${outcome}. Stop this lane's participants and fence ${lockPath}. Using ${containerBin} with the lane's original engine context, ` +
        "verify membership or original object absence by full ID. Retire only the unchanged empty " +
        "pending record after confirming original endpoint absence. If the pair remains attached, " +
        "have the lane owner resolve ownership and choose the exact corrective operation. " +
        "Keep the record if the outcome remains unclear.",
      { cause },
    );
    return Object.assign(error, { code: cause?.code });
  };

  const ownershipError = ({ networkId, containerId, endpointId }, outcome, cause) =>
    new Error(
      `Cannot verify k3d attachment ownership in ${registryPath} for network ${networkId} and container ${containerId}` +
        `${endpointId ? ` (recorded endpoint ${endpointId})` : ""}. ${outcome}. ` +
        `Stop this lane's participants and fence ${lockPath}. Using ${containerBin} with the lane's original engine context, ` +
        "inspect the exact pair and its endpoint. Retire the unchanged record only after confirming the original attachment is gone " +
        "or the lane owner has resolved ownership. Keep the record if ownership remains unclear.",
      { cause },
    );

  const observeAttachment = async (
    registry,
    observation,
    phase,
    { operationFailure, verifyEndpoint = false } = {},
  ) => {
    const { networkId, containerId } = registry.attachment;
    try {
      const [network, inspectedContainerId] = await Promise.all([
        observation.inspect(networkId),
        inspectContainerId(containerBin, containerId),
      ]);
      // A successful lookup can resolve a replacement. That does not establish
      // the original endpoint's absence.
      assert.equal(network.id, networkId, "original network identity could not be verified");
      assert.equal(
        inspectedContainerId,
        containerId,
        "original container identity could not be verified",
      );
      const endpoint = await inspectMembership(
        containerBin,
        containerId,
        await containerNetworks(containerBin, containerId),
        network,
        observation,
        { networkInspectedById: true },
      );
      if (!endpoint) {
        observation.assertAbsent(registry.attachment);
      }
      return {
        attached: Boolean(endpoint),
        endpointId:
          verifyEndpoint && endpoint
            ? corroboratedEndpointId(network, containerId, endpoint)
            : undefined,
      };
    } catch (error) {
      const detail = error instanceof assert.AssertionError ? `. ${error.message}` : "";
      const outcome = `${phase}. Exact membership inspection failed (${error.code ?? error.name})${detail}`;
      const cause = operationFailure
        ? Object.assign(
            new AggregateError([operationFailure, error], outcome, {
              cause: operationFailure,
            }),
            { code: operationFailure.code },
          )
        : error;
      if (registry.pendingConnect || registry.pendingRelease) {
        throw pendingError(registry, outcome, cause);
      }
      throw ownershipError(registry.attachment, outcome, cause);
    }
  };

  const retirePending = async (registry) => {
    try {
      await rm(registryPath, { force: true });
    } catch (error) {
      throw pendingError(
        registry,
        `Original membership absent. Pending record removal failed (${error.code ?? error.name})`,
        error,
      );
    }
  };

  const releasePending = async (registry, operation) => {
    const expectedEndpoint = registry.attachment.endpointId;
    const current = await observeAttachment(
      registry,
      observeMembership(containerBin),
      `${operation} preflight`,
      { verifyEndpoint: expectedEndpoint !== undefined },
    );
    if (current.attached) {
      if (expectedEndpoint && current.endpointId !== expectedEndpoint) {
        throw pendingError(
          registry,
          `${operation} preflight. Attachment endpoint identity changed or could not be corroborated`,
        );
      }
      let failure;
      try {
        await executeFile(containerBin, [
          "network",
          "disconnect",
          "--force",
          registry.attachment.networkId,
          registry.attachment.containerId,
        ]);
      } catch (error) {
        failure = error;
      }
      const phase = failure
        ? `${operation} reported ${failure.code ?? failure.name}`
        : `${operation} exited 0`;
      // Start a new observation after submitting the disconnect.
      const readback = await observeAttachment(registry, observeMembership(containerBin), phase, {
        operationFailure: failure,
      });
      if (readback.attached) {
        throw pendingError(registry, `${phase}. Original membership remains`, failure);
      }
    }
    await retirePending(registry);
  };

  const { attachment, networkName } = await withAttachmentLock(lockPath, registryPath, async () => {
    const observation = observeMembership(containerBin);
    const registry = await readHolders(registryPath);
    const hasPending = registry.pendingConnect || registry.pendingRelease;
    if (
      hasPending &&
      (await observeAttachment(registry, observation, "Acquisition readback")).attached
    ) {
      throw pendingError(
        registry,
        "Acquisition readback found the original membership still attached",
      );
    }

    const serverId = await inspectContainerId(containerBin, `k3d-${cluster.name}-server-0`);
    const serverNetworks = await containerNetworks(containerBin, serverId);
    const matchingNetworks = Object.keys(serverNetworks).filter((name) =>
      name.startsWith(`k3d-${cluster.name}`),
    );
    assert.equal(matchingNetworks.length, 1, "expected one owned k3d server network");
    const [networkName] = matchingNetworks;
    const [network, containerId] = await Promise.all([
      observation.inspect(networkName),
      inspectContainerId(containerBin, container),
    ]);
    assert.equal(network.name, networkName, "k3d network name must match its inspection");
    assert.ok(
      await inspectMembership(containerBin, serverId, serverNetworks, network, observation, {
        server: true,
      }),
      "owned k3d server network must be inspectable",
    );
    if (isFullId(container)) {
      assert.equal(containerId, container, "prepared container ID must match its inspection");
    }
    const attachment = { networkId: network.id, containerId };
    const holders = liveHolders(registry);
    const shared = Object.keys(holders).length > 0;
    assert.ok(
      !shared || sameAttachment(registry.attachment, attachment),
      `live attachment holders in ${registryPath} have a different or unverified engine binding`,
    );
    // An empty record has no committed holder history. A dead holder in a
    // committed record is still evidence, but it cannot establish continuity.
    const committed = registry.connectedByHarness && Object.keys(registry.holders).length > 0;
    if (committed && !shared && !registry.attachment) {
      throw new Error(
        `Cannot verify k3d attachment ownership in ${registryPath}. The record has no network or container ID for the original attachment. ` +
          `The currently selected network ${attachment.networkId} and container ${attachment.containerId} do not identify the original pair. ` +
          `Stop this lane's participants and fence ${lockPath}. Using the lane's original engine context, ` +
          "recover the original pair from lane logs or engine records and inspect its membership by full IDs. " +
          "Retire the unchanged record only after confirming the original attachment is gone or the lane owner has resolved ownership. " +
          "Keep the record if ownership remains unclear.",
      );
    }
    const attached = Boolean(
      await inspectMembership(
        containerBin,
        containerId,
        await containerNetworks(containerBin, containerId),
        network,
        observation,
      ),
    );
    const samePair = sameAttachment(registry.attachment, attachment);
    const recordedEndpoint = registry.attachment?.endpointId;
    let keepOwnership = shared && registry.connectedByHarness;
    if (committed && !shared && registry.attachment && !samePair) {
      const original = await observeAttachment(
        registry,
        observation,
        "Previous attachment readback",
      );
      if (original.attached) {
        throw ownershipError(registry.attachment, "The previously owned pair is still attached");
      }
    }
    if (committed && attached && samePair) {
      if (recordedEndpoint) {
        const phase = "Attachment continuity readback";
        const current = await observeAttachment(registry, observation, phase, {
          verifyEndpoint: true,
        });
        if (!current.endpointId) {
          throw ownershipError(
            registry.attachment,
            "The recorded endpoint could not be corroborated",
          );
        }
        if (shared && current.endpointId !== recordedEndpoint) {
          throw ownershipError(
            registry.attachment,
            "The recorded endpoint changed with live holders",
          );
        }
        keepOwnership = current.endpointId === recordedEndpoint;
        if (keepOwnership) {
          attachment.endpointId = recordedEndpoint;
        }
      } else if (!shared) {
        throw ownershipError(
          attachment,
          "The previous holders exited without a recorded endpoint identity",
        );
      }
    }
    assert.ok(
      !shared || attached,
      `live attachment holders in ${registryPath} lost their membership`,
    );
    // Recheck every absence this write relies on, including the original
    // pending pair when the replacement is already attached.
    const requiredAbsences = hasPending ? [registry.attachment] : [];
    if (committed && !samePair && registry.attachment) {
      requiredAbsences.push(registry.attachment);
    }
    if (!attached) {
      requiredAbsences.push(attachment);
    }
    try {
      observation.assertAbsent(...requiredAbsences);
    } catch (error) {
      if (hasPending) {
        throw pendingError(
          registry,
          `Acquisition membership reports disagree. ${error.message}`,
          error,
        );
      }
      if (committed && registry.attachment && !samePair) {
        throw ownershipError(
          registry.attachment,
          `Acquisition membership reports disagree. ${error.message}`,
          error,
        );
      }
      throw error;
    }

    let pending;
    if (!attached) {
      const args = ["network", "connect"];
      // Keep PostgreSQL's original network as its default gateway so the host port stays bound.
      if (preservePublishedPort && (await supportsGatewayPriority(containerBin))) {
        args.push("--gw-priority=-1");
      }
      pending = { attachment, connectedByHarness: true, holders: {}, pendingConnect: true };
      // Persist intent first. A failed engine call or holder write must leave
      // the same pair fenced for reconciliation.
      await writeHolders(registryPath, pending);
      try {
        await executeFile(containerBin, [...args, network.id, containerId]);
      } catch (error) {
        throw pendingError(pending, `Connect reported ${error.code ?? error.name}`, error);
      }
      const readback = await observeAttachment(
        pending,
        observeMembership(containerBin),
        "Connect exited 0. Endpoint readback",
        { verifyEndpoint: true },
      );
      if (!readback.attached) {
        throw pendingError(pending, "Connect exited 0. Original membership is absent");
      }
      if (readback.endpointId) {
        attachment.endpointId = readback.endpointId;
      }
    }
    try {
      await writeHolders(registryPath, {
        attachment,
        connectedByHarness: !attached || keepOwnership,
        holders: { ...holders, [holder]: process.pid },
      });
    } catch (error) {
      if (!pending) {
        throw error;
      }

      // Record the rollback before attempting a disconnect. A later caller
      // needs to know which operation requires reconciliation.
      const rollback = {
        attachment,
        connectedByHarness: true,
        holders: {},
        pendingRelease: true,
        connectRollback: true,
      };
      const registrationFailure = `Connect exited 0. Holder write failed (${error.code ?? error.name})`;
      let rollbackRecorded = false;
      try {
        await writeHolders(registryPath, rollback);
        rollbackRecorded = true;
        await releasePending(rollback, "Connect rollback");
      } catch (failure) {
        const diagnostic = rollbackRecorded
          ? failure
          : pendingError(
              pending,
              `Rollback record write failed (${failure.code ?? failure.name}). Disconnect was not attempted`,
              failure,
            );
        throw Object.assign(
          new AggregateError([error, failure], `${registrationFailure}. ${diagnostic.message}`, {
            cause: failure,
          }),
          { code: error.code },
        );
      }
      throw error;
    }
    return { attachment, networkName };
  });

  registerCleanup(async () => {
    try {
      await withAttachmentLock(lockPath, registryPath, async () => {
        const registry = await readHolders(registryPath);
        if (!Object.hasOwn(registry.holders, holder)) {
          return;
        }
        assert.ok(
          sameAttachment(registry.attachment, attachment),
          `attachment binding changed in ${registryPath}`,
        );
        const remaining = liveHolders(registry);
        delete remaining[holder];
        if (Object.keys(remaining).length > 0) {
          await writeHolders(registryPath, { ...registry, holders: remaining });
          return;
        }
        if (registry.connectedByHarness) {
          const pending = { ...registry, holders: {}, pendingRelease: true };
          await writeHolders(registryPath, pending);
          await releasePending(pending, "Disconnect");
          return;
        }
        await rm(registryPath, { force: true });
      });
    } catch (error) {
      // Keep the caller's remaining teardown running; lane cleanup reports a leaked attachment.
      console.error(`${attachmentName} k3d network release failed: ${error.message}`);
    }
  });
  const { stdout: attachedOutput } = await executeFile(containerBin, [
    "inspect",
    "--format",
    `{{(index .NetworkSettings.Networks ${JSON.stringify(networkName)}).IPAddress}}`,
    attachment.containerId,
  ]);
  const address = attachedOutput.trim();
  assert.equal(isIP(address), 4, `${attachmentName} must have an IPv4 address on the k3d network`);
  return address;
}
