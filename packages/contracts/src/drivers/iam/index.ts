import type { Driver } from "../index.ts";
import type {
  AccessBinding,
  AuthorizationDecision,
  AuthorizationRequest,
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
  /** Principal ids in one Installation-level Group, such as Default users. */
  listGroupMembers?(context: IAMPolicyReadContext, groupId: string): Promise<readonly string[]>;
  /** False when the Principal is already a member. */
  addGroupMember?(
    context: IAMPolicyManagementContext,
    input: IAMGroupMemberInput,
  ): Promise<boolean>;
  /** False when the Principal was not a member. */
  removeGroupMember?(
    context: IAMPolicyManagementContext,
    input: IAMGroupMemberInput,
  ): Promise<boolean>;
  /**
   * Binds a creator to the built-in Owner Role: Namespace-wide for a Namespace, exact for any
   * other resource. A Driver without this member grants creators nothing.
   */
  createOwnerBinding?(
    context: IAMPolicyManagementContext,
    input: IAMOwnerBindingInput,
  ): Promise<Readonly<AccessBinding>>;
  /** Writes or deletes one built-in Default users binding. False when nothing changed. */
  setDefaultUsersBinding?(
    context: IAMPolicyManagementContext,
    input: IAMDefaultUsersBindingInput,
  ): Promise<boolean>;
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
  /** Principal ids in one Installation-level Group. */
  listGroupMembers(groupId: string): Promise<readonly string[]>;
}

export interface IAMPolicyRepository extends IAMPolicyReadRepository {
  createRole(role: Role): Promise<Readonly<Role>>;
  createGroupMembership(groupId: string, principalId: string): Promise<boolean>;
  deleteGroupMembership(groupId: string, principalId: string): Promise<boolean>;
  /** Writes a binding to a built-in Role; false when its id already exists. */
  createBuiltInBinding(binding: AccessBinding): Promise<boolean>;
  /** Deletes a binding to a built-in Role; false when it did not exist. */
  deleteBuiltInBinding(bindingId: string): Promise<boolean>;
  deleteRole(namespaceId: string, roleId: string): Promise<boolean>;
  createAccessBinding(binding: AccessBinding): Promise<Readonly<AccessBinding>>;
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
  readonly resourceKind: ManagedIAMResourceKind;
  readonly resourceId: string;
}

export interface IAMGroupMemberInput {
  readonly groupId: string;
  readonly principalId: string;
}

export interface IAMOwnerBindingInput {
  readonly id: string;
  readonly namespaceId: string;
  readonly principalId: string;
  /** The created resource; a Namespace takes no resource and gets a Namespace-wide binding. */
  readonly resourceKind?: ResourceKind;
  readonly resourceId?: string;
}

/**
 * Agent Creator binds Default users in one Namespace (`namespaceId` required); Namespace
 * Creator binds them Installation-wide (no `namespaceId`).
 */
export type IAMDefaultUsersBindingInput =
  | {
      readonly role: "agentCreator";
      readonly namespaceId: string;
      readonly bound: boolean;
    }
  | {
      readonly role: "namespaceCreator";
      readonly bound: boolean;
    };

/** A non-Agent automation identity fixed to one Namespace; it carries no grant. */
export interface IAMManagedServicePrincipalInput {
  readonly id: string;
  readonly namespaceId: string;
}
