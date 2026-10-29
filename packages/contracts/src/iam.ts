import type { Driver } from "./driver.ts";
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
} from "./index.ts";

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
}

export interface IAMPolicyRepository extends IAMPolicyReadRepository {
  createRole(role: Role): Promise<Readonly<Role>>;
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

/** A non-Agent automation identity fixed to one Namespace; it carries no grant. */
export interface IAMManagedServicePrincipalInput {
  readonly id: string;
  readonly namespaceId: string;
}
