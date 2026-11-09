import type { PresetDraftTemplate, PresetLaunchSettings, PresetVariable } from "./presets.ts";

// This module is also served directly to the console. Keep it dependency-free.
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TOKEN = /^\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;
const RESERVED = /\{\{\s*vars\./;
export const PRESET_JSON_MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_WORKSPACE_FILE_BYTES = 16 * 1024;
const INITIAL_WORKSPACE_FILE_NAMES = Object.freeze([
  "AGENTS.md",
  "SOUL.md",
  "IDENTITY.md",
  "USER.md",
]);

function array(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !array(value);
}

export class PresetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PresetValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new PresetValidationError(`Preset ${path}: ${message}`);
}

function checkJson(value: unknown, path = "template", depth = 0) {
  if (depth > MAX_DEPTH) {
    fail(path, "JSON exceeds maximum depth of 64.");
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return;
  }
  if (!array(value) && !record(value)) {
    fail(path, "must contain only JSON values.");
  }
  if (!array(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(path, "must contain ordinary JSON objects.");
  }
  for (const [key, child] of Object.entries(value)) {
    checkJson(child, `${path}.${key}`, depth + 1);
  }
}

function checkSize(value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > PRESET_JSON_MAX_BYTES) {
    fail("template", "JSON exceeds maximum size of 1 MiB.");
  }
}

function scalar(value: unknown, type: PresetVariable["type"]): value is string | number | boolean {
  return (
    typeof value === (type === "password" ? "string" : type) &&
    (type !== "number" || Number.isFinite(value))
  );
}

function closedObject(
  value: unknown,
  fields: readonly string[],
  path: string,
): asserts value is Record<string, unknown> {
  if (!record(value) || Object.keys(value).some((key) => !fields.includes(key))) {
    fail(path, "contains unsupported fields or is not an object.");
  }
}

function checkInitialWorkspaceFiles(
  value: unknown,
  path: string,
): asserts value is Readonly<Record<string, unknown>> | undefined {
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

type Definitions = Readonly<Record<string, PresetVariable>>;
type Inputs = Readonly<Record<string, string | number | boolean>>;
type Location = readonly (string | number)[];
type Located = (literals: string[], text: string, type: PresetVariable["type"] | undefined) => void;
type Placeholders = Map<string, string[] | PresetVariable["type"]>;
type VariableToken = { name: string };

// Tokenize once; inserted values are data, never a second template.
function tokens(text: string, definitions: Definitions, path: string) {
  const parts: (string | VariableToken)[] = [];
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
      // TOKEN has one required capture.
      const name = token[1]!;
      if (!Object.hasOwn(definitions, name)) {
        fail(path, `variable ${name} is undeclared; declare it under variables.`);
      }
      parts.push({ name });
    }
    position = end + 2;
    starts.lastIndex = position;
  }
  parts.push(text.slice(position));
  return parts;
}

// `located(literals, text, type)` receives the literal text around the placeholders left in
// `text`, and the declared type of a variable that is the whole value.
function substitute(
  text: string,
  definitions: Definitions,
  inputs: Inputs,
  path: string,
  key: true,
  partial: boolean,
  located: Located | undefined,
): string;
function substitute(
  text: string,
  definitions: Definitions,
  inputs: Inputs,
  path: string,
  key: boolean,
  partial: boolean,
  located: Located | undefined,
): string | number | boolean;
function substitute(
  text: string,
  definitions: Definitions,
  inputs: Inputs,
  path: string,
  key: boolean,
  partial: boolean,
  located: Located | undefined,
) {
  const parts = tokens(text, definitions, path);
  // Each token names an own entry in the typed definitions map (checked by tokens).
  const refs = parts.filter((part) => typeof part !== "string");
  const first = refs[0];
  if (!first) {
    return parts.join("");
  }
  const whole = !key && parts.length === 3 && parts[0] === "" && parts[2] === "";
  for (const { name } of refs) {
    if (definitions[name]!.type === "password" && (!whole || path !== "agent.harnessAuth.secret")) {
      fail(path, "password variables require a whole-token Harness authentication secret.");
    }
    if (!whole && definitions[name]!.type !== "string") {
      fail(path, `variable ${name} must be a string for interpolation or object keys.`);
    }
  }
  const resolve = ({ name }: VariableToken) => {
    if (Object.hasOwn(inputs, name)) {
      return inputs[name];
    }
    if (Object.hasOwn(definitions[name]!, "default")) {
      const definition = definitions[name]!;
      return "default" in definition ? definition.default : undefined;
    }
    if (partial) {
      return undefined;
    }
    fail(path, `variable ${name} requires a value.`);
  };
  if (whole) {
    const value = resolve(first);
    if (value !== undefined) {
      return value;
    }
  }
  // The literal text around each placeholder left for a variable without a value. An escaped
  // token renders to the same text as a placeholder but stays literal once filled, so it is part
  // of the literal text, and a string with no placeholder is never named.
  const literals = [""];
  let result = "";
  for (const part of parts) {
    const value = typeof part === "string" ? part : resolve(part);
    if (value === undefined && typeof part !== "string") {
      literals.push("");
      result += `{{ vars.${part.name} }}`;
    } else {
      // literals starts nonempty; a string part cannot resolve to undefined.
      literals[literals.length - 1]! += value!;
      result += value;
    }
  }
  if (literals.length > 1) {
    located?.(literals, result, whole ? definitions[first.name]!.type : undefined);
  }
  return result;
}

// Admission names a configuration.values string by its path there, so the same text elsewhere
// is not mistaken for it; an object key's path ends in the rendered key, unique in its object.
function placeholderLocation(path: Location, key: boolean) {
  return JSON.stringify([key ? "key" : "value", ...path]);
}

// Where admission finds the declared type of a variable without a value that is a whole value.
function wholeVariableLocation(path: Location) {
  return JSON.stringify(["type", ...path]);
}

// `placeholders` collects admission's placeholder locations; `at` is the path in
// configuration.values (undefined outside it).
function walk(
  value: unknown,
  definitions: Definitions,
  inputs: Inputs,
  path: string,
  keys: boolean,
  partial: boolean,
  placeholders?: Placeholders,
  at?: Location,
): unknown {
  const located = (key: boolean): Located | undefined =>
    placeholders && at
      ? (literals, text, type) => {
          placeholders.set(placeholderLocation(key ? [...at, text] : at, key), literals);
          if (type !== undefined) {
            placeholders.set(wholeVariableLocation(at), type);
          }
        }
      : undefined;
  if (typeof value === "string") {
    return substitute(value, definitions, inputs, path, false, partial, located(false));
  }
  if (array(value)) {
    return value.map((child, index) =>
      walk(
        child,
        definitions,
        inputs,
        `${path}[${index}]`,
        keys,
        partial,
        placeholders,
        placeholders && at && [...at, index],
      ),
    );
  }
  if (!record(value)) {
    return value;
  }
  const entries: [string, unknown][] = [];
  const seen = new Set();
  for (const [key, child] of Object.entries(value)) {
    const nextKey = keys
      ? substitute(key, definitions, inputs, `${path} key`, true, partial, located(true))
      : key;
    if (!keys && RESERVED.test(key)) {
      fail(path, "variable field names are only supported in configuration.values.");
    }
    if (seen.has(nextKey)) {
      fail(path, "variable substitution produces duplicate object keys.");
    }
    seen.add(nextKey);
    const values = path === "configuration" && key === "values";
    entries.push([
      nextKey,
      walk(
        child,
        definitions,
        inputs,
        `${path}.${key}`,
        keys || values,
        partial,
        placeholders,
        placeholders && (values ? [] : at && [...at, nextKey]),
      ),
    ]);
  }
  return Object.fromEntries(entries);
}

function checkDefinitions(
  definitions: Record<string, unknown>,
): asserts definitions is Record<string, PresetVariable> {
  for (const [name, definition] of Object.entries(definitions)) {
    if (!NAME.test(name)) {
      fail("variables", "invalid variable name.");
    }
    closedObject(definition, ["type", "description", "default"], `variables.${name}`);
    if (
      definition.type !== "string" &&
      definition.type !== "number" &&
      definition.type !== "boolean" &&
      definition.type !== "password"
    ) {
      fail(`variables.${name}`, "type must be string, number, boolean, or password.");
    }
    if (Object.hasOwn(definition, "description") && typeof definition.description !== "string") {
      fail(`variables.${name}`, "description must be a string.");
    }
    if (definition.type === "password" && Object.hasOwn(definition, "default")) {
      fail(`variables.${name}`, "password variables cannot have stored defaults.");
    }
    if (Object.hasOwn(definition, "default") && !scalar(definition.default, definition.type)) {
      fail(`variables.${name}`, `default must match its declared type, ${definition.type}.`);
    }
  }
}

/** Validate declarations and syntax without requiring values for unfinished templates. */
export function validatePresetTemplate(template: unknown): PresetDraftTemplate {
  checkTemplate(template);
  return template;
}

function checkTemplate(template: unknown): asserts template is PresetDraftTemplate {
  checkJson(template);
  checkSize(template);
  closedObject(template, ["variables", "agent", "configuration"], "template");
  const definitions = Object.hasOwn(template, "variables") ? template.variables : {};
  if (!record(definitions)) {
    fail("variables", "must be an object.");
  }
  checkDefinitions(definitions);
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
        "repositoryAccess",
        "repositoryBindings",
        "initialWorkspaceFiles",
      ],
      "agent",
    );
    validateRepositorySettings(template.agent, true);
    checkInitialWorkspaceFiles(template.agent.initialWorkspaceFiles, "agent.initialWorkspaceFiles");
  }
  const auth = record(template.agent) ? template.agent.harnessAuth : undefined;
  if (record(auth) && Object.hasOwn(auth, "secret")) {
    const token = typeof auth.secret === "string" ? TOKEN.exec(auth.secret) : null;
    if (!token || definitions[token[1]!]?.type !== "password") {
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
}

/** Resolve known defaults for server-side admission while leaving required inputs unfilled. */
export function presetTemplateDefaults(template: PresetDraftTemplate): PresetLaunchSettings {
  return render(template, {}, true);
}

/** Like presetTemplateDefaults, and also locate the configuration.values strings (values and
 * object keys) a placeholder for a variable without a value went into, which admission checks
 * once filled. `unresolved(path, key)` returns the literal text around the placeholders of the
 * string at `path` (an object key: `key` true, `path` ending in the rendered key), or undefined.
 * Escaped tokens and defaults that read like tokens are literal text: elsewhere they are checked
 * as written, and beside a placeholder they are part of its literal text. `unresolvedType(path)`
 * returns the declared type of such a variable that is the whole value at `path`: a number or
 * boolean variable fills it with no string (finding 1257).
 */
export function presetTemplateDefaultsWithPlaceholders(template: PresetDraftTemplate) {
  const placeholders: Placeholders = new Map();
  const settings = render(template, {}, true, placeholders);
  return {
    settings,
    unresolved: (path: Location, key = false): readonly string[] | undefined => {
      const value = placeholders.get(placeholderLocation(path, key));
      return Array.isArray(value) ? value : undefined;
    },
    unresolvedType: (path: Location): PresetVariable["type"] | undefined => {
      const value = placeholders.get(wholeVariableLocation(path));
      return typeof value === "string" ? value : undefined;
    },
  };
}

function render(
  template: PresetDraftTemplate,
  inputs: Inputs,
  partial: boolean,
  placeholders?: Placeholders,
): PresetLaunchSettings {
  validatePresetTemplate(template);
  checkJson(inputs, "inputs");
  checkSize(inputs);
  if (!record(inputs)) {
    fail("inputs", "must be an object.");
  }
  const definitions = Object.hasOwn(template, "variables") ? template.variables! : {};
  for (const [name, value] of Object.entries(inputs)) {
    if (!Object.hasOwn(definitions, name)) {
      fail("inputs", `variable ${name} is undeclared.`);
    }
    if (!scalar(value, definitions[name]!.type)) {
      fail("inputs", `variable ${name} must match its declared type.`);
    }
  }
  // Syntax validation proves both sections and their values/workspace-file maps are objects.
  // checkJson admits only JSON values; walking preserves those containers and replaces
  // only strings with checked scalar values. Thus configuration.values remains a JSON
  // document. Other draft fields remain unknown; traversal loses the container types.
  const sections: (keyof PresetLaunchSettings)[] = ["agent", "configuration"];
  const result = Object.fromEntries(
    sections
      .filter((section) => Object.hasOwn(template, section))
      .map((section) => [
        section,
        walk(
          template[section],
          definitions,
          inputs,
          section,
          false,
          partial,
          placeholders,
          // Admission checks configuration values only, so agent text is never located.
          undefined,
        ),
      ]),
  ) as PresetLaunchSettings;
  checkInitialWorkspaceFiles(result.agent?.initialWorkspaceFiles, "agent.initialWorkspaceFiles");
  checkSize(result);
  if (result.agent) {
    validateRepositorySettings(result.agent, partial);
  }
  return result;
}

function validateRepositorySettings(agent: Readonly<Record<string, unknown>>, partial: boolean) {
  if (Object.hasOwn(agent, "repositoryAccess") && Object.hasOwn(agent, "repositoryBindings")) {
    fail("agent", "repositoryAccess and repositoryBindings cannot be combined.");
  }
  const access = agent.repositoryAccess;
  if (Object.hasOwn(agent, "repositoryAccess")) {
    closedObject(access, ["defaultProfile", "repositories"], "agent.repositoryAccess");
    if (!Object.hasOwn(access, "defaultProfile") || !Object.hasOwn(access, "repositories")) {
      fail("agent.repositoryAccess", "requires defaultProfile and repositories.");
    }
    selector(access.defaultProfile, "agent.repositoryAccess.defaultProfile");
  }
  const entries =
    access !== undefined && record(access) ? access.repositories : agent.repositoryBindings;
  if (entries === undefined) {
    return;
  }
  const listPath =
    access !== undefined ? "agent.repositoryAccess.repositories" : "agent.repositoryBindings";
  const limitPath = access !== undefined ? "agent.repositoryAccess" : "agent.repositoryBindings";
  if (!array(entries) || entries.length > 16) {
    fail(limitPath, "requires at most 16 repository selections.");
  }
  const seen = new Set();
  for (const entry of entries) {
    closedObject(entry, ["repositoryRef", "profile"], listPath);
    selector(entry.repositoryRef, `${listPath}.repositoryRef`);
    if (Object.hasOwn(entry, "profile")) {
      selector(entry.profile, `${listPath}.profile`);
    }
    if (seen.has(entry.repositoryRef)) {
      fail(listPath, "repository references must be unique.");
    }
    seen.add(entry.repositoryRef);
  }
  function selector(value: unknown, path: string) {
    if (
      typeof value !== "string" ||
      (!partial && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.exec(value)?.[0] !== value)
    ) {
      fail(path, "requires a repository selector.");
    }
  }
}

/** Render one independent launch draft without changing the template or inputs. */
export function renderPresetTemplate(
  template: PresetDraftTemplate,
  inputs: Inputs = {},
): PresetLaunchSettings {
  return render(template, inputs, false);
}

/** Name declared variables without defaults that the template references; rendering needs them. */
export function requiredPresetVariables(template: PresetDraftTemplate): Set<string> {
  const definitions = template.variables ?? {};
  const required = new Set<string>();
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      for (const part of tokens(value, definitions, "template")) {
        if (typeof part !== "string" && !Object.hasOwn(definitions[part.name]!, "default")) {
          required.add(part.name);
        }
      }
    } else if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        visit(key);
        visit(child);
      }
    }
  };
  visit(template.agent);
  visit(template.configuration);
  return required;
}

// Credential admission permits unfilled string references while validating literal/default values.
export function unresolvedPresetVariableTypes(
  value: unknown,
  definitions: Definitions,
): PresetVariable["type"][] {
  if (typeof value !== "string") {
    return [];
  }
  return tokens(value, definitions, "template")
    .filter(
      (part): part is VariableToken =>
        typeof part !== "string" && !Object.hasOwn(definitions[part.name]!, "default"),
    )
    .map(({ name }) => definitions[name]!.type);
}
