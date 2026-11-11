import { Type } from "typebox";
import {
  ConfigurationId,
  RevisionId,
  Meta,
  ConfigurationValues,
  SecretBindings,
  HarnessAuthBindingSchema,
  InstallationId,
  NamespaceId,
} from "./common.ts";

export const NamespaceIdentityResponse = Type.Object(
  {
    data: Type.Object(
      { installationId: InstallationId, namespaceId: NamespaceId },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

const sourceId = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9._:/~-]{0,511}$" });
const version = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });

export const AgentManagementApplyBody = Type.Object(
  {
    sourceGeneration: version,
    sourceId,
    expectedVersion: version,
    requestKey: Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._~-]+$" }),
    desiredRuntimeState: Type.Union([Type.Literal("running"), Type.Literal("stopped")]),
    configuration: Type.Object(
      { values: ConfigurationValues, secretBindings: Type.Optional(SecretBindings) },
      { additionalProperties: false },
    ),
    harnessAuth: Type.Optional(HarnessAuthBindingSchema),
    forceDeployment: Type.Optional(Type.Boolean()),
    retryNonce: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._~-]+$" }),
    ),
    nativeAdmin: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const AgentManagementAdoptionBody = Type.Object(
  {
    sourceId,
    expectedConfigurationId: ConfigurationId,
    expectedConfigurationGeneration: version,
    expectedActiveRevisionId: Type.Optional(RevisionId),
    expectedFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    expectedManagementVersion: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  },
  { additionalProperties: false },
);

export const AgentManagementReleaseBody = Type.Object(
  { sourceId, expectedVersion: version },
  { additionalProperties: false },
);

export const AgentManagementResponse = Type.Object(
  {
    data: Type.Object(
      {
        management: Type.Union([
          Type.Null(),
          Type.Object(
            {
              sourceId,
              principalId: Type.String({ minLength: 1, maxLength: 256 }),
              version,
              suspended: Type.Boolean(),
              released: Type.Boolean(),
              requestedRevisionId: Type.Optional(RevisionId),
            },
            { additionalProperties: false },
          ),
        ]),
        adoption: Type.Object(
          {
            configurationId: ConfigurationId,
            configurationGeneration: version,
            activeRevisionId: Type.Optional(RevisionId),
            fingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);
