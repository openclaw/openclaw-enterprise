import type { OpenClawConfigurationDocument } from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";

import { requireAgentsShape } from "./configured-harness.ts";
import { agentEntryMessage, ConfigurationHarnessError } from "./errors.ts";

// Every Kubernetes topology (embedded OpenClaw, dedicated OpenClaw or Codex) runs the pinned
// OpenClaw Gateway on the admitted document. Its config validation rejects these roster shapes
// and the Gateway then exits at startup (EX_CONFIG) instead of serving. Kubernetes Compute
// refuses them at deployment admission, and Configuration create and update refuse them through
// requireDeployableRoster. SSH Compute runs the host's OpenClaw and does not check them at
// deployment. The Gateway drops only an empty agents.list beside an implicit empty roster, so
// that one passes. A refusal, not a rewrite: OCC skips this on status reads.
export function requireOpenClawRoster(configuration: OpenClawConfigurationDocument): void {
  // Each refusal names the setting and the rule it breaks. Keys come from the caller's own
  // Configuration; agentEntryMessage quotes and bounds them.
  const agents = asRecord(configuration.agents);
  if (configuration.agents !== undefined && agents === undefined) {
    throw new ConfigurationHarnessError("The OpenClaw Gateway requires agents to be an object.");
  }
  const roster = asRecord(agents?.entries);
  if (agents?.entries !== undefined && roster === undefined) {
    throw new ConfigurationHarnessError(
      "The OpenClaw Gateway requires agents.entries to be an object keyed by Agent ID.",
    );
  }
  // OpenClaw's schema: entries is a record of objects whose keys stay unique after its
  // normalizeAgentId (lowercase; a key starting with _ also drops trailing dashes).
  const entries = Object.entries(roster ?? {});
  const normalized = new Map<string, string>();
  for (const [id, entry] of entries) {
    if (asRecord(entry) === undefined) {
      throw new ConfigurationHarnessError(
        agentEntryMessage(id, (path) => `The OpenClaw Gateway requires ${path} to be an object.`),
      );
    }
    if (!/^[a-z0-9_][a-z0-9_-]{0,63}$/i.test(id)) {
      throw new ConfigurationHarnessError(
        agentEntryMessage(
          id,
          (path) =>
            `The OpenClaw Gateway rejects the Agent ID in ${path}: use up to 64 letters, digits, _ or -, not starting with -.`,
        ),
      );
    }
    // A valid ID is plain and at most 64 characters, so both names fit the message cap.
    const key = id.startsWith("_") ? id.toLowerCase().replace(/-+$/, "") : id.toLowerCase();
    const first = normalized.get(key);
    if (first !== undefined) {
      throw new ConfigurationHarnessError(
        `The OpenClaw Gateway normalizes agents.entries.${first} and agents.entries.${id} to the same Agent ID: rename one.`,
      );
    }
    normalized.set(key, id);
  }
  const rosterSize = entries.length;
  const explicit = agents?.ownership === "explicit";
  if (
    agents?.list !== undefined &&
    !(Array.isArray(agents.list) && agents.list.length === 0 && rosterSize === 0 && !explicit)
  ) {
    throw new ConfigurationHarnessError(
      "The OpenClaw Gateway rejects agents.list: remove it and configure each Agent under agents.entries, keyed by its Agent ID.",
    );
  }
  const marked = entries.find(([, entry]) => asRecord(entry)?.default !== undefined);
  if (marked !== undefined) {
    throw new ConfigurationHarnessError(
      agentEntryMessage(
        marked[0],
        (path) => `The OpenClaw Gateway rejects ${path}.default: remove it.`,
      ),
    );
  }
  if (agents?.ownership !== undefined && !explicit) {
    throw new ConfigurationHarnessError(
      'The OpenClaw Gateway accepts only "explicit" for agents.ownership: set it to "explicit", or remove it if agents.entries has at most one entry.',
    );
  }
  if (rosterSize > 1 && !explicit) {
    throw new ConfigurationHarnessError(
      'The OpenClaw Gateway needs agents.ownership "explicit" for more than one agents.entries entry: set it, or keep one entry.',
    );
  }
  if (explicit && rosterSize === 0) {
    throw new ConfigurationHarnessError(
      'The OpenClaw Gateway needs at least one agents.entries entry when agents.ownership is "explicit": add one, or remove agents.ownership.',
    );
  }
}

/**
 * Refuses, when a Configuration is saved, an agents roster that every deployment refuses, with
 * the deployment's text: resolveConfiguredHarnessId's shape rules first, as deployment checks
 * them first, then the OpenClaw Gateway's. Rules that depend on the topology, such as dedicated
 * OpenClaw serving the main Agent, stay at deployment because a Configuration does not fix one.
 */
export function requireDeployableRoster(values: OpenClawConfigurationDocument): void {
  requireAgentsShape(values);
  requireOpenClawRoster(values);
}
