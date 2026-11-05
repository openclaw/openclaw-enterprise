// Seeded sample values for the JSON Schema subset the API's route schemas use, and
// perturbations of them, for differential tests that feed the same inputs to two compiled
// validators or serializers. Samples aim to be valid (patterns, formats, lengths, ranges,
// required fields); perturbations break one thing at a random depth.

export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (random, values) => values[Math.floor(random() * values.length)];
const integer = (random, low, high) => low + Math.floor(random() * (high - low + 1));

// Printable ASCII plus a few characters patterns commonly refuse or special-case.
const ALPHABET = [
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.~:@/ ",
  "é",
  "😀",
  "\t",
  "\u0000",
  " ",
];

// One string the regular expression source may match: literals, classes, groups,
// alternation and quantifiers. Lookarounds and backreferences are skipped; callers check
// the result against the real expression.
function synthesize(random, source) {
  let position = 0;
  const atEnd = () => position >= source.length;
  function escapeClass(character) {
    switch (character) {
      case "d":
        return [..."0123456789"];
      case "w":
        return [..."abcxyzABC0189_"];
      case "s":
        return [" ", "\t", "\n"];
      case "S":
        return [..."abc019-_"];
      case "D":
        return [..."abc-_"];
      case "W":
        return [..."-. /"];
      default:
        return undefined;
    }
  }
  function escaped() {
    const character = source[position++];
    const set = escapeClass(character);
    if (set !== undefined) {
      return set;
    }
    if (character === "x") {
      const code = source.slice(position, position + 2);
      position += 2;
      return [String.fromCharCode(Number.parseInt(code, 16))];
    }
    if (character === "u") {
      const code = source.slice(position, position + 4);
      position += 4;
      return [String.fromCharCode(Number.parseInt(code, 16))];
    }
    const controls = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v", 0: "\0" };
    return [controls[character] ?? character];
  }
  function characterClass() {
    const negated = source[position] === "^";
    if (negated) {
      position += 1;
    }
    const members = new Set();
    while (!atEnd() && source[position] !== "]") {
      let from;
      if (source[position] === "\\") {
        position += 1;
        const set = escaped();
        if (set.length > 1) {
          set.forEach((member) => members.add(member));
          continue;
        }
        [from] = set;
      } else {
        from = source[position++];
      }
      if (source[position] === "-" && source[position + 1] !== "]") {
        position += 1;
        let to;
        if (source[position] === "\\") {
          position += 1;
          [to] = escaped();
        } else {
          to = source[position++];
        }
        const start = from.codePointAt(0);
        const end = to.codePointAt(0);
        const step = Math.max(1, Math.floor((end - start) / 24));
        for (let code = start; code <= end; code += step) {
          members.add(String.fromCodePoint(code));
        }
        members.add(to);
      } else {
        members.add(from);
      }
    }
    position += 1;
    if (!negated) {
      return [...members];
    }
    const others = ALPHABET.filter((character) => !members.has(character));
    return others.length > 0 ? others : ["a"];
  }
  function quantifier() {
    const character = source[position];
    if (character === "?") {
      position += 1;
      return [0, 1];
    }
    if (character === "*") {
      position += 1;
      return [0, 3];
    }
    if (character === "+") {
      position += 1;
      return [1, 3];
    }
    if (character === "{") {
      const match = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(position));
      if (match) {
        position += match[0].length;
        const low = Number(match[1]);
        const high = match[2] === undefined ? low : match[3] === "" ? low + 3 : Number(match[3]);
        return [low, Math.min(high, low + 8)];
      }
    }
    return [1, 1];
  }
  function sequence() {
    let text = "";
    while (!atEnd() && source[position] !== "|" && source[position] !== ")") {
      const character = source[position++];
      let produce;
      if (character === "^" || character === "$") {
        continue;
      } else if (character === "(") {
        let lookaround = false;
        if (source[position] === "?") {
          lookaround = source[position + 1] !== ":";
          position += lookaround && source[position + 1] === "<" ? 3 : 2;
        }
        const inner = alternation();
        position += 1;
        produce = () => (lookaround ? "" : inner());
      } else if (character === "[") {
        const members = characterClass();
        produce = () => pick(random, members);
      } else if (character === "\\") {
        const members = escaped();
        produce = () => pick(random, members);
      } else if (character === ".") {
        produce = () => pick(random, ALPHABET.slice(0, 66));
      } else {
        produce = () => character;
      }
      const [low, high] = quantifier();
      if (source[position] === "?") {
        position += 1;
      }
      const count = integer(random, low, high);
      for (let index = 0; index < count; index += 1) {
        text += produce();
      }
    }
    return text;
  }
  function alternation() {
    const start = position;
    const branches = [];
    for (;;) {
      const branchStart = position;
      sequence();
      branches.push([branchStart, position]);
      if (source[position] !== "|") {
        break;
      }
      position += 1;
    }
    const end = position;
    return () => {
      const [from, to] = pick(random, branches);
      const saved = position;
      position = from;
      const text = sequence();
      position = saved;
      void to;
      void start;
      void end;
      return text;
    };
  }
  return alternation()();
}

function ucs2Length(text) {
  return [...text].length;
}

const FORMAT_SAMPLES = {
  "date-time": ["2026-10-14T00:00:00.000Z", "2026-10-14T12:34:56Z", "2026-10-14T12:34:56+02:00"],
  date: ["2026-10-14"],
  time: ["12:34:56Z"],
  uri: ["https://example.com/path?query=1", "http://127.0.0.1:8080/", "urn:example:a"],
  email: ["person@example.com", "a.b+c@example.org"],
  uuid: ["0000000a-0000-4000-8000-00000000000b", "123e4567-e89b-42d3-a456-426614174000"],
  hostname: ["example.com"],
  ipv4: ["192.0.2.10"],
};

function resolveReference(reference, root, shared) {
  const [id, fragment = ""] = reference.split("#");
  let target = id === "" ? root : shared[id];
  if (target === undefined) {
    return undefined;
  }
  for (const segment of fragment.split("/").filter(Boolean)) {
    target = target?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return target;
}

function randomJson(random, depth) {
  const kind = depth > 2 ? integer(random, 0, 3) : integer(random, 0, 5);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return random() < 0.5;
    case 2:
      return pick(random, [0, 1, -1, 2.5, 1e21, 2 ** 53, -0.000001]);
    case 3:
      return pick(random, ["", "text", "ns_x", "😀", "\u0000", " lead", "a".repeat(300)]);
    case 4:
      return Array.from({ length: integer(random, 0, 3) }, () => randomJson(random, depth + 1));
    default:
      return Object.fromEntries(
        Array.from({ length: integer(random, 0, 3) }, (_, index) => [
          pick(random, ["a", "name", "kind", "__proto__x", `k${index}`]),
          randomJson(random, depth + 1),
        ]),
      );
  }
}

function sampleString(random, schema) {
  const minLength = schema.minLength ?? 0;
  const maxLength = schema.maxLength ?? Infinity;
  const pattern = typeof schema.pattern === "string" ? new RegExp(schema.pattern, "u") : undefined;
  const fits = (text) =>
    ucs2Length(text) >= minLength &&
    ucs2Length(text) <= maxLength &&
    (pattern === undefined || pattern.test(text));
  if (typeof schema.format === "string" && FORMAT_SAMPLES[schema.format]) {
    const candidates = FORMAT_SAMPLES[schema.format].filter(fits);
    if (candidates.length > 0) {
      return pick(random, candidates);
    }
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let text;
    if (pattern !== undefined) {
      text = synthesize(random, schema.pattern);
    } else {
      const length = integer(random, minLength, Math.min(maxLength, minLength + 12));
      text = Array.from({ length }, () => pick(random, ALPHABET.slice(0, 62))).join("");
    }
    if (fits(text)) {
      return text;
    }
  }
  return "a".repeat(minLength);
}

function sampleNumber(random, schema, integral) {
  let low = schema.minimum ?? (schema.exclusiveMinimum ?? -1000) + (integral ? 1 : 0.5);
  let high = schema.maximum ?? (schema.exclusiveMaximum ?? 1000) - (integral ? 1 : 0.5);
  if (low > high) {
    high = low;
  }
  const value = integral
    ? integer(random, Math.ceil(low), Math.floor(high))
    : low + random() * (high - low);
  const candidates = [value, low, high];
  if (low <= 0 && high >= 0) {
    candidates.push(0);
  }
  return pick(random, candidates);
}

/** A value meant to satisfy `schema`; `shared` resolves `$ref`s by schema $id. */
export function sampleValue(random, schema, shared, root = schema, depth = 0) {
  if (schema === true || schema === undefined) {
    return randomJson(random, depth);
  }
  if (schema === false) {
    return null;
  }
  if (typeof schema.$ref === "string") {
    const target = resolveReference(schema.$ref, root, shared);
    const nextRoot = schema.$ref.startsWith("#") ? root : shared[schema.$ref.split("#")[0]];
    return target === undefined
      ? randomJson(random, depth)
      : sampleValue(random, target, shared, nextRoot, depth + 1);
  }
  if (Object.hasOwn(schema, "const")) {
    return structuredClone(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    return structuredClone(pick(random, schema.enum));
  }
  const unionKey = Array.isArray(schema.anyOf) ? "anyOf" : "oneOf";
  const union = schema[unionKey];
  if (Array.isArray(union)) {
    // Deep recursive values (SafeJsonValue) lean towards the leaves.
    const branches =
      depth > 5
        ? union.filter((branch) => branch.type !== "object" && branch.type !== "array")
        : union;
    const branch = pick(random, branches.length > 0 ? branches : union);
    const { [unionKey]: _union, ...siblings } = schema;
    // Union branches add constraints to the surrounding schema.
    const selected = branch === false ? false : { ...siblings, ...branch };
    if (siblings.properties && branch?.properties) {
      selected.properties = { ...siblings.properties, ...branch.properties };
    }
    if (siblings.required && branch?.required) {
      selected.required = [...new Set([...siblings.required, ...branch.required])];
    }
    return sampleValue(random, selected, shared, root, depth + 1);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return sampleValue(random, schema.allOf[0], shared, root, depth + 1);
  }
  const type = Array.isArray(schema.type) ? pick(random, schema.type) : schema.type;
  switch (type) {
    case "object": {
      const value = {};
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? []);
      for (const [name, property] of Object.entries(properties)) {
        if (required.has(name) || (depth < 6 && random() < 0.5)) {
          value[name] = sampleValue(random, property, shared, root, depth + 1);
        }
      }
      for (const name of required) {
        if (!Object.hasOwn(value, name)) {
          value[name] = randomJson(random, depth + 1);
        }
      }
      // minProperties: fill from the declared properties first, then the pattern ones.
      for (const [name, property] of Object.entries(properties)) {
        if (Object.keys(value).length >= (schema.minProperties ?? 0)) {
          break;
        }
        value[name] ??= sampleValue(random, property, shared, root, depth + 1);
      }
      for (const [pattern, property] of Object.entries(schema.patternProperties ?? {})) {
        for (
          let attempt = 0;
          Object.keys(value).length < (schema.minProperties ?? 0) && attempt < 8;
          attempt += 1
        ) {
          const name = sampleString(random, { pattern, maxLength: 40 });
          value[name] = sampleValue(random, property, shared, root, depth + 1);
        }
      }
      const room = (schema.maxProperties ?? Infinity) - Object.keys(value).length;
      if (schema.patternProperties && room > 0 && depth < 6) {
        for (const [pattern, property] of Object.entries(schema.patternProperties)) {
          if (random() < 0.6) {
            const name = sampleString(random, { pattern, maxLength: 40 });
            value[name] = sampleValue(random, property, shared, root, depth + 1);
          }
        }
      } else if (
        typeof schema.additionalProperties === "object" &&
        room > 0 &&
        depth < 6 &&
        random() < 0.5
      ) {
        value[`extra${integer(random, 0, 9)}`] = sampleValue(
          random,
          schema.additionalProperties,
          shared,
          root,
          depth + 1,
        );
      }
      return value;
    }
    case "array": {
      const minItems = schema.minItems ?? 0;
      const maxItems = Math.min(schema.maxItems ?? minItems + 3, minItems + (depth > 4 ? 0 : 3));
      const items = [];
      const seen = new Set();
      const count = integer(random, minItems, Math.max(minItems, maxItems));
      for (let attempt = 0; items.length < count && attempt < count * 4 + 4; attempt += 1) {
        const item = sampleValue(random, schema.items, shared, root, depth + 1);
        const key = JSON.stringify(item);
        if (schema.uniqueItems && seen.has(key)) {
          continue;
        }
        seen.add(key);
        items.push(item);
      }
      return items;
    }
    case "string":
      return sampleString(random, schema);
    case "integer":
      return sampleNumber(random, schema, true);
    case "number":
      return sampleNumber(random, schema, false);
    case "boolean":
      return random() < 0.5;
    case "null":
      return null;
    default:
      return randomJson(random, depth);
  }
}

function paths(value, prefix = [], found = []) {
  found.push(prefix);
  if (value !== null && typeof value === "object" && prefix.length < 8) {
    for (const key of Object.keys(value)) {
      paths(value[key], [...prefix, key], found);
    }
  }
  return found;
}

const REPLACEMENTS = [
  null,
  true,
  0,
  -1,
  1.5,
  2 ** 31,
  "",
  " padded ",
  "a".repeat(257),
  "x".repeat(4100),
  "\u0000",
  "😀".repeat(3),
  "ns_00000000-0000-4000-8000-000000000000",
  [],
  [1, 1],
  {},
  { unexpected: true },
  // Strings of the right type in the wrong format, so format checks are exercised too.
  "2026-02-30T00:00:00Z",
  "2026-10-14T25:00:00Z",
  "2026-10-14",
  "12:34:56",
  "not a uri",
  "http://exa mple.com/",
  "person@",
  "0000000a-0000-4000-8000-00000000000",
  "192.0.2.256",
];

// Strings just outside each format, for values sampleString took from FORMAT_SAMPLES.
const FORMAT_NEAR_MISSES = {
  "date-time": [
    "2026-02-30T00:00:00Z",
    "2026-10-14T25:00:00Z",
    "2026-10-14T12:34:60Z",
    "2026-10-14 12:34:56",
    "2026-10-14",
  ],
  date: ["2026-02-30", "2026-13-01", "2026-10-14T00:00:00Z"],
  time: ["25:00:00Z", "12:34", "12:34:56+25:00"],
  uri: ["not a uri", "http://exa mple.com/", "//example.com/path", "example.com"],
  email: ["person@", "@example.com", "person example.com"],
  uuid: ["0000000a-0000-4000-8000-00000000000", "0000000a00004000800000000000000b"],
  hostname: ["-example.com", "exa_mple.com"],
  ipv4: ["192.0.2.256", "192.0.2"],
};

// A string one edit away from `text`, which a pattern, length or format check usually decides.
function nearMiss(random, text) {
  const format = Object.keys(FORMAT_SAMPLES).find((name) => FORMAT_SAMPLES[name].includes(text));
  if (format !== undefined && random() < 0.75) {
    return pick(random, FORMAT_NEAR_MISSES[format]);
  }
  switch (integer(random, 0, 4)) {
    case 0:
      return `${text}!`;
    case 1:
      return text.slice(0, -1);
    case 2:
      return text.toUpperCase();
    case 3:
      return ` ${text}`;
    default:
      return text.length === 0 ? "-" : `${text.slice(0, -1)}-`;
  }
}

/**
 * `value` with one change: a field removed, replaced with another type or edge value (or a
 * string one edit away), an unknown field added, or an array item repeated. `nonJson` also allows values only a
 * handler can return (Dates, toJSON objects, undefined, NaN, BigInt), for serializers.
 */
export function perturbValue(random, value, { nonJson = false } = {}) {
  const copy = structuredClone(value);
  const replacements = nonJson
    ? [
        ...REPLACEMENTS,
        new Date(Date.UTC(2026, 9, 14)),
        { toJSON: () => "from toJSON" },
        undefined,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        10n,
        "123",
        "true",
      ]
    : REPLACEMENTS;
  const all = paths(copy);
  const path = pick(random, all);
  if (path.length === 0) {
    return pick(random, replacements);
  }
  let parent = copy;
  for (const key of path.slice(0, -1)) {
    parent = parent[key];
  }
  const key = path.at(-1);
  const action = integer(random, 0, 4);
  if (action === 4 && typeof parent[key] === "string") {
    parent[key] = nearMiss(random, parent[key]);
  } else if (action === 0 && !Array.isArray(parent)) {
    delete parent[key];
  } else if (action === 1 && parent[key] !== null && typeof parent[key] === "object") {
    if (Array.isArray(parent[key])) {
      parent[key].push(parent[key][0] ?? null);
    } else {
      parent[key][pick(random, ["unexpected", "__proto__", "constructor", "Name"])] = pick(
        random,
        replacements,
      );
    }
  } else {
    parent[key] = pick(random, replacements);
  }
  return copy;
}
