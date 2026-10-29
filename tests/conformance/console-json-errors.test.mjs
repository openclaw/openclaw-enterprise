import assert from "node:assert/strict";
import test from "node:test";
import { jsonErrorOffset, jsonObjectProblem } from "../../apps/controller/src/console/dom.mts";

const at = (line, column) =>
  `Invalid JSON at line ${line}, column ${column}. Enter a valid JSON object.`;

test("text after the JSON value names where it starts (finding 1939)", () => {
  // V8 words this "Unexpected non-whitespace character after JSON at position N".
  assert.equal(jsonObjectProblem('{\n  "a": 1\n}\n}'), at(4, 1));
  assert.equal(jsonObjectProblem('{"a": 1} {"b": 2}'), at(1, 10));
  assert.equal(jsonObjectProblem('{"a": 1}\n  x'), at(2, 3));
});

test("a bare word or a partial literal names the character that breaks it (finding 1939)", () => {
  // V8 gives no position for these: "Unexpected token 'g', ... is not valid JSON".
  assert.equal(jsonObjectProblem('{\n  "x": gpt\n}'), at(2, 8));
  assert.equal(jsonObjectProblem('{"a": tr}'), at(1, 9));
  assert.equal(jsonObjectProblem('{"a": nul'), at(1, 10));
  assert.equal(jsonObjectProblem("tru"), at(1, 4));
});

test("a leading byte order mark is named, not given an invisible position (finding 1939)", () => {
  assert.equal(
    jsonObjectProblem('\uFEFF{"a": 1}'),
    "Invalid JSON: remove the invisible byte order mark at the start. Enter a valid JSON object.",
  );
  // Inside a string it is ordinary text.
  assert.equal(jsonObjectProblem('{"a": "\uFEFF"}'), undefined);
});

test("an invisible or space-like character elsewhere is named at its position", () => {
  assert.equal(
    jsonObjectProblem('\n  \uFEFF{"a": 1}'),
    "Invalid JSON at line 2, column 3: remove the invisible byte order mark there. Enter a valid JSON object.",
  );
  assert.equal(
    jsonObjectProblem('{"a":\u00A01}'),
    "Invalid JSON at line 1, column 6: remove the non-breaking space there. Enter a valid JSON object.",
  );
  assert.equal(
    jsonObjectProblem('{"a": 1,\u200B"b": 2}'),
    "Invalid JSON at line 1, column 9: remove the invisible zero-width space there. Enter a valid JSON object.",
  );
});

test("space-like separators and curly quotes are named at their position (finding 1959)", () => {
  const named = (where, fix) => `Invalid JSON${where}: ${fix}. Enter a valid JSON object.`;
  for (const [character, name] of [
    ["\u2028", "invisible line separator"],
    ["\u2029", "invisible paragraph separator"],
    ["\u202F", "narrow non-breaking space"],
    ["\u3000", "full-width space"],
  ]) {
    assert.equal(
      jsonObjectProblem(`{"a":${character}1}`),
      named(" at line 1, column 6", `remove the ${name} there`),
      codePoint(character),
    );
  }
  // A word processor's quotes around a key or a value, and a chat app's single quotes.
  assert.equal(
    jsonObjectProblem("{\u201Cmodel\u201D: 1}"),
    named(" at line 1, column 2", 'replace the curly quote \u201C there with a straight quote (")'),
  );
  assert.equal(
    jsonObjectProblem('{\n  "model": \u201Cgpt\u201D\n}'),
    named(
      " at line 2, column 12",
      'replace the curly quote \u201C there with a straight quote (")',
    ),
  );
  assert.equal(
    jsonObjectProblem("\u2018x\u2019"),
    named("", 'replace the curly quote \u2018 at the start with a straight quote (")'),
  );
  // Autocorrect can also curl both quotes the closing way.
  assert.equal(
    jsonObjectProblem('{"a": \u201Db\u201D}'),
    named(" at line 1, column 7", 'replace the curly quote \u201D there with a straight quote (")'),
  );
  assert.equal(
    jsonObjectProblem("{\u2019a\u2019: 1}"),
    named(" at line 1, column 2", 'replace the curly quote \u2019 there with a straight quote (")'),
  );
  // Inside a string they are ordinary text.
  assert.equal(jsonObjectProblem('{"a": "\u201Cquoted\u201D\u2028\u3000"}'), undefined);
});

test("text of only invisible or space-like characters names the first one (finding 1959)", () => {
  // String.prototype.trim() strips these, so they used to read as empty input.
  assert.equal(
    jsonObjectProblem("\uFEFF"),
    "Invalid JSON: remove the invisible byte order mark at the start. Enter a valid JSON object.",
  );
  assert.equal(
    jsonObjectProblem("\u00A0\u00A0"),
    "Invalid JSON: remove the non-breaking space at the start. Enter a valid JSON object.",
  );
  assert.equal(
    jsonObjectProblem("\n \u3000"),
    "Invalid JSON at line 2, column 2: remove the full-width space there. Enter a valid JSON object.",
  );
});

test("columns count characters as the reader sees them, not UTF-16 units (finding 1939)", () => {
  // V8 says "column 18" here; the stray x is the 16th visible character.
  assert.equal(jsonObjectProblem('{"name": "\u{1F600}\u{1F680}", x}'), at(1, 16));
  // An "e" with a combining acute accent is one column.
  assert.equal(jsonObjectProblem('{"name": "e\u0301", x}'), at(1, 15));
  assert.equal(jsonObjectProblem('{\n  "\u{1F600}": 1,\n  x\n}'), at(3, 3));
});

// The choseong, jungseong, compatibility and halfwidth Hangul fillers.
const HANGUL_FILLERS = ["\u115F", "\u1160", "\u3164", "\uFFA0"];
const codePoint = (character) => `U+${character.codePointAt(0).toString(16).toUpperCase()}`;

test("invisible characters earlier on the line take no column (finding 1949)", () => {
  // A left-to-right mark, a soft hyphen and a word joiner: the stray x is the 18th visible
  // character, not the 21st.
  assert.equal(jsonObjectProblem('{"name": "a\u200Eb\u00ADc\u2060d", x}'), at(1, 18));
  assert.equal(jsonObjectProblem('{"a": "x\u200By", oops}'), at(1, 13));
  assert.equal(jsonObjectProblem('{"a": "\uFEFF\u200F", x}'), at(1, 11));
  // A joined emoji sequence stays one column, and a non-breaking space, which shows as a space,
  // still takes one.
  assert.equal(jsonObjectProblem('{"a": "\u{1F469}\u200D\u{1F4BB}\u00A0", x}'), at(1, 13));
  // The Hangul fillers show as blank cells that advance the text, so each still takes a column.
  for (const filler of HANGUL_FILLERS) {
    assert.equal(jsonObjectProblem(`{"a": "p${filler}q", x}`), at(1, 14), codePoint(filler));
  }
});

test("an uppercase exponent and an escaped slash are valid JSON before a later error (finding 1950)", () => {
  assert.equal(jsonObjectProblem('{"a": 1E5, x}'), at(1, 12));
  assert.equal(jsonObjectProblem('{"a": -2.5E-3, x}'), at(1, 16));
  // PHP and some other encoders escape every slash in a URL.
  assert.equal(jsonObjectProblem('{"url": "https:\\/\\/example.test\\/", x}'), at(1, 37));
});

test("without Intl.Segmenter, columns still count code points, not UTF-16 units (finding 1950)", async () => {
  // The segmenter is read when the module loads, so this loads a second copy without it.
  const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
  delete Intl.Segmenter;
  let fallback;
  try {
    fallback = await import("../../apps/controller/src/console/dom.mts?no-segmenter");
  } finally {
    Object.defineProperty(Intl, "Segmenter", segmenter);
  }
  assert.equal(typeof Intl.Segmenter, "function");
  // Each emoji is one code point, two UTF-16 units: the stray x is the 16th character.
  assert.equal(fallback.jsonObjectProblem('{"name": "\u{1F600}\u{1F680}", x}'), at(1, 16));
  // Invisible characters take no column there either (finding 1949).
  assert.equal(fallback.jsonObjectProblem('{"a": "x\u200By\u00AD", oops}'), at(1, 13));
  for (const filler of HANGUL_FILLERS) {
    assert.equal(
      fallback.jsonObjectProblem(`{"a": "p${filler}q", x}`),
      at(1, 14),
      codePoint(filler),
    );
  }
});

test("CRLF and lone CR end a line; a tab is one column", () => {
  assert.equal(jsonObjectProblem('{\r\n  "a": 1,\r\n}'), at(3, 1));
  assert.equal(jsonObjectProblem('{\r  "a": 1,\r}'), at(3, 1));
  assert.equal(jsonObjectProblem('{\n\t"a": x\n}'), at(2, 7));
});

test("existing positions stay the same", () => {
  assert.equal(jsonObjectProblem("{ invalid"), at(1, 3));
  assert.equal(jsonObjectProblem('{\n  "model": 1,\n}'), at(3, 1));
  // An early end points just past the last character.
  assert.equal(jsonObjectProblem('{\n  "a": [1, 2'), at(2, 13));
  assert.equal(jsonObjectProblem('{"a": "open'), at(1, 12));
});

test("empty, valid and non-object input keep their messages", () => {
  assert.equal(jsonObjectProblem(""), "Enter a valid JSON object.");
  assert.equal(jsonObjectProblem(" \n\t"), "Enter a valid JSON object.");
  assert.equal(jsonObjectProblem('{"a": [1, {"b": null}]}'), undefined);
  for (const value of ["[]", "null", "1", '"x"', "true"]) {
    assert.equal(
      jsonObjectProblem(value),
      "Enter a valid JSON object, not an array or a single value.",
    );
  }
});

test("deeply nested input still gets a position without overflowing the stack", () => {
  const depth = 200_000;
  assert.equal(jsonObjectProblem(`{"a": ${"[".repeat(depth)}x`), at(1, depth + 7));
  assert.equal(jsonErrorOffset("[".repeat(depth) + "]".repeat(depth)), undefined);
});

test("the scan agrees with the engine wherever the engine names a position", () => {
  // Every one-character deletion, insertion and replacement of a document that uses each part
  // of the grammar: the scan finds an error exactly when JSON.parse throws, and at the same
  // offset whenever V8's message names one.
  const base =
    '{\n  "a": [1, -2.5e+3, 4E-1, 0, true, false, null, "x\\n\\u00e9\\"y\\/\\r"],\n  "b": {"c": {}, "d": []}\r\n}';
  const characters = [...'"{}[],:x01-.eE+/u\\ \t\n\rt', "\u0001", "\uFEFF"];
  const variants = new Set();
  for (let index = 0; index <= base.length; index += 1) {
    variants.add(base.slice(0, index));
    variants.add(base.slice(0, index) + base.slice(index + 1));
    for (const character of characters) {
      variants.add(base.slice(0, index) + character + base.slice(index));
      variants.add(base.slice(0, index) + character + base.slice(index + 1));
    }
  }
  let positioned = 0;
  for (const text of variants) {
    let message;
    try {
      JSON.parse(text);
    } catch (error) {
      message = error.message;
    }
    const offset = jsonErrorOffset(text);
    assert.equal(offset === undefined, message === undefined, JSON.stringify(text));
    const engine = /at position (\d+)/.exec(message ?? "");
    if (engine) {
      positioned += 1;
      assert.equal(offset, Number(engine[1]), `${JSON.stringify(text)}: ${message}`);
    }
  }
  assert.ok(positioned > 1000, `only ${positioned} positioned engine errors`);
});
