import { Type } from "typebox";
import { ErrorDetail, Meta } from "./common.ts";

const ConfigurationAction = Type.Object(
  {
    method: Type.Union([Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT")]),
    href: Type.String({ pattern: "^/[^/]", maxLength: 2048 }),
    available: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const DriverConfigurationDescriptorSchema = Type.Object(
  {
    capability: Type.String(),
    driverId: Type.String(),
    implementation: Type.String(),
    scope: Type.Union([Type.Literal("installation"), Type.Literal("agent")]),
    key: Type.String(),
    configurationSchema: Type.Record(Type.String(), Type.Unknown()),
    startupConfiguration: Type.Optional(Type.Record(Type.String(), Type.Ref("SafeJsonValue"))),
    binding: Type.Union([Type.Literal("installation-startup"), Type.Literal("sandbox-policy")]),
    actions: Type.Object(
      {
        read: Type.Optional(ConfigurationAction),
        validate: Type.Optional(ConfigurationAction),
        save: Type.Optional(ConfigurationAction),
        apply: Type.Optional(ConfigurationAction),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export const DriverConfigurationsResponse = Type.Object(
  {
    data: Type.Object(
      { configurations: Type.Array(DriverConfigurationDescriptorSchema) },
      { additionalProperties: false },
    ),
    meta: Meta,
  },
  { additionalProperties: false },
);

export const ConfigurationValidationResponse = Type.Object(
  {
    data: Type.Union([
      Type.Object(
        { success: Type.Literal(true), data: Type.Unknown() },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          success: Type.Literal(false),
          error: Type.Object(
            {
              details: Type.Array(ErrorDetail, { minItems: 1, maxItems: 32 }),
            },
            { additionalProperties: false },
          ),
        },
        { additionalProperties: false },
      ),
    ]),
    meta: Meta,
  },
  { additionalProperties: false },
);
