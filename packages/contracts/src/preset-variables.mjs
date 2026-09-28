// This module is also served directly to the console. Keep it dependency-free.
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKEN = /^\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const RESERVED = /\{\{\s*vars\./;
const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_WORKSPACE_FILE_BYTES = 16 * 1024;
const INITIAL_WORKSPACE_FILE_NAMES = Object.freeze([
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
]);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class PresetValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PresetValidationError";
  }
}

function fail(path, message) {
  throw new PresetValidationError(`Preset ${path}: ${message}`);
}

function checkJson(value, path = "template", depth = 0) {
  if (depth > MAX_DEPTH) {
    fail(path, "JSON exceeds maximum depth of 64.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return;
  }
  if (!Array.isArray(value) && !record(value)) {
    fail(path, "must contain only JSON values.");
  }
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(path, "must contain ordinary JSON objects.");
  }
  for (const [key, child] of Object.entries(value)) {
    checkJson(child, `${path}.${key}`, depth + 1);
  }
}

function checkSize(value) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) {
    fail("template", "JSON exceeds maximum size of 1 MiB.");
  }
}

function scalar(value, type) {
  return (
    typeof value === (type === "password" ? "string" : type) &&
    (type !== "number" || Number.isFinite(value))
  );
}

function closedObject(value, fields, path) {
  if (!record(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    fail(path, "contains unsupported fields or is not an object.");
  }
}

function checkInitialWorkspaceFiles(value, path) {
  if (value === undefined) {
    return;
  }
  if (!record(value)) {
    fail(path, "must be an object.");
  }
  for (const [name, content] of Object.entries(value)) {
    if (!INITIAL_WORKSPACE_FILE_NAMES.includes(name)) {
      fail(path, "contains an unsupported filename.");
    }
    if (
      typeof content !== "string" ||
      !content.isWellFormed() ||
      content.includes("\0") ||
      new TextEncoder().encode(content).byteLength > MAX_WORKSPACE_FILE_BYTES
    ) {
      fail(path, "content must be valid Unicode without NUL and at most 16 KiB.");
    }
  }
}

// Tokenize once; inserted values are data, never a second template.
function tokens(text, definitions, path) {
  const parts = [];
  let position = 0;
  const starts = /\\?\{\{\s*vars\./g;
  for (let match; (match = starts.exec(text));) {
    parts.push(text.slice(position, match.index));
    const escaped = match[0].startsWith("\\");
    const start = match.index + (escaped ? 1 : 0);
    const end = text.indexOf("}}", start + 2);
    if (end === -1) {
      fail(path, "unclosed variable expression.");
    }
    const expression = text.slice(start, end + 2);
    const token = TOKEN.exec(expression);
    if (!token) {
      fail(path, "unsupported variable expression.");
    }
    if (escaped) {
      parts.push(expression);
    } else {
      const name = token[1];
      if (!Object.hasOwn(definitions, name)) {
        fail(path, `variable ${name} is undeclared.`);
      }
      parts.push({ name });
    }
    position = end + 2;
    starts.lastIndex = position;
  }
  parts.push(text.slice(position));
  return parts;
}

function substitute(text, definitions, inputs, path, key, partial) {
  const parts = tokens(text, definitions, path);
  const refs = parts.filter((part) => typeof part !== "string");
  if (!refs.length) {
    return parts.join("");
  }
  const whole = !key && parts.length === 3 && parts[0] === "" && parts[2] === "";
  for (const { name } of refs) {
    if (definitions[name].type === "password" && (!whole || path !== "agent.harnessAuth.secret")) {
      fail(path, "password variables require a whole-token Harness authentication secret.");
    }
    if (!whole && definitions[name].type !== "string") {
      fail(path, `variable ${name} must be a string for interpolation or object keys.`);
    }
  }
  const resolve = ({ name }) => {
    if (Object.hasOwn(inputs, name)) {
      return inputs[name];
    }
    if (Object.hasOwn(definitions[name], "default")) {
      return definitions[name].default;
    }
    if (partial) {
      return `{{ vars.${name} }}`;
    }
    fail(path, `variable ${name} requires a value.`);
  };
  if (whole) {
    return resolve(refs[0]);
  }
  return parts.map((part) => (typeof part === "string" ? part : resolve(part))).join("");
}

function walk(value, definitions, inputs, path, keys, partial) {
  if (typeof value === "string") {
    return substitute(value, definitions, inputs, path, false, partial);
  }
  if (Array.isArray(value)) {
    return value.map((child, index) =>
      walk(child, definitions, inputs, `${path}[${index}]`, keys, partial),
    );
  }
  if (!record(value)) {
    return value;
  }
  const entries = [];
  const seen = new Set();
  for (const [key, child] of Object.entries(value)) {
    const nextKey = keys ? substitute(key, definitions, inputs, `${path} key`, true, partial) : key;
    if (!keys && RESERVED.test(key)) {
      fail(path, "variable field names are only supported in configuration.values.");
    }
    if (seen.has(nextKey)) {
      fail(path, "variable substitution produces duplicate object keys.");
    }
    seen.add(nextKey);
    entries.push([
      nextKey,
      walk(
        child,
        definitions,
        inputs,
        `${path}.${key}`,
        keys || (path === "configuration" && key === "values"),
        partial,
      ),
    ]);
  }
  return Object.fromEntries(entries);
}

/** Validate declarations and syntax without requiring values for unfinished templates.
 * @param {unknown} template
 * @returns {import('./presets.ts').PresetTemplate}
 */
export function validatePresetTemplate(template) {
  checkJson(template);
  checkSize(template);
  closedObject(template, ["variables", "agent", "configuration"], "template");
  const definitions = Object.hasOwn(template, "variables") ? template.variables : {};
  if (!record(definitions)) {
    fail("variables", "must be an object.");
  }
  for (const [name, definition] of Object.entries(definitions)) {
    if (!NAME.test(name)) {
      fail("variables", "invalid variable name.");
    }
    closedObject(definition, ["type", "description", "default"], `variables.${name}`);
    if (!["string", "number", "boolean", "password"].includes(definition.type)) {
      fail(`variables.${name}`, "unsupported type.");
    }
    if (Object.hasOwn(definition, "description") && typeof definition.description !== "string") {
      fail(`variables.${name}`, "description must be a string.");
    }
    if (definition.type === "password" && Object.hasOwn(definition, "default")) {
      fail(`variables.${name}`, "password variables cannot have stored defaults.");
    }
    if (Object.hasOwn(definition, "default") && !scalar(definition.default, definition.type)) {
      fail(`variables.${name}`, "default must match its declared type.");
    }
  }
  if (Object.hasOwn(template, "agent")) {
    closedObject(
      template.agent,
      [
        "name",
        "executionMode",
        "backendId",
        "harnessAuth",
        "plugins",
        "pluginApprovers",
        "initialWorkspaceFiles",
      ],
      "agent",
    );
    checkInitialWorkspaceFiles(template.agent.initialWorkspaceFiles, "agent.initialWorkspaceFiles");
  }
  const auth = template.agent?.harnessAuth;
  if (record(auth) && Object.hasOwn(auth, "secret")) {
    const token = typeof auth.secret === "string" ? TOKEN.exec(auth.secret) : null;
    if (!token || definitions[token[1]]?.type !== "password") {
      fail(
        "agent.harnessAuth.secret",
        "requires a password variable token, never a stored credential.",
      );
    }
  }
  if (Object.hasOwn(template, "configuration")) {
    closedObject(template.configuration, ["values", "secretBindings"], "configuration");
    if (Object.hasOwn(template.configuration, "values") && !record(template.configuration.values)) {
      fail("configuration.values", "must be a JSON object.");
    }
  }
  for (const section of ["agent", "configuration"]) {
    if (Object.hasOwn(template, section)) {
      walk(template[section], definitions, {}, section, false, true);
    }
  }
  return template;
}

/** Resolve known defaults for server-side admission while leaving required inputs unfilled.
 * @param {import('./presets.ts').PresetTemplate} template
 * @returns {import('./presets.ts').PresetLaunchSettings}
 */
export function presetTemplateDefaults(template) {
  return render(template, {}, true);
}

function render(template, inputs, partial) {
  validatePresetTemplate(template);
  checkJson(inputs, "inputs");
  checkSize(inputs);
  if (!record(inputs)) {
    fail("inputs", "must be an object.");
  }
  const definitions = Object.hasOwn(template, "variables") ? template.variables : {};
  for (const [name, value] of Object.entries(inputs)) {
    if (!Object.hasOwn(definitions, name)) {
      fail("inputs", `variable ${name} is undeclared.`);
    }
    if (!scalar(value, definitions[name].type)) {
      fail("inputs", `variable ${name} must match its declared type.`);
    }
  }
  const result = Object.fromEntries(
    ["agent", "configuration"]
      .filter((section) => Object.hasOwn(template, section))
      .map((section) => [
        section,
        walk(template[section], definitions, inputs, section, false, partial),
      ]),
  );
  checkInitialWorkspaceFiles(result.agent?.initialWorkspaceFiles, "agent.initialWorkspaceFiles");
  checkSize(result);
  return result;
}

/** Render one independent launch draft without changing the template or inputs.
 * @param {import('./presets.ts').PresetTemplate} template
 * @param {Record<string, string | number | boolean>} [inputs]
 * @returns {import('./presets.ts').PresetLaunchSettings}
 */
export function renderPresetTemplate(template, inputs = {}) {
  return render(template, inputs, false);
}

// Credential admission permits unfilled string references while validating literal/default values.
export function unresolvedPresetVariableTypes(value, definitions) {
  if (typeof value !== "string") {
    return [];
  }
  return tokens(value, definitions, "template")
    .filter((part) => typeof part !== "string" && !Object.hasOwn(definitions[part.name], "default"))
    .map(({ name }) => definitions[name].type);
}
