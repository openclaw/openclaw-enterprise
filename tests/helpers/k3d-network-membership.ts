import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { asRecord } from "../../packages/utils/src/index.ts";
import { isFullId, type Attachment } from "./k3d-attachment-journal.ts";

export const executeFile = promisify(execFile);

type Network = {
  id: string;
  name: string;
  containers: unknown;
};

type Endpoint = Record<string, unknown>;

export type MembershipObservation = {
  inspect: (reference: string) => Promise<Network>;
  recordEndpoints: (containerId: string, networkIds: ReadonlySet<string>) => void;
  conflict: (networkId: string, containerId: string) => string | undefined;
  assertAbsent: (...attachments: Attachment[]) => void;
};

type MembershipOptions = { server?: boolean; networkInspectedById?: boolean };

async function inspectNetwork(containerBin: string, reference: string): Promise<Network> {
  const { stdout } = await executeFile(containerBin, ["network", "inspect", reference]);
  const networks: unknown = JSON.parse(stdout);
  assert.ok(Array.isArray(networks) && networks.length === 1, "expected one k3d network");
  const [value]: unknown[] = networks;
  const network = asRecord(value);
  const id = network?.Id ?? network?.id;
  const name = network?.Name ?? network?.name;
  assert.ok(
    network && isFullId(id) && typeof name === "string" && name,
    "invalid k3d network identity",
  );
  const { Containers, containers } = network;
  return { id, name, containers: Containers === undefined ? containers : Containers };
}

export async function inspectContainerId(containerBin: string, reference: string) {
  const { stdout } = await executeFile(containerBin, ["inspect", "--format", "{{.Id}}", reference]);
  const id = stdout.trim();
  assert.ok(isFullId(id), "container must have a full ID");
  return id;
}

export async function containerNetworks(containerBin: string, reference: string) {
  const { stdout } = await executeFile(containerBin, [
    "inspect",
    "--format",
    "{{json .NetworkSettings.Networks}}",
    reference,
  ]);
  const value: unknown = JSON.parse(stdout);
  const networks = asRecord(value);
  assert.ok(networks, "container network membership could not be verified");
  return networks;
}

async function inspectBoundNetwork(inspect: MembershipObservation["inspect"], network: Network) {
  const inspected = await inspect(network.id);
  assert.equal(inspected.id, network.id, "container network membership ID changed");
  assert.equal(inspected.name, network.name, "container network membership name changed");
  return inspected;
}

export function observeMembership(containerBin: string): MembershipObservation {
  const membership = new Map<string, string>();
  const invalidListings = new Set<string>();
  const key = (networkId: string, containerId: string) => `${networkId}:${containerId}`;
  const conflict = (networkId: string, containerId: string) =>
    membership.get(key(networkId, containerId)) ??
    (invalidListings.has(networkId) ? "invalid network member listing" : undefined);

  return {
    async inspect(reference) {
      const inspected = await inspectNetwork(containerBin, reference);
      const { id, containers } = inspected;
      const members = asRecord(containers);
      if (members) {
        for (const [containerId, member] of Object.entries(members)) {
          if (isFullId(containerId)) {
            membership.set(
              key(id, containerId),
              asRecord(member)
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
        assert.ok(reason === undefined, reason ?? "");
      }
    },
  };
}

async function corroborateMembership(
  containerBin: string,
  containerId: string,
  network: Network,
  allowFilter: boolean,
) {
  if (network.containers !== undefined || !allowFilter) {
    const members = asRecord(network.containers);
    return (
      members !== undefined &&
      Object.hasOwn(members, containerId) &&
      asRecord(members[containerId]) !== undefined
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

export async function inspectMembership(
  containerBin: string,
  containerId: string,
  networks: Record<string, unknown>,
  network: Network,
  { inspect, recordEndpoints, conflict }: MembershipObservation,
  { server = false, networkInspectedById = false }: MembershipOptions = {},
): Promise<Endpoint | undefined> {
  const seen = new Set<string>();
  let boundEndpoint: Endpoint | undefined;
  for (const [name, value] of Object.entries(networks)) {
    const endpoint = asRecord(value);
    assert.ok(
      name && name !== network.id && endpoint,
      "container network membership has an invalid endpoint identity",
    );
    const reportedId = endpoint.NetworkID;
    let id: string;
    if (reportedId === name || !isFullId(reportedId)) {
      const missing = reportedId === undefined || reportedId === "";
      assert.ok(
        reportedId === name || (missing && server && name === network.name),
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
    } else {
      id = reportedId;
    }
    assert.notEqual(name, id, "container network membership has an ambiguous endpoint identity");
    assert.equal(
      name === network.name,
      id === network.id,
      "container network membership name and ID disagree",
    );
    assert.ok(!seen.has(id), "container network membership contains a duplicate network ID");
    seen.add(id);
    if (id === network.id) {
      boundEndpoint = endpoint;
    }
  }
  recordEndpoints(containerId, seen);
  if (boundEndpoint) {
    return boundEndpoint;
  }

  // Read back the bound network unless a read already contradicts the
  // complete container inventory. The caller checks contradictions at the
  // decision boundary before using the absence.
  if (!conflict(network.id, containerId)) {
    await inspectBoundNetwork(inspect, network);
  }
  return undefined;
}

export function corroboratedEndpointId(network: Network, containerId: string, endpoint: Endpoint) {
  let memberId: unknown;
  if (network.containers !== undefined) {
    const members = asRecord(network.containers);
    assert.ok(members, "invalid network member listing");
    assert.ok(Object.hasOwn(members, containerId), "network member listing omits the container");
    const member = asRecord(members[containerId]);
    assert.ok(member, "invalid network member entry for the container");
    memberId = member.EndpointID;
  }
  const endpointId = endpoint.EndpointID;
  assert.ok(
    isOptionalEndpointId(endpointId) && isOptionalEndpointId(memberId),
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

function isOptionalEndpointId(id: unknown): id is string | undefined {
  return id === undefined || id === "" || isFullId(id);
}
