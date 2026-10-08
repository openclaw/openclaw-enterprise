import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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

test("preset agent plugin approvers preserve inheritance, denial, and rendered identities", () => {
  assert.equal(
    Object.hasOwn(renderPresetTemplate({ agent: { name: "omitted" } }).agent, "pluginApprovers"),
    false,
  );
  assert.deepEqual(renderPresetTemplate({ agent: { pluginApprovers: [] } }).agent, {
    pluginApprovers: [],
  });

  const template = {
    variables: {
      team: { type: "string", default: "T123" },
      user: { type: "string" },
    },
    agent: {
      pluginApprovers: [{ channel: "slack", id: "team:{{ vars.team }}:user:{{ vars.user }}" }],
    },
  };
  assert.deepEqual(renderPresetTemplate(template, { user: "U456" }).agent.pluginApprovers, [
    { channel: "slack", id: "team:T123:user:U456" },
  ]);
  assert.deepEqual(normalizePresetTemplate(template, namespaceId), template);
});

test("preset workspace files render editable seed text and enforce create-time limits", () => {
  const template = {
    variables: {
      name: { type: "string" },
      tone: { type: "string", default: "" },
      required: { type: "string" },
    },
    agent: {
      initialWorkspaceFiles: {
        "AGENTS.md": "# {{ vars.name }}\n",
        "SOUL.md": "Tone: {{ vars.tone }}",
        "IDENTITY.md": "",
        "USER.md": "{{ vars.required }}",
      },
    },
  };
  assert.deepEqual(presetTemplateDefaults(template).agent.initialWorkspaceFiles, {
    "AGENTS.md": "# {{ vars.name }}\n",
    "SOUL.md": "Tone: ",
    "IDENTITY.md": "",
    "USER.md": "{{ vars.required }}",
  });
  assert.deepEqual(
    renderPresetTemplate(template, { name: "Workspace Agent", required: "Remember me" }).agent
      .initialWorkspaceFiles,
    {
      "AGENTS.md": "# Workspace Agent\n",
      "SOUL.md": "Tone: ",
      "IDENTITY.md": "",
      "USER.md": "Remember me",
    },
  );

  for (const [invalid, inputs, message] of [
    [{ agent: { initialWorkspaceFiles: { "README.md": "nope" } } }, {}, /unsupported filename/],
    [{ agent: { initialWorkspaceFiles: { "AGENTS.md": "bad\0" } } }, {}, /without NUL/],
    [
      {
        variables: { content: { type: "string" } },
        agent: { initialWorkspaceFiles: { "AGENTS.md": "{{ vars.content }}" } },
      },
      { content: "x".repeat(16 * 1024 + 1) },
      /16 KiB/,
    ],
    [
      {
        variables: { secret: { type: "password" } },
        agent: { initialWorkspaceFiles: { "AGENTS.md": "{{ vars.secret }}" } },
      },
      { secret: "raw" },
      /password variables/,
    ],
  ]) {
    assert.throws(
      () => renderPresetTemplate(invalid, inputs),
      (error) => error instanceof PresetValidationError && message.test(error.message),
    );
  }
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
    [{ ...base, extra: {} }, { value: "x" }, /template: contains unsupported fields/],
    [{ variables: { "bad-name": { type: "string" } } }, {}, /invalid variable name/],
    [{ variables: { value: { type: "date" } } }, {}, /type must be string, number/],
    [
      { ...base, agent: { plugins: { "{{ vars.value }}": { enabled: true } } } },
      { value: "github" },
      /variable field names are only supported in configuration.values/,
    ],
    [
      {
        agent: {
          repositoryBindings: Array.from({ length: 17 }, (_, i) => ({ repositoryRef: `r${i}` })),
        },
      },
      {},
      /at most 16 repository selections/,
    ],
    [
      {
        agent: {
          repositoryAccess: { defaultProfile: "read", repositories: [] },
          repositoryBindings: [],
        },
      },
      {},
      /cannot be combined/,
    ],
    [
      { agent: { repositoryBindings: [{ repositoryRef: "app" }, { repositoryRef: "app" }] } },
      {},
      /repository references must be unique/,
    ],
    [
      { ...base, agent: { repositoryBindings: [{ repositoryRef: "{{ vars.value }}" }] } },
      { value: "owner/app" },
      /requires a repository selector/,
    ],
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
      plugins: {
        github: { enabled: "{{ vars.enabled }}", toolDefaults: { approval: "all_actions" } },
      },
    },
    configuration: {
      secretBindings: {
        BOT_TOKEN: { source: { kind: "secret", namespaceId, id: "{{ vars.secret }}" } },
      },
    },
  };
  const normalized = normalizePresetTemplate(template, namespaceId);
  assert.deepEqual(normalized, template);
  assert.notEqual(normalized, template);
  assert.notEqual(normalized.configuration.secretBindings, template.configuration.secretBindings);
  assert.equal(Object.isFrozen(normalized.configuration.secretBindings.BOT_TOKEN.source), true);
  assert.equal(Object.isFrozen(template.configuration.secretBindings.BOT_TOKEN.source), false);
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
  assert.deepEqual(
    normalizePresetTemplate({ agent: { harnessAuth: { method: "api_key" } } }, namespaceId),
    { agent: { harnessAuth: { method: "api_key" } } },
  );
  assert.deepEqual(
    normalizePresetTemplate({ agent: { harnessAuth: { method: "codex_pat" } } }, namespaceId),
    { agent: { harnessAuth: { method: "codex_pat" } } },
  );

  // User-chosen map keys must receive the same admission as ordinary names.
  for (const key of ["__proto__", "constructor", "toString"]) {
    const valid = {
      agent: { plugins: { [key]: { enabled: true, toolDefaults: { approval: "all_actions" } } } },
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
  const binding = { source: { kind: "secret", namespaceId, id: secretId } };
  const managedPat = {
    method: "codex_pat",
    source: { kind: "service_account", namespaceId, id: secretId.replace("sec_", "sa_") },
  };
  const managedTemplate = { agent: { harnessAuth: managedPat } };
  assert.deepEqual(normalizePresetTemplate(managedTemplate, namespaceId), managedTemplate);
  for (const [invalid, message] of [
    [{ agent: { harnessAuth: { method: "password" } } }, /Harness authentication requires/],
    [
      {
        agent: {
          harnessAuth: {
            method: "chatgpt_service_account",
            serviceAccountId: managedPat.source.id,
          },
        },
      },
      /Harness authentication requires/,
    ],
    [
      { agent: { harnessAuth: { ...managedPat, method: "api_key" } } },
      /Harness authentication requires/,
    ],
    [
      {
        agent: {
          harnessAuth: {
            ...managedPat,
            source: { ...managedPat.source, namespaceId: otherNamespaceId },
          },
        },
      },
      /Harness authentication requires/,
    ],
    // The managed account reference is closed and exactly typed.
    ...[
      { ...managedPat.source, kind: "secret" },
      { ...managedPat.source, id: secretId },
      { ...managedPat.source, name: "extra" },
    ].map((source) => [
      { agent: { harnessAuth: { ...managedPat, source } } },
      /Harness authentication requires/,
    ]),
    ...["1TOKEN", "TOKEN-NAME", "T".repeat(254), "HOME", "otel_exporter"].map((name) => [
      { configuration: { secretBindings: { [name]: binding } } },
      /reserved or invalid environment destination/,
    ]),
    [
      {
        configuration: {
          secretBindings: Object.fromEntries(
            Array.from({ length: 65 }, (_, i) => [`TOKEN_${i}`, binding]),
          ),
        },
      },
      /at most 64 bindings/,
    ],
  ]) {
    assert.throws(() => normalizePresetTemplate(invalid, namespaceId), message);
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

// A Preset version is the SHA-256 of its canonical JSON (sorted keys, no whitespace),
// so reformatting a bundled file is not a new version.
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function presetVersion(document) {
  return createHash("sha256").update(canonicalJson(document)).digest("hex").slice(0, 16);
}

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

/** Problems that would let a bundled default change without its previous version archived. */
async function bundledPresetArchiveProblems(presetDirectory) {
  const archive = new URL("archive/", presetDirectory);
  const versions = await readJson(new URL("versions.json", archive));
  const problems = [];
  for (const [file, history] of Object.entries(versions)) {
    const stem = file.replace(/\.json$/, "");
    const recorded = history.at(-1);
    const actual = presetVersion(await readJson(new URL(file, presetDirectory)));
    if (actual !== recorded) {
      problems.push(
        `deploy/presets/${file} is version ${actual}, but archive/versions.json records ${recorded} as current. ` +
          `Archive the shipped version before changing it: ` +
          `git show origin/main:deploy/presets/${file} > deploy/presets/archive/${stem}/${recorded}.json, ` +
          `then append "${actual}" to "${file}" in deploy/presets/archive/versions.json.`,
      );
    }
    const superseded = history.slice(0, -1);
    // A revert may make an earlier version current again; superseded ones are unique.
    if (new Set(superseded).size !== superseded.length) {
      problems.push(`archive/versions.json lists a superseded ${file} version twice.`);
    }
    const archived = superseded.length === 0 ? [] : await readdir(new URL(`${stem}/`, archive));
    for (const version of superseded) {
      if (!archived.includes(`${version}.json`)) {
        problems.push(`archive/${stem}/${version}.json is missing for a superseded ${file}.`);
        continue;
      }
      const document = await readJson(new URL(`${stem}/${version}.json`, archive));
      if (presetVersion(document) !== version) {
        problems.push(`archive/${stem}/${version}.json no longer matches its version.`);
      }
    }
    for (const entry of archived) {
      if (!superseded.includes(entry.replace(/\.json$/, ""))) {
        problems.push(`archive/${stem}/${entry} is not listed in archive/versions.json.`);
      }
    }
  }
  const stems = Object.entries(versions)
    .filter(([, history]) => history.length > 1)
    .map(([file]) => file.replace(/\.json$/, ""));
  for (const entry of await readdir(archive, { withFileTypes: true })) {
    if (entry.isDirectory() && !stems.includes(entry.name)) {
      problems.push(`archive/${entry.name}/ has no superseded versions in archive/versions.json.`);
    }
  }
  return problems;
}

test("every superseded bundled default Preset is archived as a valid template", async () => {
  const presetDirectory = new URL("../../deploy/presets/", import.meta.url);
  assert.deepEqual(await bundledPresetArchiveProblems(presetDirectory), []);
  const versions = await readJson(new URL("archive/versions.json", presetDirectory));
  // Startup refreshes and deletes copies by comparing them with these templates,
  // so each must still pass the current Preset admission.
  for (const [file, history] of Object.entries(versions)) {
    for (const version of history.slice(0, -1)) {
      const document = await readJson(
        new URL(`archive/${file.replace(/\.json$/, "")}/${version}.json`, presetDirectory),
      );
      assert.deepEqual(Object.keys(document).sort(), ["name", "template"]);
      normalizePresetTemplate(document.template, namespaceId);
    }
  }
});

test("the archive guard fails when a bundled default changes without archiving its version", async (t) => {
  const copy = await mkdtemp(join(tmpdir(), "occ-preset-archive-"));
  t.after(() => rm(copy, { recursive: true, force: true }));
  await cp(new URL("../../deploy/presets/", import.meta.url), copy, { recursive: true });
  const presetDirectory = pathToFileURL(`${copy}/`);
  const codex = new URL("default-codex.json", presetDirectory);
  const versions = await readJson(new URL("archive/versions.json", presetDirectory));
  const shipped = versions["default-codex.json"].at(-1);
  // Reformatting is not a change.
  await writeFile(codex, JSON.stringify(await readJson(codex)));
  assert.deepEqual(await bundledPresetArchiveProblems(presetDirectory), []);

  const changed = await readJson(codex);
  changed.template.agent.name = "Changed default";
  await writeFile(codex, JSON.stringify(changed, null, 2));
  const [problem] = await bundledPresetArchiveProblems(presetDirectory);
  assert.match(problem, new RegExp(`records ${shipped} as current`));
  assert.match(problem, new RegExp(`archive/default-codex/${shipped}\\.json`));
  // Recording the new version without the archived file still fails.
  versions["default-codex.json"].push(presetVersion(changed));
  await writeFile(new URL("archive/versions.json", presetDirectory), JSON.stringify(versions));
  assert.deepEqual(await bundledPresetArchiveProblems(presetDirectory), [
    `archive/default-codex/${shipped}.json is missing for a superseded default-codex.json.`,
  ]);
});
