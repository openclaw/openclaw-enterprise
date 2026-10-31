import type {
  ConfigurationValidationOptions,
  OpenClawConfigurationDocument,
} from "@openclaw-enterprise/contracts";
import { asRecord } from "@openclaw-enterprise/utils";

import { canSpell } from "./configuration-settings.ts";
import {
  requireAgentsShape,
  requireConsistentModelPolicy,
  requireModelSelections,
} from "./configured-harness.ts";
import { agentEntryMessage, ConfigurationHarnessError } from "./errors.ts";

// Every Kubernetes topology (embedded OpenClaw, dedicated OpenClaw or Codex) runs the pinned
// OpenClaw Gateway on the admitted document. Its config validation rejects these roster shapes
// and the Gateway then exits at startup (EX_CONFIG) instead of serving. Kubernetes Compute
// refuses them at deployment admission, and Configuration create and update refuse them through
// requireDeployableRoster. SSH Compute runs the host's OpenClaw and does not check them at
// deployment. The Gateway drops only an empty agents.list beside an implicit empty roster, so
// that one passes. A refusal, not a rewrite: OCC skips this on status reads.
//
// On a Preset save (`options.unresolved`, finding 1308), an Agent ID or agents.ownership that
// waits on an unfilled variable is checked as far as its written text goes: an ID whose written
// text no filling makes valid is refused, and an ownership that can still read "explicit" counts
// as explicit, the only value a launch accepts. The launch's Configuration is checked in full.
export function requireOpenClawRoster(
  configuration: OpenClawConfigurationDocument,
  options?: ConfigurationValidationOptions,
): void {
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
    // The text around each unfilled variable in a Preset's Agent ID, or undefined.
    const literals = options?.unresolved?.(["agents", "entries", id], true);
    if (
      literals === undefined
        ? !/^[a-z0-9_][a-z0-9_-]{0,63}$/i.test(id)
        : !/^[a-z0-9_-]{0,64}$/i.test(literals.join("")) || literals[0]!.startsWith("-")
    ) {
      throw new ConfigurationHarnessError(
        agentEntryMessage(
          id,
          (path) =>
            `The OpenClaw Gateway rejects the Agent ID in ${path}: use up to 64 letters, digits, _ or -, not starting with -.`,
        ),
      );
    }
    if (literals !== undefined) {
      // Its filled ID is compared on the launch's Configuration.
      continue;
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
  const explicit =
    agents?.ownership === "explicit" || canFillExplicit(["agents", "ownership"], options);
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

// Whether the Preset value at `path` waits on an unfilled string variable and its written text
// can still read "explicit". A number or boolean variable fills it with no string.
function canFillExplicit(
  path: readonly string[],
  options: ConfigurationValidationOptions | undefined,
): boolean {
  const literals = options?.unresolved?.(path);
  const type = options?.unresolvedType?.(path);
  if (literals === undefined || (type !== undefined && type !== "string")) {
    return false;
  }
  return canSpell(literals, "explicit");
}

/**
 * The Configuration values a deployment admits with the OCC Agent name as the served OpenClaw
 * Agent's display name. The Control UI shows `identity.name` of the first roster entry, or of
 * main when the roster is omitted, and falls back to "Assistant". An omitted roster gains the
 * main entry the Gateway already serves. A name the Configuration sets wins, and
 * a roster of several entries keeps the names its entries set: the OCC Agent is the Gateway, not
 * one of them. Shapes the roster rules refuse pass through unchanged for those rules to name.
 */
export function withAgentIdentityName(
  values: Readonly<OpenClawConfigurationDocument>,
  name: string,
): OpenClawConfigurationDocument {
  const agents = values.agents === undefined ? {} : asRecord(values.agents);
  if (agents === undefined || agents.list !== undefined) {
    return values;
  }
  const entries = agents.entries === undefined ? { main: {} } : asRecord(agents.entries);
  const keys = Object.keys(entries ?? {});
  if (entries === undefined || keys.length !== 1) {
    return values;
  }
  const entry = asRecord(entries[keys[0]!]);
  const identity = entry?.identity === undefined ? {} : asRecord(entry.identity);
  if (entry === undefined || identity === undefined || identity.name !== undefined) {
    return values;
  }
  return {
    ...values,
    agents: {
      ...agents,
      entries: { [keys[0]!]: { ...entry, identity: { ...identity, name } } },
    },
  };
}

/**
 * Refuses, when a Configuration is saved, an agents roster and model policy that every deployment
 * refuses, with the deployment's text. resolveConfiguredHarnessId's rules come first, in its order,
 * as deployment checks them first (requireConsistentModelPolicy): the agents shape, each model
 * selection's form and fallback provider, the rules for values the document sets that conflict
 * (an entry primary, agents.*.models, provider catalog rows, runtime policies and ids; findings
 * 3019 and 3020), then the OpenClaw Gateway's. A draft without a model, or a model without its
 * required runtime, saves; deployment refuses it. Rules that depend on the topology, such as
 * dedicated OpenClaw serving the main Agent, stay at deployment because a Configuration does not
 * fix one. A Preset save runs the shape, selection and Gateway rules (finding 1308), with
 * `options` locating its unfilled variables: a model, row or runtime that waits on a variable
 * names no value yet, so the Configuration a launch creates gets the rest.
 */
export function requireDeployableRoster(
  values: OpenClawConfigurationDocument,
  options?: ConfigurationValidationOptions,
): void {
  if (options?.unresolved === undefined) {
    requireConsistentModelPolicy(values);
  } else {
    requireAgentsShape(values);
    requireModelSelections(values, options);
  }
  requireOpenClawRoster(values, options);
}
