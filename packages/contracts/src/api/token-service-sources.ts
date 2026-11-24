import { Type } from "typebox";

import {
  ConnectionTemplateId,
  CredentialSourceConfig,
  Name,
  RepositoryBindingRequestSchema,
  SecretValue,
} from "./common.ts";
import { OAuthClientId } from "./connection-templates.ts";

const material = Type.Record(Type.String(), SecretValue, {
  minProperties: 1,
  maxProperties: 1,
  writeOnly: true,
  description:
    "Write-only: one opaque credential value. The field name does not grant destination authority.",
});

const managedConfig = {
  ...CredentialSourceConfig,
  description:
    "Non-secret configuration. provider_preset selects an approved model operation: openai or codex-pat.",
};

export const RegisterTokenServiceSourceBody = Type.Object(
  {
    name: Name,
    type: Type.Literal("static"),
    config: Type.Optional(managedConfig),
    connectionTemplateId: Type.Optional(ConnectionTemplateId),
    secret: material,
  },
  {
    $id: "RegisterTokenServiceSourceBody",
    additionalProperties: false,
    description:
      "Register a managed static Source. Optionally supply connectionTemplateId. OCC validates the approved static Template before TokenService takes custody.",
  },
);

export const RegisterGitHubAppTokenServiceSourceBody = Type.Object(
  {
    name: Name,
    type: Type.Literal("github-app-installation"),
    clientId: {
      ...OAuthClientId,
      description: "OCC registration ID of the GitHub App client.",
    },
    repositoryRefs: Type.Array(RepositoryBindingRequestSchema.properties.repositoryRef, {
      minItems: 1,
      maxItems: 16,
      uniqueItems: true,
      description: "Repository references approved for this Namespace in the GitHub registry.",
    }),
  },
  {
    $id: "RegisterGitHubAppTokenServiceSourceBody",
    additionalProperties: false,
    description:
      "Register a GitHub App installation Source. Select a registered App client. The Installation's GitHub registry verifies the App and supplies the installation and permissions for the selected repositories. Agent access requires a separate grant.",
  },
);

export const UpdateTokenServiceSourceBody = Type.Object(
  { config: Type.Optional(managedConfig), secret: Type.Optional(material) },
  {
    $id: "UpdateTokenServiceSourceBody",
    minProperties: 1,
    additionalProperties: false,
    description:
      "Update a managed static Source through its persisted owner. Supply at least one of config or secret. Omitted fields retain their values. An effective provider_preset change or removal combined with replacement credential material returns 409 RESOURCE_CONFLICT. Repeating the current preset with replacement material is allowed.",
  },
);

export type RegisterTokenServiceSourceBody = Type.Static<typeof RegisterTokenServiceSourceBody>;
export type UpdateTokenServiceSourceBody = Type.Static<typeof UpdateTokenServiceSourceBody>;
