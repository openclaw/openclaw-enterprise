import test from "node:test";
import { requiresPostgres } from "../helpers/postgres-database.mjs";
import {
  originalUnitPolicy,
  policyReadsPerUnit,
  listAgentPolicyCost,
} from "./postgres-namespace-iam-policy-read-cases.ts";
import {
  atomicBindingAudit,
  agentServicePrincipalOwnership,
  auditRollback,
  namespaceRolePermissions,
  namespaceLocalServiceIdentity,
  exactRevisionBinding,
  invalidBindings,
} from "./postgres-namespace-iam-binding-cases.ts";
import {
  grantBeforeTargetDeletion,
  targetDeletionBeforeGrant,
  grantBeforeNamespaceDeletion,
} from "./postgres-namespace-iam-deletion-cases.ts";
import {
  grantAndRevokeHumanAccess,
  consoleShareScope,
} from "./postgres-namespace-iam-human-access-cases.ts";
import { actorAuthorityThroughCommit } from "./postgres-namespace-iam-authority-cases.ts";

test(
  "selected native IAM sees original-unit grants and revocations before rollback",
  requiresPostgres,
  originalUnitPolicy,
);
test(
  "PostgreSQL native IAM creates exact Namespace bindings atomically with audit",
  requiresPostgres,
  atomicBindingAudit,
);
test(
  "PostgreSQL native IAM binds Agent ServicePrincipals only while their Agent owns them",
  requiresPostgres,
  agentServicePrincipalOwnership,
);
test(
  "PostgreSQL native IAM serializes AccessBinding creation before target deletion",
  requiresPostgres,
  grantBeforeTargetDeletion,
);
test(
  "PostgreSQL native IAM serializes target deletion before AccessBinding creation",
  requiresPostgres,
  targetDeletionBeforeGrant,
);
test(
  "PostgreSQL native IAM rolls back policy mutations when transaction audit fails",
  requiresPostgres,
  auditRollback,
);
test(
  "PostgreSQL native IAM grants and revokes existing human access to exact Namespace and Agent targets",
  requiresPostgres,
  grantAndRevokeHumanAccess,
);
test(
  "PostgreSQL native IAM confines Console share grants to the shared Agent and Namespace discovery",
  requiresPostgres,
  consoleShareScope,
);
test(
  "PostgreSQL native IAM grants Namespace Roles only Namespace read",
  requiresPostgres,
  namespaceRolePermissions,
);
test(
  "PostgreSQL exact Namespace grants serialize with Namespace deletion",
  requiresPostgres,
  grantBeforeNamespaceDeletion,
);
test(
  "PostgreSQL native IAM authorizes Namespace-local service identities without Agent ownership",
  requiresPostgres,
  namespaceLocalServiceIdentity,
);
test(
  "PostgreSQL native IAM creates exact AgentRevision bindings with limited app privileges",
  requiresPostgres,
  exactRevisionBinding,
);
test(
  "PostgreSQL native IAM rejects foreign subjects, broad grants, and absent targets",
  requiresPostgres,
  invalidBindings,
);
test(
  "PostgreSQL IAM policy writes keep the actor's authority current through COMMIT",
  requiresPostgres,
  actorAuthorityThroughCommit,
);
test(
  "native IAM reads the policy once per unit of work and never across units",
  requiresPostgres,
  policyReadsPerUnit,
);
test(
  "listing 2000 Agents reads the policy once for the whole list",
  requiresPostgres,
  listAgentPolicyCost,
);
