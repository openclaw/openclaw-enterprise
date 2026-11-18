import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { asRecord } from "../../packages/utils/src/index.ts";
import {
  errorStatus,
  isFullId,
  liveHolders,
  readHolders,
  thrownField,
  withAttachmentLock,
  writeHolders,
  type Attachment,
  type PendingAttachment,
  type PendingRelease,
} from "./k3d-attachment-journal.ts";
import {
  containerNetworks,
  corroboratedEndpointId,
  executeFile,
  inspectContainerId,
  inspectMembership,
  observeMembership,
  type MembershipObservation,
} from "./k3d-network-membership.ts";

type RegisterCleanup = (cleanup: () => Promise<void>) => void;
type KeycloakAttachmentOptions = { container: string; statePath?: string | undefined };
type AttachmentOptions = {
  statePath: string;
  containerBin: string;
  clusterName: string;
  container: string;
  attachmentName: string;
};
type ReadbackOptions = { operationFailure?: unknown; verifyEndpoint?: boolean };
type Resource = Record<string, unknown>;
type PreparedState = { prefix: unknown; resources: unknown[] };

async function readPreparedState(path: string): Promise<PreparedState> {
  const decoded: unknown = JSON.parse(await readFile(path, "utf8"));
  const state = asRecord(decoded);
  const resources = state?.resources;
  assert.ok(
    state && (resources == null || Array.isArray(resources)),
    "invalid prepared state resources",
  );
  const entries: unknown[] = resources ?? [];
  return { prefix: state.prefix, resources: entries };
}

function readyResource(
  state: PreparedState,
  kind: "k3d-cluster" | "compose-postgres" | "keycloak-server",
  matches?: (resource: Resource) => boolean,
): Resource | undefined {
  for (const value of state.resources) {
    assert.notEqual(value, null, "invalid prepared state resource");
    const resource = asRecord(value);
    if (
      resource?.kind === kind &&
      resource.status === "ready" &&
      (matches === undefined || matches(resource))
    ) {
      return resource;
    }
  }
  return undefined;
}

function sameAttachment(left: Attachment | undefined, right: Attachment): boolean {
  return left?.networkId === right.networkId && left?.containerId === right.containerId;
}

// Connects the lane's PostgreSQL container to its k3d network for in-cluster OCC.
// Files that run concurrently in one lane share the attachment: the first connects,
// and only the last holder disconnects, so no file loses PostgreSQL under a sibling.
// An attachment that existed before any harness connected it is never removed.
export async function attachPostgresToK3d(registerCleanup: RegisterCleanup): Promise<string> {
  const statePath = process.env.OPENCLAW_ENTERPRISE_CI_STATE;
  const containerBin = process.env.OCC_DOCKER_BIN ?? "docker";
  assert.ok(statePath, "OPENCLAW_ENTERPRISE_CI_STATE is required for in-cluster OCC");
  const state = await readPreparedState(statePath);
  const clusterName = readyResource(state, "k3d-cluster")?.name;
  const postgresName = readyResource(state, "compose-postgres")?.name;
  assert.ok(
    typeof clusterName === "string" && clusterName,
    "prepared state must identify the owned k3d cluster",
  );
  assert.ok(
    typeof postgresName === "string" && postgresName,
    "prepared state must identify the owned PostgreSQL service",
  );
  const { stdout: containerOutput } = await executeFile(containerBin, [
    "ps",
    "--filter",
    `label=com.docker.compose.project=${postgresName}`,
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
    clusterName,
    container: postgresContainer,
    attachmentName: "postgres",
  });
}

// The selected provider belongs to its separately prepared lane. Its attachment
// shares PostgreSQL's holder accounting, without taking ownership of the server.
export async function attachKeycloakToK3d(
  registerCleanup: RegisterCleanup,
  { container, statePath: providerStatePath }: KeycloakAttachmentOptions,
): Promise<string> {
  const statePath = process.env.OPENCLAW_ENTERPRISE_CI_STATE;
  assert.ok(statePath, "OPENCLAW_ENTERPRISE_CI_STATE is required for in-cluster OIDC");
  const state = await readPreparedState(statePath);
  const providerState =
    providerStatePath === undefined ? state : await readPreparedState(providerStatePath);
  const clusterName = readyResource(state, "k3d-cluster")?.name;
  assert.ok(
    typeof clusterName === "string" && clusterName,
    "prepared state must identify the owned k3d cluster",
  );
  assert.ok(
    readyResource(
      providerState,
      "keycloak-server",
      ({ name, owner }) => name === container && owner === providerState.prefix,
    ),
    "Keycloak container must belong to the selected prepared provider state",
  );
  return attachContainerToK3d(registerCleanup, {
    statePath,
    containerBin: process.env.OCC_DOCKER_BIN ?? "docker",
    clusterName,
    container,
    attachmentName: container,
  });
}

async function attachContainerToK3d(
  registerCleanup: RegisterCleanup,
  { statePath, containerBin, clusterName, container, attachmentName }: AttachmentOptions,
) {
  const base = join(dirname(statePath), `${attachmentName}-k3d-${clusterName}`);
  const lockPath = `${base}.lock`;
  const registryPath = `${base}.json`;
  const holder = randomUUID();

  const pendingError = (
    { attachment, pendingConnect, connectRollback }: PendingAttachment,
    outcome: string,
    cause?: unknown,
  ) => {
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
    return Object.assign(error, { code: thrownField(cause, "code") });
  };

  const ownershipError = (
    { networkId, containerId, endpointId }: Attachment,
    outcome: string,
    cause?: unknown,
  ) =>
    new Error(
      `Cannot verify k3d attachment ownership in ${registryPath} for network ${networkId} and container ${containerId}` +
        `${endpointId ? ` (recorded endpoint ${endpointId})` : ""}. ${outcome}. ` +
        `Stop this lane's participants and fence ${lockPath}. Using ${containerBin} with the lane's original engine context, ` +
        "inspect the exact pair and its endpoint. Retire the unchanged record only after confirming the original attachment is gone " +
        "or the lane owner has resolved ownership. Keep the record if ownership remains unclear.",
      { cause },
    );

  const observeAttachment = async (
    binding: { attachment: Attachment } | { pending: PendingAttachment },
    observation: MembershipObservation,
    phase: string,
    { operationFailure, verifyEndpoint = false }: ReadbackOptions = {},
  ) => {
    const attachment = "pending" in binding ? binding.pending.attachment : binding.attachment;
    const { networkId, containerId } = attachment;
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
        observation.assertAbsent(attachment);
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
      const outcome = `${phase}. Exact membership inspection failed (${errorStatus(error)})${detail}`;
      const cause = operationFailure
        ? Object.assign(
            new AggregateError([operationFailure, error], outcome, {
              cause: operationFailure,
            }),
            { code: thrownField(operationFailure, "code") },
          )
        : error;
      if ("pending" in binding) {
        throw pendingError(binding.pending, outcome, cause);
      }
      throw ownershipError(attachment, outcome, cause);
    }
  };

  const retirePending = async (registry: PendingAttachment) => {
    try {
      await rm(registryPath, { force: true });
    } catch (error) {
      throw pendingError(
        registry,
        `Original membership absent. Pending record removal failed (${errorStatus(error)})`,
        error,
      );
    }
  };

  const releasePending = async (registry: PendingRelease, operation: string) => {
    const expectedEndpoint = registry.attachment.endpointId;
    const current = await observeAttachment(
      { pending: registry },
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
      let failure: unknown;
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
        ? `${operation} reported ${errorStatus(failure)}`
        : `${operation} exited 0`;
      // Start a new observation after submitting the disconnect.
      const readback = await observeAttachment(
        { pending: registry },
        observeMembership(containerBin),
        phase,
        {
          operationFailure: failure,
        },
      );
      if (readback.attached) {
        throw pendingError(registry, `${phase}. Original membership remains`, failure);
      }
    }
    await retirePending(registry);
  };

  const { attachment, networkName } = await withAttachmentLock(lockPath, registryPath, async () => {
    const observation = observeMembership(containerBin);
    const registry = await readHolders(registryPath);
    const pendingRegistry =
      registry.pendingConnect || registry.pendingRelease ? registry : undefined;
    if (
      pendingRegistry &&
      (await observeAttachment({ pending: pendingRegistry }, observation, "Acquisition readback"))
        .attached
    ) {
      throw pendingError(
        pendingRegistry,
        "Acquisition readback found the original membership still attached",
      );
    }

    const serverId = await inspectContainerId(containerBin, `k3d-${clusterName}-server-0`);
    const serverNetworks = await containerNetworks(containerBin, serverId);
    const matchingNetworks = Object.keys(serverNetworks).filter((name) =>
      name.startsWith(`k3d-${clusterName}`),
    );
    const [networkName] = matchingNetworks;
    assert.ok(
      matchingNetworks.length === 1 && networkName !== undefined,
      "expected one owned k3d server network",
    );
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
    const attachment: Attachment = { networkId: network.id, containerId };
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
    const previousAttachment = registry.attachment;
    const samePair = sameAttachment(previousAttachment, attachment);
    let keepOwnership = shared && registry.connectedByHarness;
    if (committed && !shared && previousAttachment && !samePair) {
      const original = await observeAttachment(
        { attachment: previousAttachment },
        observation,
        "Previous attachment readback",
      );
      if (original.attached) {
        throw ownershipError(previousAttachment, "The previously owned pair is still attached");
      }
    }
    if (committed && attached && samePair && previousAttachment) {
      const recordedEndpoint = previousAttachment.endpointId;
      if (recordedEndpoint) {
        const phase = "Attachment continuity readback";
        const current = await observeAttachment(
          { attachment: previousAttachment },
          observation,
          phase,
          {
            verifyEndpoint: true,
          },
        );
        if (!current.endpointId) {
          throw ownershipError(
            previousAttachment,
            "The recorded endpoint could not be corroborated",
          );
        }
        if (shared && current.endpointId !== recordedEndpoint) {
          throw ownershipError(
            previousAttachment,
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
    const requiredAbsences = pendingRegistry ? [pendingRegistry.attachment] : [];
    if (committed && !samePair && registry.attachment) {
      requiredAbsences.push(registry.attachment);
    }
    if (!attached) {
      requiredAbsences.push(attachment);
    }
    try {
      observation.assertAbsent(...requiredAbsences);
    } catch (error) {
      if (pendingRegistry) {
        throw pendingError(
          pendingRegistry,
          `Acquisition membership reports disagree. ${thrownField(error, "message")}`,
          error,
        );
      }
      if (committed && registry.attachment && !samePair) {
        throw ownershipError(
          registry.attachment,
          `Acquisition membership reports disagree. ${thrownField(error, "message")}`,
          error,
        );
      }
      throw error;
    }

    let pending: PendingAttachment | undefined;
    if (!attached) {
      pending = { attachment, connectedByHarness: true, holders: {}, pendingConnect: true };
      // Persist intent first. A failed engine call or holder write must leave
      // the same pair fenced for reconciliation.
      await writeHolders(registryPath, pending);
      try {
        await executeFile(containerBin, ["network", "connect", network.id, containerId]);
      } catch (error) {
        throw pendingError(pending, `Connect reported ${errorStatus(error)}`, error);
      }
      const readback = await observeAttachment(
        { pending },
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
      const rollback: PendingRelease = {
        attachment,
        connectedByHarness: true,
        holders: {},
        pendingRelease: true,
        connectRollback: true,
      };
      const registrationFailure = `Connect exited 0. Holder write failed (${errorStatus(error)})`;
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
              `Rollback record write failed (${errorStatus(failure)}). Disconnect was not attempted`,
              failure,
            );
        throw Object.assign(
          new AggregateError(
            [error, failure],
            `${registrationFailure}. ${thrownField(diagnostic, "message")}`,
            {
              cause: failure,
            },
          ),
          { code: thrownField(error, "code") },
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
        if (
          registry.pendingConnect ||
          registry.pendingRelease ||
          !Object.hasOwn(registry.holders, holder)
        ) {
          return;
        }
        assert.ok(
          registry.attachment && sameAttachment(registry.attachment, attachment),
          `attachment binding changed in ${registryPath}`,
        );
        const remaining = liveHolders(registry);
        delete remaining[holder];
        if (Object.keys(remaining).length > 0) {
          await writeHolders(registryPath, { ...registry, holders: remaining });
          return;
        }
        if (registry.connectedByHarness) {
          const pending: PendingRelease = {
            ...registry,
            attachment: registry.attachment,
            connectedByHarness: true,
            holders: {},
            pendingRelease: true,
          };
          await writeHolders(registryPath, pending);
          await releasePending(pending, "Disconnect");
          return;
        }
        await rm(registryPath, { force: true });
      });
    } catch (error) {
      // Keep the caller's remaining teardown running; lane cleanup reports a leaked attachment.
      console.error(
        `${attachmentName} k3d network release failed: ${thrownField(error, "message")}`,
      );
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
