import { jsonPointer } from "./error-details.ts";
import { cappedPath, failure, type RequestFailure } from "./errors.ts";

/**
 * The deepest level below a request body's root at which a JSON value may sit. The deepest
 * documented OpenClaw setting sits 11 levels into Configuration values, which makes 12 in a
 * Configuration body and 14 in a Preset body; shipped Presets reach 11.
 */
export const MAX_JSON_BODY_DEPTH = 24;

/** The answer for a value nested deeper than MAX_JSON_BODY_DEPTH, at `path` (a JSON Pointer). */
export function tooDeepFailure(path: string): RequestFailure {
  return failure(400, "INVALID_REQUEST", "The supplied configuration is invalid.", [
    { path: cappedPath(path), code: "TOO_DEEP" },
  ]);
}

// Longer than any key a capped detail path can show.
const MAX_KEY_LENGTH = 1024;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const SPACE = 0x20;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/**
 * Whether the raw object key from `start` to `end` (quotes included) is `name`. Only short keys
 * are decoded: an escaped `name` is at most six characters per character, plus its quotes.
 */
function keyIs(text: string, start: number | undefined, end: number | undefined, name: string) {
  if (start === undefined || end === undefined || end - start > 6 * name.length + 2) {
    return false;
  }
  const raw = text.slice(start, end);
  if (raw === `"${name}"`) {
    return true;
  }
  // Only an escape can make other text decode to the name.
  if (!raw.includes("\\")) {
    return false;
  }
  try {
    return JSON.parse(raw) === name;
  } catch {
    return false;
  }
}

/**
 * Finds the first value in raw JSON `text` that sits more than `maxDepth` levels below the
 * root, in document order, before anything parses the text: building the objects of a deeply
 * nested body costs memory in proportion to its depth, and recursive checks of them overflow
 * the stack. One pass, with state bounded by `maxDepth`. Returns that value's JSON Pointer
 * (keys cut to MAX_KEY_LENGTH characters), or undefined. It does not check syntax; invalid
 * text that it passes still fails to parse.
 *
 * `extraLevelBelow` names a value two object keys below the root whose own contents may sit
 * one level deeper: a body that wraps another body's document one level further down (Create
 * Agent's preflight carries Configuration values at `/configuration/values`, one level below
 * Configuration create's `/values`). The allowance holds only inside that value and ends when
 * it closes, so its siblings keep `maxDepth`.
 */
export function tooDeepJsonPath(
  text: string,
  maxDepth: number = MAX_JSON_BODY_DEPTH,
  extraLevelBelow?: readonly [string, string],
): string | undefined {
  // For each open container, outermost first: whether it is an array, and the position of the
  // entry being read (an array index, or where an object's current key starts and ends).
  const isArray: boolean[] = [];
  const index: number[] = [];
  const keyStart: number[] = [];
  const keyEnd: number[] = [];
  let depth = 0;
  // Whether a string here would be an object key (after "{" or "," in an object).
  let expectKey = false;
  // Whether the container most recently opened one level below the root is the value of
  // extraLevelBelow's first key (a container two levels down always opens inside it), and the
  // depth that extraLevelBelow's value opened at while it is open (or -1).
  let firstKeyOpen = false;
  let extendedAt = -1;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    switch (code) {
      case SPACE:
      case TAB:
      case LINE_FEED:
      case CARRIAGE_RETURN:
        continue;
      case COMMA:
        if (depth > 0 && isArray[depth - 1] === true) {
          index[depth - 1]! += 1;
        } else {
          expectKey = true;
        }
        continue;
      case COLON:
        expectKey = false;
        continue;
      case CLOSE_OBJECT:
      case CLOSE_ARRAY:
        depth = Math.max(depth - 1, 0);
        expectKey = false;
        if (depth <= extendedAt) {
          extendedAt = -1;
        }
        continue;
    }
    // A key is not a value: the value after its colon is checked.
    const key = code === QUOTE && expectKey && depth > 0;
    if (!key && depth > (extendedAt < 0 ? maxDepth : maxDepth + 1)) {
      return pathAt(text, depth, isArray, index, keyStart, keyEnd);
    }
    if (code === QUOTE) {
      const start = at;
      for (at += 1; at < text.length; at += 1) {
        const inner = text.charCodeAt(at);
        if (inner === BACKSLASH) {
          at += 1;
        } else if (inner === QUOTE) {
          break;
        }
      }
      if (key) {
        keyStart[depth - 1] = start;
        keyEnd[depth - 1] = at + 1;
      }
    } else if (code === OPEN_OBJECT || code === OPEN_ARRAY) {
      if (extraLevelBelow !== undefined && !expectKey) {
        if (depth === 1) {
          firstKeyOpen =
            isArray[0] === false && keyIs(text, keyStart[0], keyEnd[0], extraLevelBelow[0]);
        } else if (depth === 2 && firstKeyOpen && isArray[1] === false) {
          if (keyIs(text, keyStart[1], keyEnd[1], extraLevelBelow[1])) {
            extendedAt = depth;
          }
        }
      }
      isArray[depth] = code === OPEN_ARRAY;
      index[depth] = 0;
      depth += 1;
      expectKey = code === OPEN_OBJECT;
    }
  }
  return undefined;
}

function pathAt(
  text: string,
  depth: number,
  isArray: readonly boolean[],
  index: readonly number[],
  keyStart: readonly number[],
  keyEnd: readonly number[],
): string {
  let path = "";
  for (let level = 0; level < depth; level += 1) {
    let segment: string;
    if (isArray[level] === true) {
      segment = String(index[level]);
    } else {
      // Invalid text can hold an object entry without a key (or name a stale one); never parse
      // more than one string.
      const start = keyStart[level];
      const raw = start === undefined ? '""' : text.slice(start, keyEnd[level]);
      try {
        segment = JSON.parse(raw) as string;
      } catch {
        // Not valid JSON: the body fails to parse anyway, so name the key as sent.
        segment = raw.slice(1, -1);
      }
      // The detail path shows at most 512 characters, so a longer key is cut before the
      // per-character work below, which on a 6 MB key would cost hundreds of megabytes.
      // As unstorableTextFailure names keys, text a client cannot store is shown as "?".
      segment = segment
        .slice(0, MAX_KEY_LENGTH)
        .replaceAll("\u0000", "?")
        .replace(/\p{Cs}/gu, "?");
    }
    path += `/${jsonPointer(segment)}`;
  }
  return path;
}

/**
 * The parsed-body counterpart of tooDeepJsonPath, with the same `maxDepth` and
 * `extraLevelBelow`, for a body the JSON parser already read (it keeps the rule for any other
 * input). It also refuses an object key that names a prototype. Throws the request failure.
 */
export function checkJsonValue(
  value: unknown,
  maxDepth: number = MAX_JSON_BODY_DEPTH,
  extraLevelBelow?: readonly [string, string],
): void {
  checkValue(value, 0, "", maxDepth, extraLevelBelow, extraLevelBelow === undefined ? 0 : 1);
}

// `stage` is 1 at the root and 2 in the value of extraLevelBelow's first key, where the step into
// its second key is not counted; 0 everywhere else.
function checkValue(
  value: unknown,
  depth: number,
  path: string,
  maxDepth: number,
  extraLevelBelow: readonly [string, string] | undefined,
  stage: 0 | 1 | 2,
): void {
  if (depth > maxDepth) {
    throw tooDeepFailure(path);
  }
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      checkValue(entry, depth + 1, `${path}/${index}`, maxDepth, undefined, 0);
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}/${jsonPointer(key)}`;
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw failure(400, "INVALID_REQUEST", "The supplied configuration is invalid.", [
        { path: cappedPath(entryPath), code: "INVALID_VALUE" },
      ]);
    }
    if (stage === 1 && key === extraLevelBelow![0]) {
      checkValue(entry, depth + 1, entryPath, maxDepth, extraLevelBelow, 2);
    } else if (stage === 2 && key === extraLevelBelow![1]) {
      checkValue(entry, depth, entryPath, maxDepth, undefined, 0);
    } else {
      checkValue(entry, depth + 1, entryPath, maxDepth, undefined, 0);
    }
  }
}
