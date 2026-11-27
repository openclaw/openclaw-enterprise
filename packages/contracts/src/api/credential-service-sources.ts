import { Type } from "typebox";

import {
  ConnectionTemplateId,
  CredentialSourceConfig,
  Name,
  RepositoryBindingRequestSchema,
  SecretValue,
} from "./common.ts";
import { CredentialClientId } from "./connection-templates.ts";

const material = { ...SecretValue, writeOnly: true, description: "Opaque credential value." };

const managedConfig = {
  ...CredentialSourceConfig,
  description:
    "Non-secret configuration. provider_preset selects an approved model operation: openai or codex-pat.",
};

export const RegisterCredentialServiceSourceBody = Type.Object(
  {
    name: Name,
    type: Type.Literal("static"),
    config: Type.Optional(managedConfig),
    connectionTemplateId: Type.Optional(ConnectionTemplateId),
    secret: material,
  },
  {
    $id: "RegisterCredentialServiceSourceBody",
    additionalProperties: false,
    description:
      "Register a managed static Source. Optionally supply connectionTemplateId. OCC validates the approved static Template before CredentialService takes custody.",
  },
);

export const RegisterGitHubAppCredentialServiceSourceBody = Type.Object(
  {
    name: Name,
    type: Type.Literal("github-app-installation"),
    clientId: {
      ...CredentialClientId,
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
    $id: "RegisterGitHubAppCredentialServiceSourceBody",
    additionalProperties: false,
    description:
      "Register a GitHub App installation Source. Select a registered App client. The Installation's GitHub registry verifies the App and supplies the installation and permissions for the selected repositories. Agent access requires a separate grant.",
  },
);

export const UpdateCredentialServiceSourceBody = Type.Object(
  { config: Type.Optional(managedConfig), secret: Type.Optional(material) },
  {
    $id: "UpdateCredentialServiceSourceBody",
    minProperties: 1,
    additionalProperties: false,
    description:
      "Update a managed static Source through its persisted owner. Supply at least one of config or secret. Omitted fields retain their values. An effective provider_preset change or removal combined with replacement credential material returns 409 RESOURCE_CONFLICT. Repeating the current preset with replacement material is allowed.",
  },
);

export type RegisterCredentialServiceSourceBody = Type.Static<
  typeof RegisterCredentialServiceSourceBody
>;
export type UpdateCredentialServiceSourceBody = Type.Static<
  typeof UpdateCredentialServiceSourceBody
>;
