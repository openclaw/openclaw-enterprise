import assert from "node:assert/strict";
import test from "node:test";
import { jsonObjectProblem } from "../../apps/controller/src/console/dom.mts";
import { at, codePoint } from "./console-json-error-expected.ts";

export function registerConsoleJsonErrorDiagnosticsCases(): void {
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
    const named = (where: string, fix: string) =>
      `Invalid JSON${where}: ${fix}. Enter a valid JSON object.`;
    for (const [character, name] of [
      ["\u2028", "invisible line separator"],
      ["\u2029", "invisible paragraph separator"],
      ["\u202F", "narrow non-breaking space"],
      ["\u3000", "full-width space"],
    ] as const) {
      assert.equal(
        jsonObjectProblem(`{"a":${character}1}`),
        named(" at line 1, column 6", `remove the ${name} there`),
        codePoint(character),
      );
    }
    // A word processor's quotes around a key or a value, and a chat app's single quotes.
    assert.equal(
      jsonObjectProblem("{\u201Cmodel\u201D: 1}"),
      named(
        " at line 1, column 2",
        'replace the curly quote \u201C there with a straight quote (")',
      ),
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
      named(
        " at line 1, column 7",
        'replace the curly quote \u201D there with a straight quote (")',
      ),
    );
    assert.equal(
      jsonObjectProblem("{\u2019a\u2019: 1}"),
      named(
        " at line 1, column 2",
        'replace the curly quote \u2019 there with a straight quote (")',
      ),
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
}
