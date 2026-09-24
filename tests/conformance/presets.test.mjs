import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizePresetTemplate,
  presetTemplateDefaults,
  PresetValidationError,
  renderPresetTemplate,
} from "../../packages/contracts/src/index.ts";

const namespaceId = "ns_00000000-0000-4000-8000-000000000001";
const otherNamespaceId = "ns_00000000-0000-4000-8000-000000000002";
const secretId = "sec_00000000-0000-4000-8000-000000000001";

test("preset variables produce typed launch values and native model keys without interpreting inserted data", () => {
  const template = {
    variables: {
      model: { type: "string", default: "openai/example" },
      name: { type: "string" },
      limit: { type: "number", default: 4 },
      enabled: { type: "boolean", default: true },
      suffix: { type: "string", default: "default" },
    },
    agent: { name: "agent-{{ vars.name }}" },
    configuration: {
      values: {
        agents: { defaults: { model: "{{ vars.model }}", models: { "{{ vars.model }}": {} } } },
        settings: {
          limit: "{{ vars.limit }}",
          enabled: "{{ vars.enabled }}",
          suffix: "{{ vars.suffix }}",
        },
      },
    },
  };
  const rendered = renderPresetTemplate(template, {
    name: 'quoted"{{ vars.model }}',
    limit: 0,
    enabled: false,
    suffix: "",
  });
  assert.equal(rendered.agent.name, 'agent-quoted"{{ vars.model }}');
  assert.deepEqual(rendered.configuration.values.agents.defaults, {
    model: "openai/example",
    models: { "openai/example": {} },
  });
  assert.deepEqual(rendered.configuration.values.settings, {
    limit: 0,
    enabled: false,
    suffix: "",
  });
  assert.equal(template.agent.name, "agent-{{ vars.name }}");
});

test("runtime placeholders, SecretRefs, escaped tokens, and unrelated template syntax remain literal", () => {
  const template = {
    variables: {
      id: { type: "string", default: secretId },
      text: { type: "string", default: "{{ vars.missing }}" },
    },
    configuration: {
      values: {
        env: "${APP_SERVER_TOKEN}",
        prompt: "{{ user.name }} {% if ready %}",
        escaped: "\\{{ vars.undeclared }}",
        defaultText: "{{ vars.text }}",
        secret: { source: "env", provider: "default", id: "TOKEN" },
      },
      secretBindings: {
        BOT_TOKEN: { source: { kind: "secret", namespaceId, id: "{{ vars.id }}" } },
      },
    },
  };
  assert.deepEqual(renderPresetTemplate(template).configuration, {
    values: {
      env: "${APP_SERVER_TOKEN}",
      prompt: "{{ user.name }} {% if ready %}",
      escaped: "{{ vars.undeclared }}",
      defaultText: "{{ vars.missing }}",
      secret: { source: "env", provider: "default", id: "TOKEN" },
    },
    secretBindings: { BOT_TOKEN: { source: { kind: "secret", namespaceId, id: secretId } } },
  });
});

test("invalid variable programs and inputs fail before producing launch settings", () => {
  const base = { variables: { value: { type: "string" } }, agent: { name: "{{ vars.value }}" } };
  for (const [template, inputs, message] of [
    [base, {}, /requires a value/],
    [base, { other: "x" }, /undeclared/],
    [base, { value: 3 }, /declared type/],
    [{ agent: { name: "{{ vars.missing }}" } }, {}, /undeclared/],
    [
      { ...base, agent: { name: "{{ vars.value | upper }}" } },
      {},
      /unsupported variable expression/,
    ],
    [{ ...base, agent: { name: "{{ vars.value" } }, {}, /unclosed/],
    [
      { variables: { value: { type: "number" } }, agent: { name: "prefix-{{ vars.value }}" } },
      { value: 2 },
      /must be a string/,
    ],
    [{ variables: null }, {}, /must be an object/],
    [{ variables: { value: { type: "boolean", default: 0 } } }, {}, /default must match/],
    [{ variables: { value: { type: "number" } } }, { value: Infinity }, /only JSON/],
  ]) {
    assert.throws(
      () => renderPresetTemplate(template, inputs),
      (error) => error instanceof PresetValidationError && message.test(error.message),
    );
  }
});

test("native key substitution rejects collisions and preserves special keys as inert JSON", () => {
  const template = {
    variables: { key: { type: "string" } },
    configuration: { values: { "{{ vars.key }}": { safe: true }, existing: {} } },
  };
  assert.throws(() => renderPresetTemplate(template, { key: "existing" }), /duplicate object keys/);
  const rendered = renderPresetTemplate(template, { key: "__proto__" });
  assert.equal(Object.getPrototypeOf(rendered.configuration.values), Object.prototype);
  assert.equal(Object.hasOwn(rendered.configuration.values, "__proto__"), true);
  assert.deepEqual(rendered.configuration.values.__proto__, { safe: true });
  assert.equal({}.safe, undefined);
});

test("preset admission preserves credential structure and literal and default scope", () => {
  const template = {
    variables: {
      mode: { type: "string" },
      enabled: { type: "boolean" },
      secret: { type: "string", default: secretId },
    },
    agent: {
      executionMode: "{{ vars.mode }}",
      plugins: { github: { enabled: "{{ vars.enabled }}", toolDefaults: { approval: "prompt" } } },
    },
    configuration: {
      secretBindings: {
        BOT_TOKEN: { source: { kind: "secret", namespaceId, id: "{{ vars.secret }}" } },
      },
    },
  };
  assert.deepEqual(normalizePresetTemplate(template, namespaceId), template);
  const scopedVariable = {
    variables: { scope: { type: "string" } },
    agent: {
      harnessAuth: {
        method: "api_key",
        source: { kind: "secret", namespaceId: "{{ vars.scope }}", id: secretId },
      },
    },
  };
  assert.deepEqual(normalizePresetTemplate(scopedVariable, namespaceId), scopedVariable);
  const patTemplate = structuredClone(scopedVariable);
  patTemplate.agent.harnessAuth.method = "codex_pat";
  assert.deepEqual(normalizePresetTemplate(patTemplate, namespaceId), patTemplate);
  patTemplate.agent.harnessAuth.source.namespaceId = otherNamespaceId;
  assert.throws(() => normalizePresetTemplate(patTemplate, namespaceId), PresetValidationError);

  // User-chosen map keys must receive the same admission as ordinary names.
  for (const key of ["__proto__", "constructor", "toString"]) {
    const valid = {
      agent: { plugins: { [key]: { enabled: true, toolDefaults: { approval: "prompt" } } } },
      configuration: {
        secretBindings: { [key]: { source: { kind: "secret", namespaceId, id: secretId } } },
      },
    };
    assert.deepEqual(normalizePresetTemplate(valid, namespaceId), valid);
    assert.throws(
      () =>
        normalizePresetTemplate(
          {
            configuration: {
              secretBindings: { [key]: { source: { kind: "secret", namespaceId, id: "junk" } } },
            },
          },
          namespaceId,
        ),
      PresetValidationError,
      `invalid Secret reference under ${key}`,
    );
  }

  assert.equal(
    presetTemplateDefaults(template).configuration.secretBindings.BOT_TOKEN.source.id,
    secretId,
  );
  for (const invalid of [
    { agent: { configurationId: "forbidden" } },
    {
      agent: {
        harnessAuth: {
          method: "api_key",
          source: { kind: "secret", namespaceId: otherNamespaceId, id: secretId },
        },
      },
    },
    {
      variables: { scope: { type: "string", default: otherNamespaceId } },
      agent: {
        harnessAuth: {
          method: "api_key",
          source: { kind: "secret", namespaceId: "{{ vars.scope }}", id: secretId },
        },
      },
    },
    { agent: { harnessAuth: "unfinished" } },
    { agent: { harnessAuth: { method: "api_key", source: "raw-credential" } } },
    {
      variables: { secret: { type: "number" } },
      agent: {
        harnessAuth: {
          method: "api_key",
          source: { kind: "secret", namespaceId, id: "{{ vars.secret }}" },
        },
      },
    },
    {
      variables: { secret: { type: "string", default: "not-a-secret-id" } },
      configuration: {
        secretBindings: {
          TOKEN: { source: { kind: "secret", namespaceId, id: "{{ vars.secret }}" } },
        },
      },
    },
    {
      configuration: {
        secretBindings: {
          TOKEN: { source: { kind: "secret", namespaceId, id: secretId }, raw: "credential" },
        },
      },
    },
    {
      configuration: {
        secretBindings: {
          TOKEN: {
            source: { kind: "secret", namespaceId, id: secretId },
            delivery: { type: "file" },
          },
        },
      },
    },
  ]) {
    assert.throws(() => normalizePresetTemplate(invalid, namespaceId), PresetValidationError);
  }
});

test("preset admission and rendering bound stored and expanded JSON", () => {
  let deep = {};
  for (let i = 0; i < 65; i += 1) {
    deep = { nested: deep };
  }
  assert.throws(
    () => normalizePresetTemplate({ configuration: { values: deep } }, namespaceId),
    /maximum depth/,
  );
  const template = {
    variables: { text: { type: "string" } },
    configuration: { values: { first: "{{ vars.text }}", second: "{{ vars.text }}" } },
  };
  assert.throws(
    () => renderPresetTemplate(template, { text: "x".repeat(600_000) }),
    /maximum size/,
  );
});
