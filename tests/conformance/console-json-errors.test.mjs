import assert from "node:assert/strict";
import test from "node:test";
import { jsonErrorOffset, jsonObjectProblem } from "../../apps/controller/src/console/dom.mjs";

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
    jsonObjectProblem('﻿{"a": 1}'),
    "Invalid JSON: remove the invisible byte order mark at the start. Enter a valid JSON object.",
  );
  // Inside a string it is ordinary text.
  assert.equal(jsonObjectProblem('{"a": "﻿"}'), undefined);
});

test("columns count characters as the reader sees them, not UTF-16 units (finding 1939)", () => {
  // V8 says "column 18" here; the stray x is the 16th visible character.
  assert.equal(jsonObjectProblem('{"name": "\u{1F600}\u{1F680}", x}'), at(1, 16));
  // An "e" with a combining acute accent is one column.
  assert.equal(jsonObjectProblem('{"name": "é", x}'), at(1, 15));
  assert.equal(jsonObjectProblem('{\n  "\u{1F600}": 1,\n  x\n}'), at(3, 3));
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
    '{\n  "a": [1, -2.5e+3, 0, true, false, null, "x\\n\\u00e9\\"y"],\n  "b": {"c": {}, "d": []}\n}';
  const characters = [...'"{}[],:x01-.e\\ \t\nt', "\u0001", "﻿"];
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
