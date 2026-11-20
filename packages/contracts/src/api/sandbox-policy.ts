import { DriverConfigurationDescriptorSchema } from "./driver-configurations.ts";
import { Type } from "typebox";
import { AgentId, NamespaceId, RevisionId, Meta } from "./common.ts";
import {
  maxRepositoryNetworkGrants,
  repositoryNetworkGrantPattern,
} from "../repository-network-policy.ts";
import { SandboxNetworkGrantSchema, SandboxNetworkGrantsSchema } from "../sandbox-policy.ts";

export const SandboxPolicyParams = Type.Object(
  {
    namespaceId: NamespaceId,
    agentId: AgentId,
    facet: Type.Union([
      Type.Literal("networking"),
      Type.Literal("filesystem"),
      Type.Literal("process"),
    ]),
  },
  { additionalProperties: false },
);
export const SandboxPolicyRevisionParams = Type.Object(
  { ...SandboxPolicyParams.properties, revisionId: RevisionId },
  { additionalProperties: false },
);

const RepositoryNetworkGrantSchema = Type.Object(
  {
    repository: Type.String({
      pattern: repositoryNetworkGrantPattern.source,
      description: "Canonical lowercase GitHub owner/name without a .git suffix.",
      not: { type: "string", pattern: "\\.git$|\\s" },
    }),
    access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
  },
  { additionalProperties: false },
);

export const SandboxPolicyVersion = Type.Integer({ minimum: 1, maximum: 2147483647 });
export const SandboxPolicyApplicationSchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    revisionId: RevisionId,
    policyVersion: SandboxPolicyVersion,
    state: Type.Union([Type.Literal("pending"), Type.Literal("applied"), Type.Literal("failed")]),
    requestedBy: Type.String(),
    requestedAt: Type.String(),
    providerVersion: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export const SandboxPolicySchema = Type.Object(
  {
    id: Type.String({ pattern: "^sbp_[0-9a-f-]{36}$" }),
    namespaceId: NamespaceId,
    agentId: AgentId,
    version: SandboxPolicyVersion,
    additions: SandboxNetworkGrantsSchema,
    repositoryNetworkPolicy: Type.Optional(
      Type.Array(RepositoryNetworkGrantSchema, {
        description: "Saved repository grants. An empty array denies all repositories.",
        maxItems: maxRepositoryNetworkGrants,
      }),
    ),
    application: Type.Optional(SandboxPolicyApplicationSchema),
    applied: Type.Optional(
      Type.Object(
        {
          revisionId: RevisionId,
          policyVersion: SandboxPolicyVersion,
          providerVersion: Type.String(),
          appliedAt: Type.String(),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const SandboxPolicyResponse = Type.Object(
  { data: SandboxPolicySchema, meta: Meta },
  { additionalProperties: false },
);
export const SandboxPolicyViewResponse = Type.Object(
  {
    data: Type.Object(
      {
        policy: SandboxPolicySchema,
        configuration: Type.Optional(DriverConfigurationDescriptorSchema),
        editingEnabled: Type.Boolean(),
        protectedExecution: Type.Boolean({
          description:
            "True while the active revision or the next deploy runs under protected execution. Saving nonempty additions then returns SANDBOX_POLICY_PROTECTED_EXECUTION. The current Sandbox and Compute pair must admit a first nonempty repository list or a nonempty replacement. Send empty arrays for additions and repositoryNetworkPolicy to withdraw an existing list. Omit repositoryNetworkPolicy to clear additions alone.",
        }),
        ceiling: SandboxNetworkGrantsSchema,
        repositoryNetworkPolicyCeiling: Type.Array(RepositoryNetworkGrantSchema, {
          description:
            "Repository access levels the current policy owner approved for this Namespace when the view was generated. PUT checks each exact requested access level independently.",
          maxItems: maxRepositoryNetworkGrants,
        }),
        repositoryNetworkPolicySaveSupported: Type.Boolean({
          description:
            "Whether a saved list can be withdrawn or the protected topology supports a nonempty save.",
        }),
        repositoryNetworkPolicyEditableGrants: Type.Optional(
          Type.Array(RepositoryNetworkGrantSchema, {
            description:
              "Repository and access choices admitted individually for this Agent. A repository can have both read and write choices. Omitted when no choice is available. PUT rechecks the complete requested list.",
            maxItems: maxRepositoryNetworkGrants * 2,
            uniqueItems: true,
          }),
        ),
        defaults: Type.Union([Type.Null(), Type.Record(Type.String(), Type.Unknown())]),
        defaultsRevisionId: Type.Optional(RevisionId),
        deployedPolicyVersion: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: 2147483647,
            description:
              "The saved policy version the active revision (defaultsRevisionId) was deployed with. Its Sandbox enforces that version without a live application.",
          }),
        ),
        capability: Type.Union([
          Type.Null(),
          Type.Object(
            { wildcards: Type.Boolean(), portRanges: Type.Boolean(), live: Type.Boolean() },
            { additionalProperties: false },
          ),
        ]),
        unavailableReason: Type.Optional(
          Type.String({
            description:
              "Why per-Agent network policy is unavailable when capability is null. An authorized administrator can still enable editing to withdraw an existing repository list.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);
export type SandboxPolicyViewWire = Type.Static<typeof SandboxPolicyViewResponse>["data"];

export const SandboxPolicyUpdateBody = Type.Object(
  {
    expectedVersion: SandboxPolicyVersion,
    additions: SandboxNetworkGrantsSchema,
    repositoryNetworkPolicy: Type.Optional(
      Type.Array(RepositoryNetworkGrantSchema, {
        description:
          "Omit to preserve the saved grants. A first list must be nonempty. A first list or nonempty replacement requires an admitted protected topology and empty additions. Send empty arrays for both fields to withdraw an existing list even if the current Driver pair is unsupported.",
        maxItems: maxRepositoryNetworkGrants,
      }),
    ),
  },
  { additionalProperties: false },
);
export const SandboxPolicyValidateBody = Type.Object(
  { expectedVersion: SandboxPolicyVersion, additions: Type.Unknown() },
  { additionalProperties: false },
);
export const SandboxPolicyApplyBody = Type.Object(
  {
    expectedVersion: SandboxPolicyVersion,
    revisionId: RevisionId,
    additions: Type.Optional(SandboxNetworkGrantsSchema),
  },
  {
    additionalProperties: false,
    description:
      "Omit additions to apply the saved version. Supply the complete additions array (empty to clear) to save the next version and queue its application in one transaction. This operation returns HTTP 409 when the saved policy or active Agent revision has a repository network policy. Applying the saved repository policy requires a deployment that can enforce it. If the policy is present only on the active revision, stop the Agent and confirm that its workload has stopped before investigating the mismatch.",
  },
);
export const SandboxPolicyEditingBody = Type.Object(
  { enabled: Type.Boolean() },
  { additionalProperties: false },
);
export const SandboxPolicyRecommendationsResponse = Type.Object(
  {
    data: Type.Object(
      {
        recommendations: Type.Array(
          Type.Object(
            {
              id: Type.String(),
              status: Type.Union([
                Type.Literal("pending"),
                Type.Literal("approved"),
                Type.Literal("rejected"),
              ]),
              grant: SandboxNetworkGrantSchema,
              observations: Type.Optional(Type.Integer({ minimum: 0 })),
            },
            { additionalProperties: false },
          ),
          { maxItems: 32 },
        ),
        truncated: Type.Boolean(),
        providerVersion: Type.Optional(Type.String({ maxLength: 128 })),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);
