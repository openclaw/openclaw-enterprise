import { DriverConfigurationDescriptorSchema } from "./driver-configurations.ts";
import { Type } from "typebox";
import { AgentId, NamespaceId, RevisionId, Meta } from "./common.ts";
import {
  ProtectedDownloadDestinationSchema,
  ProtectedDownloadDestinationsSchema,
  SandboxNetworkGrantSchema,
  SandboxNetworkGrantsSchema,
} from "../sandbox-policy.ts";

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

export const SandboxPolicyVersion = Type.Integer({ minimum: 1, maximum: 2147483647 });
const DownloadAction = Type.Union([
  Type.Literal("approve-and-enable"),
  Type.Literal("enable"),
  Type.Literal("disable"),
  Type.Literal("withdraw-approval"),
]);
const DownloadChange = Type.Object(
  { action: DownloadAction, destination: ProtectedDownloadDestinationSchema },
  { additionalProperties: false },
);
export type ProtectedDownloadEdit = Type.Static<typeof DownloadChange>;
const ordinaryApplication = Type.Object(
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
export const SandboxPolicyApplicationSchema = Type.Union([
  ordinaryApplication,
  Type.Object(
    {
      ...ordinaryApplication.properties,
      kind: Type.Literal("protected_downloads"),
      ...DownloadChange.properties,
    },
    { additionalProperties: false },
  ),
]);
const appliedFields = {
  revisionId: RevisionId,
  policyVersion: SandboxPolicyVersion,
  providerVersion: Type.String(),
  appliedAt: Type.String(),
};
export const SandboxPolicySchema = Type.Object(
  {
    id: Type.String({ pattern: "^sbp_[0-9a-f-]{36}$" }),
    namespaceId: NamespaceId,
    agentId: AgentId,
    version: SandboxPolicyVersion,
    additions: SandboxNetworkGrantsSchema,
    application: Type.Optional(SandboxPolicyApplicationSchema),
    applied: Type.Optional(
      Type.Union([
        Type.Object(appliedFields, { additionalProperties: false }),
        Type.Object(
          {
            ...appliedFields,
            kind: Type.Literal("protected_downloads"),
            operationId: Type.String({ format: "uuid" }),
            confirmedDownloadDestinations: ProtectedDownloadDestinationsSchema,
          },
          { additionalProperties: false },
        ),
      ]),
    ),
    approvedDownloadDestinations: Type.Optional(ProtectedDownloadDestinationsSchema),
    downloadDestinations: Type.Optional(ProtectedDownloadDestinationsSchema),
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
        policy: Type.Object(
          {
            ...SandboxPolicySchema.properties,
            approvedDownloadDestinations: ProtectedDownloadDestinationsSchema,
            downloadDestinations: ProtectedDownloadDestinationsSchema,
          },
          { additionalProperties: false },
        ),
        configuration: Type.Optional(DriverConfigurationDescriptorSchema),
        editingEnabled: Type.Boolean(),
        protectedExecution: Type.Boolean({
          description:
            "True while the active revision or the next deploy runs under protected execution. Saving network policy additions is then refused with SANDBOX_POLICY_PROTECTED_EXECUTION; saving an empty policy stays allowed.",
        }),
        protectedDownloads: Type.Optional(
          Type.Union(
            [
              Type.Object(
                {
                  state: Type.Literal("unavailable"),
                  reason: Type.Union([
                    Type.Literal("installation-disabled"),
                    Type.Literal("no-active-protected-revision"),
                    Type.Literal("unsupported-driver-pair"),
                    Type.Literal("installation-unconfirmed"),
                  ]),
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  state: Type.Literal("verified"),
                  revisionId: RevisionId,
                  canApprove: Type.Boolean(),
                },
                { additionalProperties: false },
              ),
            ],
            {
              description:
                "Protected download checks for the active revision. Verification does not grant access.",
            },
          ),
        ),
        ceiling: SandboxNetworkGrantsSchema,
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
              "Why per-Agent network policy is unavailable, when capability is null: the sentence the save, validate, apply and editing refusals give.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);
export type SandboxPolicyMutationWire = Type.Static<typeof SandboxPolicyResponse>["data"];
export type SandboxPolicyViewWire = Type.Static<typeof SandboxPolicyViewResponse>["data"];

export const SandboxPolicyUpdateBody = Type.Object(
  { expectedVersion: SandboxPolicyVersion, additions: SandboxNetworkGrantsSchema },
  { additionalProperties: false },
);
export const SandboxPolicyValidateBody = Type.Object(
  { expectedVersion: SandboxPolicyVersion, additions: Type.Unknown() },
  { additionalProperties: false },
);
export const SandboxPolicyApplyBody = Type.Union([
  Type.Object(
    {
      expectedVersion: SandboxPolicyVersion,
      revisionId: RevisionId,
      additions: Type.Optional(SandboxNetworkGrantsSchema),
    },
    {
      additionalProperties: false,
      description:
        "Omit additions to apply the saved version. Supply the complete additions array (empty to clear) to save the next version and queue its application in one transaction.",
    },
  ),
  Type.Object(
    {
      expectedVersion: SandboxPolicyVersion,
      revisionId: RevisionId,
      downloadChange: DownloadChange,
    },
    { additionalProperties: false },
  ),
]);
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
