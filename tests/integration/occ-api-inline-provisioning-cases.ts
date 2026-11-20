import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { SecretReference } from "@openclaw-enterprise/contracts";
import { assertApiError } from "../helpers/api-error.ts";

interface InvalidPlan {
  description: string;
  body: unknown;
  message: string;
  details?: readonly { path: string; code: string }[];
}

export function invalidInlinePlans(
  requestBody: (overrides?: Record<string, unknown>) => Record<string, unknown>,
  modelRef: SecretReference,
  toolRef: SecretReference,
  foreignNamespaceId: string,
): readonly InvalidPlan[] {
  const foreignSecretId = `sec_${randomUUID()}`;
  const oversizedBindings = Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`TOOL_${index}`, { source: toolRef }]),
  );
  return [
    {
      description: "submitted Secret values",
      body: {
        ...requestBody(),
        secrets: [{ name: "tool-api-key", value: `tool-key-${randomUUID()}` }],
      },
      message:
        "The request does not match the operation contract: body /secrets is not an accepted field.",
    },
    {
      description: "request-local Secret binding sources",
      body: requestBody({
        configuration: {
          secretBindings: {
            TOOL_API_KEY: {
              source: { kind: "provisioning-secret", name: "tool-api-key" },
            },
          },
        },
      }),
      message:
        "The request does not match the operation contract: body /configuration/secretBindings/TOOL_API_KEY/source/namespaceId is required.",
    },
    {
      description: "request-local Harness Secret source",
      body: requestBody({
        harnessAuth: {
          method: "api_key",
          source: { kind: "provisioning-secret", name: "model-api-key" },
        },
      }),
      message:
        "The request does not match the operation contract: body /harnessAuth/source/namespaceId is required.",
    },
    {
      // Only the source kind is wrong, so the api_key shape fits and the other Harness
      // authentication shapes' fields are not listed.
      description: "Harness Secret source of another kind",
      body: requestBody({
        harnessAuth: {
          method: "api_key",
          source: {
            ...modelRef,
            kind: "provisioning-secret",
          },
        },
      }),
      message:
        'The request does not match the operation contract: body /harnessAuth/source/kind has an unsupported value (expected "secret").',
    },
    {
      // A string fits neither a Harness authentication shape nor null: one wrong-type problem
      // names both, not one per union level.
      description: "Harness authentication of the wrong type",
      body: requestBody({ harnessAuth: "api_key" }),
      message:
        "The request does not match the operation contract: body /harnessAuth has the wrong type (expected one of object, null).",
      details: [{ path: "/harnessAuth", code: "INVALID_TYPE" }],
    },
    {
      // The method selects the api_key shape, so only its missing source is reported, not
      // the fields of the other methods' shapes or the runtime method's literal.
      description: "Harness authentication method without its source",
      body: requestBody({ harnessAuth: { method: "api_key" } }),
      message:
        "The request does not match the operation contract: body /harnessAuth/source is required.",
      details: [{ path: "/harnessAuth/source", code: "REQUIRED" }],
    },
    {
      description: "too many binding destinations",
      body: requestBody({
        configuration: { secretBindings: oversizedBindings },
      }),
      message:
        "The request does not match the operation contract: body /configuration/secretBindings has an unsupported value (expected at most 64 fields).",
    },
    {
      description: "non-env delivery",
      body: requestBody({
        configuration: {
          secretBindings: {
            TOOL_API_KEY: {
              source: toolRef,
              delivery: { type: "file" },
            },
          },
        },
      }),
      message:
        'The request does not match the operation contract: body /configuration/secretBindings/TOOL_API_KEY/delivery/type has an unsupported value (expected "env").',
    },
    {
      description: "cross-Namespace Secret references",
      body: requestBody({
        configuration: {
          secretBindings: {
            TOOL_API_KEY: {
              source: { kind: "secret", namespaceId: foreignNamespaceId, id: foreignSecretId },
            },
          },
        },
      }),
      message: "Secret references cannot cross Namespaces.",
    },
    {
      // executionMode is optional and defaults to embedded; the Compute Driver provisions only
      // dedicated Agents, so the request is refused naming the field to set.
      description: "omitted execution mode",
      body: requestBody({ executionMode: undefined }),
      message:
        "Agent provisioning needs dedicated execution; this request uses embedded execution. Set executionMode.",
    },
    {
      description: "embedded execution mode",
      body: requestBody({ executionMode: "embedded" }),
      message:
        "Agent provisioning needs dedicated execution; this request uses embedded execution. Set executionMode.",
    },
    {
      description: "reserved environment destinations",
      body: requestBody({
        configuration: {
          secretBindings: {
            OPENCLAW_TOKEN: {
              source: toolRef,
            },
          },
        },
      }),
      message: "A secret binding destination uses the reserved prefix OPENCLAW_*: OPENCLAW_TOKEN.",
      // The reserved destination is named by its pointer under the inline Configuration.
      details: [{ path: "/configuration/secretBindings/OPENCLAW_TOKEN", code: "INVALID_VALUE" }],
    },
  ];
}

export async function assertInvalidInlinePlan(
  provision: (body: unknown) => Promise<{
    status: number;
    body: { error: { message: string; details?: unknown } };
  }>,
  { body, message, details, description }: InvalidPlan,
) {
  const result = await provision(body);
  assertApiError(result, 400, "INVALID_REQUEST", description);
  assert.equal(result.body.error.message, message, description);
  if (details !== undefined) {
    assert.deepEqual(result.body.error.details, details, description);
  }
}
