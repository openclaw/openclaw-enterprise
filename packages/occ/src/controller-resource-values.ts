import type { ResourceKind } from "@openclaw-enterprise/contracts";
import { isNonEmptyString } from "@openclaw-enterprise/utils";

import { ScopeViolationError } from "./errors.ts";

const resourceIdPrefixes = {
  installation: "ins",
  namespace: "ns",
  configuration: "cfg",
  preset: "pre",
  service_account: "sa",
  secret: "sec",
  agent: "agt",
  agent_revision: "rev",
  credential_source: "cs",
  sandbox_policy: "sbp",
} as const satisfies Record<ResourceKind, string>;

export function createControllerResourceValues(
  now: () => Date,
  createId: ((kind: ResourceKind) => string) | undefined,
) {
  function nextIdentifier(kind: ResourceKind): string {
    const result = createId ? createId(kind) : `${resourceIdPrefixes[kind]}_${crypto.randomUUID()}`;
    if (!isNonEmptyString(result)) {
      throw new ScopeViolationError("The server generated an invalid resource identity.");
    }
    return result;
  }

  function timestamp(): string {
    const date = now();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      throw new ScopeViolationError("The controller clock returned an invalid timestamp.");
    }
    return date.toISOString();
  }

  return { now, nextIdentifier, timestamp };
}

export type ControllerResourceValues = ReturnType<typeof createControllerResourceValues>;
