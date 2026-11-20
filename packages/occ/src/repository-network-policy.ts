import { types } from "node:util";
import type {
  RepositoryNetworkGrant,
  RepositoryNetworkPolicyCeiling,
} from "@openclaw-enterprise/contracts";

export type RepositoryGrantPolicy = {
  repositoryNetworkPolicyAllows?(input: {
    readonly namespaceId: string;
    readonly grant: RepositoryNetworkGrant;
  }): boolean;
};

type RepositoryGrantAuthority = {
  readonly allows: (grant: RepositoryNetworkGrant) => boolean;
  readonly unchanged: () => boolean;
};

function synchronouslyApproved(value: unknown): boolean {
  if (types.isPromise(value)) {
    // Observe a native rejection without invoking the Driver's own then method.
    void Promise.prototype.then.call(value, undefined, () => undefined);
  }
  return value === true;
}

export function repositoryGrantAuthority(
  namespaceId: string,
  policy: RepositoryGrantPolicy | undefined,
  ownerUnchanged: (() => boolean) | undefined,
): RepositoryGrantAuthority | undefined {
  const allows = policy?.repositoryNetworkPolicyAllows;
  if (!policy || typeof allows !== "function" || !ownerUnchanged?.()) {
    return undefined;
  }
  return {
    allows: (grant) => synchronouslyApproved(allows.call(policy, { namespaceId, grant })),
    unchanged: () => ownerUnchanged() && policy.repositoryNetworkPolicyAllows === allows,
  };
}

export function delegatedRepositoryCeiling(
  ceiling: RepositoryNetworkPolicyCeiling,
  owner: RepositoryGrantAuthority | undefined,
): RepositoryNetworkPolicyCeiling {
  if (!owner) {
    return [];
  }
  const grants = ceiling.flatMap((grant) => {
    if (owner.allows(grant)) {
      return [grant];
    }
    const read = { repository: grant.repository, access: "read" } as const;
    return grant.access === "write" && owner.allows(read) ? [read] : [];
  });
  return owner.unchanged() ? grants : [];
}
