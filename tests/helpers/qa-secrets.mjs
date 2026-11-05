import assert from "node:assert/strict";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { inspect, types } from "node:util";
import {
  failureSecrets,
  maskPrivateKeyLines,
  redactOutputLine,
} from "../../scripts/ci/failure-redaction.mjs";

const protectedValues = new Set();

// The forms a registered value takes in logs and API errors besides itself:
// JSON-escaped (pino's JSON lines, and Go's, which also escapes <, > and &),
// base64 (a Secret's `data` in a kube API error) and percent-encoded. A value
// shorter than 8 characters gets no base64 forms, which would be short enough
// to garble unrelated text.
export function qaSecretVariants(value) {
  const json = JSON.stringify(value).slice(1, -1);
  const goJson = json.replace(
    /[<>&\u2028\u2029]/gu,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const bytes = Buffer.from(value, "utf8");
  return [
    ...new Set([
      value,
      json,
      goJson,
      ...(value.length >= 8 ? [bytes.toString("base64"), bytes.toString("base64url")] : []),
      encodeURIComponent(value),
    ]),
  ];
}

export function registerQaSecret(value) {
  for (const variant of qaSecretVariants(value)) {
    protectedValues.add(variant);
  }
}

// How deep redaction follows nested values (a cause chain, AggregateError
// errors, a parsed response body). node:test prints only a few levels; a deeper
// value is cut to "[Truncated]" rather than left unredacted.
const maxErrorDepth = 8;
// Read even when inherited: a DOMException's message, name and code are getters
// on its prototype.
const inheritedErrorFields = ["name", "message", "stack", "code"];

function isError(value) {
  return types.isNativeError(value) || value instanceof Error;
}

// Redacts registered secrets from every field of a thrown value that the test
// runner prints (it uses util.inspect, getters included): message and stack, an
// execFile error's cmd, stdout and stderr (strings or Buffers), every other own
// field, the `cause` chain and AggregateError `errors`, recursively, including
// arrays, Maps, Sets and objects inside them. A thrown string is redacted too.
// A value that holds no registered secret is returned untouched.
//
// Errors are updated in place, including an Error that is only referenced (an
// assertion's `expected`). Any other object an error refers to (an assertion's
// `actual`, a shared fixture) is never written: a redacted copy takes its place
// in the error. An object whose printed form comes from hidden state (a URL,
// Headers, a Promise) is replaced by its redacted inspect text when that text
// holds a secret. When an error's field cannot be written (a
// DOMException's getter-only `message`, an own getter, a frozen error, a
// throwing setter), a plain Error carrying the redacted fields replaces it. A
// replacement keeps only redacted values, never the original. A value that
// points back up its own chain becomes "[Circular]", so no cycle leads from a
// replacement to an unredacted original. If redaction itself throws (a proxy
// trap), a bare Error carrying only the redacted message is returned. Getters
// run at least once per pass; one that returns a secret only on a later call
// can slip past the first pass.
export function redactQaError(error) {
  // Longest first, so a value containing another is replaced whole.
  const secrets = [...protectedValues].sort((a, b) => b.length - a.length);
  const marker = Buffer.from("[REDACTED]");
  const secretBytes = secrets.map((secret) => Buffer.from(secret, "utf8"));
  let found = false;
  let dryRun = true;
  const redactText = (text) => {
    const redacted = secrets.reduce(
      (value, secret) => value.replaceAll(secret, "[REDACTED]"),
      text,
    );
    found ||= redacted !== text;
    return redacted;
  };
  // Byte for byte, so the rest of a binary buffer survives unchanged.
  const redactBytes = (view) => {
    let bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
    let changed = false;
    for (const secret of secretBytes) {
      const parts = [];
      let start = 0;
      for (let index = bytes.indexOf(secret); index !== -1; index = bytes.indexOf(secret, start)) {
        parts.push(bytes.subarray(start, index), marker);
        start = index + secret.length;
      }
      if (parts.length > 0) {
        bytes = Buffer.concat([...parts, bytes.subarray(start)]);
        changed = true;
      }
    }
    found ||= changed;
    return changed ? bytes : view;
  };
  // How inspect escapes a secret inside a quoted string, which differs from JSON
  // for quotes and control characters (a multi-line JSON key file), with the
  // single quote escaped too for when the string holds every quote kind.
  const printOptions = { breakLength: Infinity, maxStringLength: Infinity };
  const printedForms = secrets
    .flatMap((secret) => {
      const body = inspect(secret, printOptions).slice(1, -1);
      return [body, body.replaceAll("'", "\\'")];
    })
    .filter((form) => form.length > 0)
    .sort((a, b) => b.length - a.length);
  let done = new Map();
  const active = new Set();

  const redactValue = (value, depth) => {
    if (typeof value === "string") {
      return redactText(value);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (ArrayBuffer.isView(value)) {
      return redactBytes(value);
    }
    if (types.isAnyArrayBuffer(value)) {
      const bytes = redactBytes(new Uint8Array(value));
      return bytes instanceof Buffer ? bytes : value;
    }
    if (active.has(value)) {
      return "[Circular]";
    }
    // A value first reached deeper may have been cut there; walk it again.
    const cached = done.get(value);
    if (cached && cached.depth <= depth) {
      return cached.result;
    }
    if (depth > maxErrorDepth) {
      return "[Truncated]";
    }
    active.add(value);
    let result;
    try {
      result = isError(value) ? redactError(value, depth) : copyRedacted(value, depth);
    } finally {
      active.delete(value);
    }
    done.set(value, { result, depth });
    return result;
  };

  // Own fields (symbol keys included) and, for an error, the inherited ones.
  const redactFields = (object, depth, keys) => {
    const fields = [];
    for (const key of new Set([...keys, ...Reflect.ownKeys(object)])) {
      let value;
      try {
        value = object[key];
      } catch {
        continue;
      }
      if (value === undefined && !Object.hasOwn(object, key)) {
        continue;
      }
      fields.push([key, value, redactValue(value, depth + 1)]);
    }
    return fields;
  };

  // Arrays, Maps, Sets and other objects: the original when nothing changed,
  // otherwise a copy holding the redacted values (a plain object for anything
  // that is not an array, Map or Set). Functions are left out of a copy. An
  // unchanged object that is not a plain one is checked through its printed
  // form too: hidden state, a custom inspect method, a Map's own properties.
  const copyRedacted = (value, depth) => {
    const copy = copyFields(value, depth);
    const prototype = Object.getPrototypeOf(value);
    if (copy !== value || prototype === Object.prototype || prototype === null) {
      return copy;
    }
    let text;
    try {
      // On one line and uncut, so a multi-line secret (a PEM key) stays whole.
      text = inspect(value, { ...printOptions, depth: 2, getters: true });
    } catch {
      // A throwing custom inspect method: the runner can't print it either.
      return value;
    }
    const redacted = printedForms.reduce(
      (current, form) => current.replaceAll(form, "[REDACTED]"),
      redactText(text),
    );
    found ||= redacted !== text;
    return redacted === text ? value : redacted;
  };

  const copyFields = (value, depth) => {
    if (Array.isArray(value)) {
      const items = value.map((item) => redactValue(item, depth + 1));
      return items.every((item, index) => item === value[index]) ? value : items;
    }
    if (value instanceof Map || value instanceof Set) {
      const entries = [...value.entries()];
      const redacted = entries.map(([key, item]) => [
        redactValue(key, depth + 1),
        redactValue(item, depth + 1),
      ]);
      if (
        redacted.every(
          ([key, item], index) => key === entries[index][0] && item === entries[index][1],
        )
      ) {
        return value;
      }
      return value instanceof Map ? new Map(redacted) : new Set(redacted.map(([key]) => key));
    }
    const fields = redactFields(value, depth, []);
    if (fields.every(([, item, redacted]) => item === redacted)) {
      return value;
    }
    return Object.fromEntries(
      fields
        .filter(([, , redacted]) => typeof redacted !== "function")
        .map(([key, , redacted]) => [key, redacted]),
    );
  };

  const redactError = (object, depth) => {
    const fields = redactFields(object, depth, inheritedErrorFields);
    if (dryRun) {
      return object;
    }
    const write = (key, value) => {
      try {
        return Reflect.set(object, key, value) && object[key] === value;
      } catch {
        return false;
      }
    };
    if (fields.every(([key, value, redacted]) => value === redacted || write(key, redacted))) {
      return object;
    }
    // Every kept value went through redactValue; functions are dropped.
    const kept = fields
      .map(([key, , redacted]) => [key, redacted])
      .filter(([, value]) => typeof value !== "function");
    const values = new Map(kept);
    const message = values.get("message");
    const replacement = new Error(typeof message === "string" ? message : "[REDACTED]");
    for (const [key, value] of kept) {
      if (key !== "message" && key !== "stack") {
        replacement[key] = value;
      }
    }
    const stack = values.get("stack");
    replacement.stack =
      typeof stack === "string" ? stack : `${replacement.name}: ${replacement.message}`;
    return replacement;
  };

  try {
    // A first pass writes nothing and only looks for a secret, so an error
    // without one keeps its cycles, depth and identity.
    redactValue(error, 0);
    if (!found) {
      return error;
    }
    dryRun = false;
    done = new Map();
    return redactValue(error, 0);
  } catch {
    let message = "[REDACTED: the thrown value could not be redacted]";
    try {
      if (typeof error?.message === "string") {
        message = redactText(error.message);
      }
    } catch {
      // Keep the placeholder.
    }
    return new Error(message);
  }
}

// Command arguments and stdout can contain API payloads. Publish only a bounded
// stderr tail, using the CI redactor plus dynamically generated fixture secrets.
export function qaCommandFailureDetail(stderr, env) {
  return redactedQaTail(stderr, env, { lines: 8, lineChars: 800 }).join("\n");
}

// The last `lines` lines of `text` (a command's stderr or a component log),
// each cut to `lineChars` after the same redaction: environment values, every
// registered fixture secret, common token shapes, and whole credential-bearing lines.
export function redactedQaTail(text, env, { lines, lineChars }) {
  const secrets = [
    ...failureSecrets([env]),
    // Text is redacted line by line, so each line of a multi-line value (a PEM
    // key) is a value of its own, as failureSecrets does for the environment.
    ...[...protectedValues].flatMap((value) => [
      [value, "qa-secret"],
      ...(value.includes("\n")
        ? value
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length >= 8)
            .map((line) => [line, "qa-secret"])
        : []),
    ]),
  ].sort(([a], [b]) => b.length - a.length);
  // A private key's body lines are found across the whole text, so a key that
  // starts above the tail still loses the lines inside it.
  return maskPrivateKeyLines(
    String(text ?? "")
      .trimEnd()
      .split("\n"),
  )
    .slice(-lines)
    .map((line) => redactOutputLine(line, secrets, "", lineChars));
}

// Only the explicit API-key QA scenario accepts process-environment injection.
// Register before an API call or assertion can include the value in an error.
export async function protectedModelApiKey(env = process.env) {
  if (env.OCC_TEST_QA_MODEL_API_KEY === undefined) {
    return protectedText(env.OCC_TEST_QA_OPENAI_KEY_FILE, "model credential");
  }
  const value = env.OCC_TEST_QA_MODEL_API_KEY.trim();
  assert.ok(value.length > 0, "model credential must not be empty");
  registerQaSecret(value);
  return value;
}

export async function protectedText(path, label) {
  assert.ok(path, `${label} path is required`);
  // Check and read the same opened file; never follow a substituted symlink.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    assert.ok(
      info.isFile() && (info.mode & 0o077) === 0,
      `${label} must be a private regular file`,
    );
    const value = (await file.readFile("utf8")).trim();
    assert.ok(value.length > 0, `${label} must not be empty`);
    registerQaSecret(value);
    return value;
  } finally {
    await file.close();
  }
}

export async function grantQaSecret(f, agent, secretId, name) {
  const base = `/namespaces/${agent.namespaceId}`;
  const role = await f.api("POST", `${base}/iam/roles`, {
    name,
    permissions: [{ action: "operate", resourceKind: "secret" }],
  });
  await f.api("POST", `${base}/iam/access-bindings`, {
    subjectKind: "identity",
    subjectId: agent.servicePrincipalId,
    roleId: role.id,
    resourceKind: "secret",
    resourceId: secretId,
  });
}
