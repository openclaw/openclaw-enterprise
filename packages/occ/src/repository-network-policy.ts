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

type RepositoryGrantMethod = NonNullable<RepositoryGrantPolicy["repositoryNetworkPolicyAllows"]>;

function repositoryGrantMethod(policy: RepositoryGrantPolicy): RepositoryGrantMethod | undefined {
  // Inspect the first definition without invoking an accessor or a Proxy trap.
  for (let owner: object | null = policy; owner; owner = Reflect.getPrototypeOf(owner)) {
    if (types.isProxy(owner)) {
      return undefined;
    }
    const descriptor: TypedPropertyDescriptor<RepositoryGrantMethod> | undefined =
      Object.getOwnPropertyDescriptor(owner, "repositoryNetworkPolicyAllows");
    if (descriptor) {
      if (!Object.hasOwn(descriptor, "value")) {
        return undefined;
      }
      const method = descriptor.value;
      return typeof method === "function" && !types.isProxy(method) ? method : undefined;
    }
  }
  return undefined;
}

type RepositoryGrantAuthority = {
  readonly allows: (grant: RepositoryNetworkGrant) => boolean;
  readonly approvesAll: (grants: readonly RepositoryNetworkGrant[]) => boolean;
  readonly unchanged: () => boolean;
};

function synchronouslyApproved(value: unknown): boolean {
  if (types.isPromise(value)) {
    // Observe a native rejection without invoking the Driver's own then method.
    void Promise.prototype.then.call(value, undefined, () => undefined);
  }
  return value === true;
}

function verified(check: () => boolean): boolean {
  try {
    return check();
  } catch {
    return false;
  }
}

export function repositoryGrantAuthority(
  namespaceId: string,
  policy: RepositoryGrantPolicy | undefined,
  ownerUnchanged: (() => boolean) | undefined,
): RepositoryGrantAuthority | undefined {
  try {
    if (!policy || !ownerUnchanged?.()) {
      return undefined;
    }
    const allows = repositoryGrantMethod(policy);
    if (!allows) {
      return undefined;
    }
    const approve = (grant: RepositoryNetworkGrant) =>
      synchronouslyApproved(Reflect.apply(allows, policy, [{ namespaceId, grant }]));
    return {
      // Ceiling filtering must distinguish a denial (try read) from a throw (discard all).
      allows: approve,
      approvesAll: (grants) => verified(() => grants.every(approve)),
      unchanged: () => verified(() => ownerUnchanged() && repositoryGrantMethod(policy) === allows),
    };
  } catch {
    return undefined;
  }
}

export function delegatedRepositoryCeiling(
  ceiling: RepositoryNetworkPolicyCeiling,
  owner: RepositoryGrantAuthority | undefined,
): RepositoryNetworkPolicyCeiling {
  if (!owner) {
    return [];
  }
  try {
    const grants = ceiling.flatMap((grant) => {
      if (owner.allows(grant)) {
        return [grant];
      }
      const read = Object.freeze({ repository: grant.repository, access: "read" } as const);
      return grant.access === "write" && owner.allows(read) ? [read] : [];
    });
    return owner.unchanged() ? grants : [];
  } catch {
    // Keep saved grants readable for withdrawal if delegated approvals cannot be checked.
    return [];
  }
}
