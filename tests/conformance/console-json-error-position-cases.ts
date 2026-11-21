import assert from "node:assert/strict";
import test from "node:test";
import { jsonObjectProblem } from "../../apps/controller/src/console/dom.mts";
import { at, codePoint } from "./console-json-error-expected.ts";

// The choseong, jungseong, compatibility and halfwidth Hangul fillers.
const HANGUL_FILLERS = ["\u115F", "\u1160", "\u3164", "\uFFA0"];

export function registerConsoleJsonErrorPositionCases(): void {
  test("columns count characters as the reader sees them, not UTF-16 units (finding 1939)", () => {
    // V8 says "column 18" here; the stray x is the 16th visible character.
    assert.equal(jsonObjectProblem('{"name": "\u{1F600}\u{1F680}", x}'), at(1, 16));
    // An "e" with a combining acute accent is one column.
    assert.equal(jsonObjectProblem('{"name": "e\u0301", x}'), at(1, 15));
    assert.equal(jsonObjectProblem('{\n  "\u{1F600}": 1,\n  x\n}'), at(3, 3));
  });

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
    assert.ok(segmenter);
    let fallback: unknown;
    try {
      assert.ok(Reflect.deleteProperty(Intl, "Segmenter"));
      fallback = await import(
        new URL("../../apps/controller/src/console/dom.mts?no-segmenter", import.meta.url).href
      );
    } finally {
      Object.defineProperty(Intl, "Segmenter", segmenter);
    }
    assert.ok(typeof fallback === "object" && fallback !== null && "jsonObjectProblem" in fallback);
    const isCallable = (value: unknown): value is (text: string) => unknown =>
      typeof value === "function";
    assert.ok(isCallable(fallback.jsonObjectProblem));
    assert.notEqual(fallback.jsonObjectProblem, jsonObjectProblem);
    assert.deepEqual(Object.getOwnPropertyDescriptor(Intl, "Segmenter"), segmenter);
    assert.equal(typeof Intl.Segmenter, "function");
    // The fresh copy counts the combining mark separately, proving it loaded without Segmenter.
    assert.equal(fallback.jsonObjectProblem('{"name": "e\u0301", x}'), at(1, 16));
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
}
