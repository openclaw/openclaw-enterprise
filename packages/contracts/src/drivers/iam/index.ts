import type { Driver } from "../index.ts";
import type {
  AccessBinding,
  AuthorizationDecision,
  RuntimeAccessDecision,
  AuthorizationRequest,
  Group,
  Identity,
  IdentityAccessCoverageRequest,
  IdentityLookup,
  Permission,
  ResourceKind,
  Restriction,
  Role,
  ServicePrincipal,
} from "../../index.ts";

export interface IAMDriver extends Driver {
  readonly capability: "iam";
  /** Namespace writes require participation in the caller's policy-and-audit transaction. */
  readonly namespacePolicyTransaction?: "platform-unit-of-work";
  lookupIdentity(input: IdentityLookup): Promise<Identity | undefined>;
  authorize(request: AuthorizationRequest): Promise<AuthorizationDecision>;
  /** Resolve entry permission and its exact human runtime assignment from one policy snapshot. */
  authorizeRuntimeAccess?(request: AuthorizationRequest): Promise<RuntimeAccessDecision>;
  /**
   * True only when `principalId` holds every grant of `targetIdentityId` at the
   * same or a broader scope. Credential issuance for another identity requires it;
   * a Driver without it cannot issue such credentials.
   */
  coversIdentityAccess?(request: IdentityAccessCoverageRequest): Promise<boolean>;
  listNamespaceRoles?(
    context: IAMPolicyReadContext,
    namespaceId: string,
  ): Promise<readonly Readonly<Role>[]>;
  getNamespaceRole?(
    context: IAMPolicyReadContext,
    namespaceId: string,
    roleId: string,
  ): Promise<Readonly<Role> | undefined>;
  createNamespaceRole?(
    context: IAMPolicyManagementContext,
    input: IAMManagedRoleInput,
  ): Promise<Readonly<Role>>;
  deleteNamespaceRole?(
    context: IAMPolicyManagementContext,
    namespaceId: string,
    roleId: string,
  ): Promise<boolean>;
  listNamespaceAccessBindings?(
    context: IAMPolicyReadContext,
    namespaceId: string,
  ): Promise<readonly Readonly<AccessBinding>[]>;
  getNamespaceAccessBinding?(
    context: IAMPolicyReadContext,
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding> | undefined>;
  createNamespaceAccessBinding?(
    context: IAMPolicyManagementContext,
    input: IAMManagedAccessBindingInput,
  ): Promise<Readonly<AccessBinding>>;
  updateNamespaceRuntimeRole?(
    context: IAMPolicyManagementContext,
    namespaceId: string,
    bindingId: string,
    runtimeRole: string,
  ): Promise<Readonly<AccessBinding> | undefined>;
  deleteNamespaceAccessBinding?(
    context: IAMPolicyManagementContext,
    namespaceId: string,
    bindingId: string,
  ): Promise<boolean>;
  listNamespaceServicePrincipals?(
    context: IAMPolicyReadContext,
    namespaceId: string,
  ): Promise<readonly Readonly<ServicePrincipal>[]>;
  getNamespaceServicePrincipal?(
    context: IAMPolicyReadContext,
    namespaceId: string,
    servicePrincipalId: string,
  ): Promise<Readonly<ServicePrincipal> | undefined>;
  createNamespaceServicePrincipal?(
    context: IAMPolicyManagementContext,
    input: IAMManagedServicePrincipalInput,
  ): Promise<Readonly<ServicePrincipal>>;
  /**
   * Binds a creator to the configured Owner Role: Namespace-wide for a Namespace, exact for any
   * other resource. A Driver without this member grants creators nothing.
   */
  createOwnerBinding?(
    context: IAMPolicyManagementContext,
    input: IAMOwnerBindingInput,
  ): Promise<Readonly<AccessBinding>>;
  /**
   * Makes the configured Roles, Groups, and Group bindings in policy match `input.policy`:
   * writes the missing ones, updates changed Role permissions, and deletes configured rows that
   * the policy no longer lists. With `namespaceId`, it writes only the missing bindings in that
   * Namespace and the missing Roles and Groups they name, and changes nothing else.
   */
  applyConfiguredPolicy?(
    context: IAMPolicyManagementContext,
    input: IAMConfiguredPolicyInput,
  ): Promise<IAMConfiguredPolicyChanges>;
}

export interface IAMPolicyReadRepository {
  listRoles(namespaceId: string): Promise<readonly Readonly<Role>[]>;
  getRole(namespaceId: string, roleId: string): Promise<Readonly<Role> | undefined>;
  listAccessBindings(namespaceId: string): Promise<readonly Readonly<AccessBinding>[]>;
  getAccessBinding(
    namespaceId: string,
    bindingId: string,
  ): Promise<Readonly<AccessBinding> | undefined>;
  /**
   * Lists the deny Restrictions on these exact resources in every scope (Installation and
   * Namespace), as deleting the resources removes them. A store that keeps no Restrictions
   * (the in-memory one; its IAM driver seed holds them and no deletion removes them)
   * returns none.
   */
  listRestrictionsTargeting(
    resourceKind: ResourceKind,
    resourceIds: readonly string[],
  ): Promise<readonly Readonly<Restriction>[]>;
  /** Non-Agent ServicePrincipals of the exact Namespace; Agent identities are excluded. */
  listServicePrincipals(namespaceId: string): Promise<readonly Readonly<ServicePrincipal>[]>;
  getServicePrincipal(
    namespaceId: string,
    servicePrincipalId: string,
  ): Promise<Readonly<ServicePrincipal> | undefined>;
  /** The Roles, Groups, and bindings with configured ID prefixes. */
  listConfiguredPolicy(): Promise<IAMConfiguredPolicy>;
}

export interface IAMPolicyRepository extends IAMPolicyReadRepository {
  createRole(role: Role): Promise<Readonly<Role>>;
  /** Writes a configured Installation Role, or updates its name and permissions. */
  putConfiguredRole(role: Role): Promise<"created" | "updated" | "unchanged">;
  /** Deletes a configured Role; refuses while any binding uses it. */
  deleteConfiguredRole(roleId: string): Promise<void>;
  createConfiguredGroup(group: Group): Promise<void>;
  /** Deletes a configured Group and its memberships; refuses while any binding uses it. */
  deleteConfiguredGroup(groupId: string): Promise<void>;
  /**
   * Writes a binding that OCC owns, to a configured Role: a configured Group binding or a
   * creator's Owner binding. False when its id already exists.
   */
  createOCCBinding(binding: AccessBinding): Promise<boolean>;
  /** Deletes a configured Group binding; false when it did not exist. */
  deleteConfiguredBinding(bindingId: string): Promise<boolean>;
  deleteRole(namespaceId: string, roleId: string): Promise<boolean>;
  createAccessBinding(binding: AccessBinding): Promise<Readonly<AccessBinding>>;
  updateRuntimeRole(
    namespaceId: string,
    bindingId: string,
    runtimeRole: string,
  ): Promise<Readonly<AccessBinding> | undefined>;
  deleteAccessBinding(namespaceId: string, bindingId: string): Promise<boolean>;
  createServicePrincipal(servicePrincipal: ServicePrincipal): Promise<Readonly<ServicePrincipal>>;
}

export interface IAMPolicyReadContext {
  readonly policy: IAMPolicyReadRepository;
}

export interface IAMPolicyManagementContext {
  readonly policy: IAMPolicyRepository;
}

export type ManagedIAMResourceKind =
  | "namespace"
  | "agent"
  | "agent_revision"
  | "configuration"
  | "credential_source"
  | "sandbox_policy"
  | "preset"
  | "secret"
  | "service_account";

export interface IAMManagedRoleInput {
  readonly id: string;
  readonly namespaceId: string;
  readonly name?: string;
  readonly permissions: readonly Permission[];
}

export interface IAMManagedAccessBindingInput {
  readonly id: string;
  readonly namespaceId: string;
  readonly subjectKind: "identity";
  readonly subjectId: string;
  readonly roleId: string;
  readonly runtimeRole?: string;
  readonly resourceKind: ManagedIAMResourceKind;
  readonly resourceId: string;
}

export interface IAMOwnerBindingInput {
  readonly id: string;
  readonly namespaceId: string;
  readonly principalId: string;
  /** The configured Owner Role. */
  readonly roleId: string;
  /** The created resource; a Namespace takes no resource and gets a Namespace-wide binding. */
  readonly resourceKind?: ResourceKind;
  readonly resourceId?: string;
}

/**
 * The Roles, Groups, and Group bindings that the Installation `iam` configuration declares, with
 * configured ID prefixes and Namespace names resolved to IDs.
 */
export interface IAMConfiguredPolicy {
  readonly roles: readonly Role[];
  readonly groups: readonly Group[];
  readonly bindings: readonly AccessBinding[];
}

export interface IAMConfiguredPolicyInput {
  readonly policy: IAMConfiguredPolicy;
  /** Write only the missing bindings in this Namespace, such as a Namespace just created. */
  readonly namespaceId?: string;
}

/** What `applyConfiguredPolicy` changed, for audit. */
export interface IAMConfiguredPolicyChanges {
  readonly roles: {
    readonly created: readonly Readonly<Role>[];
    readonly updated: readonly Readonly<Role>[];
    readonly deleted: readonly string[];
  };
  readonly groups: { readonly created: readonly string[]; readonly deleted: readonly string[] };
  readonly bindings: {
    readonly created: readonly Readonly<AccessBinding>[];
    readonly deleted: readonly Readonly<AccessBinding>[];
  };
}

/** A non-Agent automation identity fixed to one Namespace; it carries no grant. */
export interface IAMManagedServicePrincipalInput {
  readonly id: string;
  readonly namespaceId: string;
}
