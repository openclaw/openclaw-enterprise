import assert from "node:assert/strict";
import test from "node:test";

import {
  assertConfigurationSchema,
  ConfigurationValidationError,
  requireConfiguration,
  serializeStartupConfiguration,
  validateConfiguration,
  type ConfigurationDefinition,
} from "../../packages/contracts/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

export function registerConfigurationCases(): void {
  // A duplicate false-subschema error must not hide useful field diagnostics, and
  // removing that duplicate must not admit independently forbidden values.
  test("configuration diagnostics collapse extra-field noise without accepting false schemas", () => {
    assert.deepEqual(
      validateConfiguration({ type: "object", additionalProperties: false }, { extra: 1 }),
      {
        success: false,
        error: {
          details: [
            {
              path: "",
              code: "UNKNOWN_FIELD",
              message: "Configuration does not satisfy additionalProperties.",
            },
          ],
        },
      },
    );
    // @ts-expect-error A JavaScript caller can pass a boolean root schema.
    const falseRootResult = validateConfiguration(false, 1);
    assert.equal(falseRootResult.success, false);
    assert.equal(
      falseRootResult.error.details[0].message,
      "Configuration does not satisfy boolean.",
    );
    for (const [schema, input] of [
      [{ type: "array", items: false }, [1]],
      [
        { type: "object", properties: { additionalProperties: false } },
        { additionalProperties: 1 },
      ],
    ] as const) {
      const result = validateConfiguration(schema, input);
      assert.equal(result.success, false);
      assert.equal(result.error.details[0].message, "Configuration does not satisfy boolean.");
    }
  });

  // Schema checks are cached per process by full JSON text: a schema that passed once and
  // then changes must be checked again, never admitted by object identity.
  test("a Driver configuration schema that changes after a passing check is checked again", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { endpoint: { type: "string" } },
    };
    assertConfigurationSchema(schema);
    assertConfigurationSchema(schema);
    schema.properties.endpoint.type = "not-a-schema-type";
    assert.throws(
      () => assertConfigurationSchema(schema),
      /Unsupported Driver configuration schema/,
    );
    schema.properties.endpoint.type = "string";
    assertConfigurationSchema(schema);
  });

  test("configuration admission retains original values while isolating semantic callback references", () => {
    const input = { endpoint: { port: 443 } };
    let retained: Readonly<typeof input> | undefined;
    const definition: ConfigurationDefinition<typeof input> = {
      configurationSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          endpoint: {
            type: "object",
            additionalProperties: false,
            properties: { port: { type: "integer" } },
          },
        },
      },
      validateConfiguration(value) {
        retained = value;
        return [];
      },
    };
    assert.equal(requireConfiguration(definition, input), input);
    const retainedInput = retained;
    assert.ok(retainedInput);
    // A Driver retaining its argument cannot change data already admitted for another caller.
    assert.throws(() => {
      retainedInput.endpoint.port = 80;
    }, TypeError);
    assert.deepEqual(input, { endpoint: { port: 443 } });
    let getterInvoked = false;
    const accessor = {
      get endpoint(): never {
        getterInvoked = true;
        throw new Error("input getter must not run");
      },
    };
    assert.throws(
      () => requireConfiguration(definition, accessor),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationValidationError);
        assert.deepEqual(error.error.details, [
          {
            path: "",
            code: "INVALID_TYPE",
            message: "Configuration must contain only plain JSON values.",
          },
        ]);
        return true;
      },
    );
    assert.equal(getterInvoked, false);
  });

  test("startup inspection preserves unmarked JSON and hides whole write-only subtrees", () => {
    const schema = {
      type: "object",
      properties: {
        ordinary: { type: "object", additionalProperties: true },
        material: { writeOnly: true },
        entries: {
          type: "array",
          items: { properties: { hidden: { writeOnly: true }, name: { type: "string" } } },
        },
        absent: { type: "string", default: "schema-default", examples: ["schema-example"] },
      },
    };
    const input = {
      ordinary: { futureField: [false, 0, null, "", [], {}], schemaLike: { writeOnly: true } },
      material: { confidentialDynamicName: "private-value" },
      entries: [{ name: "one", hidden: ["private-item"] }, { name: "two" }],
      unlisted: { newlyAccepted: "visible" },
    };
    const inspected = serializeStartupConfiguration(schema, input);
    assert.deepEqual(inspected, {
      ordinary: { futureField: [false, 0, null, "", [], {}], schemaLike: { writeOnly: true } },
      material: "[redacted]",
      entries: [{ name: "one", hidden: "[redacted]" }, { name: "two" }],
      unlisted: { newlyAccepted: "visible" },
    });
    input.ordinary.futureField.push("later-mutation");
    const futureField = asRecord(inspected?.ordinary)?.futureField;
    const entries = inspected?.entries;
    assert.ok(isArray(futureField) && isArray(entries));
    assert.equal(futureField.length, 6);
    assert.equal(Object.isFrozen(entries[0]), true);
    assert.ok(!JSON.stringify(inspected).includes("confidentialDynamicName"));
  });

  test("startup inspection combines references and alternative annotations conservatively", () => {
    const schema = {
      type: "object",
      $defs: {
        hidden: { type: "string", writeOnly: true },
        node: {
          type: "object",
          properties: {
            label: {},
            hidden: { $ref: "#/$defs/hidden" },
            next: { $ref: "#/$defs/node" },
          },
        },
      },
      properties: {
        reference: { $ref: "#/$defs/hidden" },
        union: {
          anyOf: [
            { type: "string", writeOnly: false },
            { type: "number", writeOnly: true },
          ],
        },
        choice: { oneOf: [{ type: "string" }, { type: "number", writeOnly: true }] },
        combined: { allOf: [{ writeOnly: false }, { $ref: "#/$defs/hidden" }] },
        conditional: { if: { const: "private" }, then: { writeOnly: true } },
        negative: { not: { const: "refused", writeOnly: true } },
        dependent: { type: "string" },
        node: { $ref: "#/$defs/node" },
        ordinary: { type: "string" },
      },
      dependentSchemas: { absentTrigger: { properties: { dependent: { writeOnly: true } } } },
    };
    const input = {
      reference: "private",
      union: "string-branch",
      choice: "string-branch",
      combined: "private",
      conditional: "public-branch",
      negative: "accepted",
      dependent: "trigger-absent",
      node: {
        label: "outer",
        hidden: "outer-private",
        next: { label: "inner", hidden: "inner-private" },
      },
      ordinary: "visible",
    };
    assert.equal(validateConfiguration(schema, input).success, true);
    // An unmarked alternative cannot re-expose a path marked by another branch, even a nonmatching one.
    assert.deepEqual(serializeStartupConfiguration(schema, input), {
      reference: "[redacted]",
      union: "[redacted]",
      choice: "[redacted]",
      combined: "[redacted]",
      conditional: "[redacted]",
      negative: "[redacted]",
      dependent: "[redacted]",
      node: {
        label: "outer",
        hidden: "[redacted]",
        next: { label: "inner", hidden: "[redacted]" },
      },
      ordinary: "visible",
    });
  });

  test("startup inspection redacts map names and array matches without dropping ordinary fields", () => {
    const schema = {
      type: "object",
      properties: {
        patternMap: { patternProperties: { "^private_": { writeOnly: true } } },
        unicodeMap: {
          patternProperties: { "^.$": { type: "string", writeOnly: true } },
          additionalProperties: false,
        },
        extraMap: { properties: { visible: {} }, additionalProperties: { writeOnly: true } },
        privateNames: { propertyNames: { writeOnly: true } },
        tuple: {
          type: "array",
          prefixItems: [{}, { writeOnly: true }],
          items: { writeOnly: true },
        },
        matches: { type: "array", contains: { type: "string", writeOnly: true } },
      },
    };
    const input = {
      patternMap: { visible: "yes", private_value: "hidden" },
      unicodeMap: { "🔐": "hidden" },
      extraMap: { visible: 1, dynamic: "hidden" },
      privateNames: { confidentialName: "hidden" },
      tuple: ["visible", "private", false],
      matches: ["private", 1],
    };
    assert.equal(validateConfiguration(schema, input).success, true);
    assert.deepEqual(serializeStartupConfiguration(schema, input), {
      patternMap: { visible: "yes", private_value: "[redacted]" },
      unicodeMap: { "🔐": "[redacted]" },
      extraMap: { visible: 1, dynamic: "[redacted]" },
      privateNames: "[redacted]",
      tuple: ["visible", "[redacted]", "[redacted]"],
      matches: ["[redacted]", "[redacted]"],
    });
  });

  test("startup inspection reports a write-only root or unsupported annotation form without raw fallback", () => {
    assert.equal(
      serializeStartupConfiguration({ type: "object", writeOnly: true }, { private: "value" }),
      undefined,
    );
    for (const [schema, input] of [
      [{ type: "object", unevaluatedProperties: { writeOnly: true } }, { private: "value" }],
      [
        {
          type: "object",
          properties: { items: { type: "array", unevaluatedItems: { writeOnly: true } } },
        },
        { items: ["private"] },
      ],
      [
        {
          type: "object",
          properties: { encoded: { type: "string", contentSchema: { writeOnly: true } } },
        },
        { encoded: "private" },
      ],
      [
        {
          type: "object",
          properties: {
            entries: {
              type: "object",
              propertyNames: { contentEncoding: "base64", contentSchema: { writeOnly: true } },
            },
          },
        },
        { entries: { [Buffer.from("private-name").toString("base64")]: "value" } },
      ],
    ] as const) {
      assert.equal(validateConfiguration(schema, input).success, true);
      assert.throws(() => serializeStartupConfiguration(schema, input), /inspection/);
    }
    assert.deepEqual(
      serializeStartupConfiguration(
        { type: "object", unevaluatedProperties: true },
        { visible: 1 },
      ),
      { visible: 1 },
    );
  });
}
