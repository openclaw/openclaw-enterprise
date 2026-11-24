import assert from "node:assert/strict";
import test from "node:test";
import { jsonErrorOffset, jsonObjectProblem } from "../../apps/controller/src/console/dom.mts";
import { at } from "./console-json-error-expected.ts";

export function registerConsoleJsonErrorValidationCases(): void {
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

  test("Configuration rejects nested numbers that would be saved as null", () => {
    const problem = "A number is too large or too small to save. Use a number closer to zero.";
    for (const number of ["1e400", "-1E400", "9".repeat(400)]) {
      assert.equal(jsonObjectProblem(`{"thresholds":[1,{"value":${number}},3]}`), problem);
    }
    // Syntax and root-shape errors keep their existing, more specific feedback.
    assert.equal(jsonObjectProblem('{"value":1e400,}'), at(1, 16));
    assert.equal(
      jsonObjectProblem("[1e400]"),
      "Enter a valid JSON object, not an array or a single value.",
    );
  });

  test("Configuration keeps finite exponents, null and numeric-looking strings valid at depth", () => {
    const depth = 20_000;
    const wrap = (value: string) => `{"nested":${"[".repeat(depth)}${value}${"]".repeat(depth)}}`;
    assert.equal(
      jsonObjectProblem(wrap('[null,"1e400","-1E400",1e308,-1E308,2.5e-3,0]')),
      undefined,
    );
    assert.equal(
      jsonObjectProblem(wrap("-1e400")),
      "A number is too large or too small to save. Use a number closer to zero.",
    );
  });

  test("the scan agrees with the engine wherever the engine names a position", () => {
    // Every one-character deletion, insertion and replacement of a document that uses each part
    // of the grammar: the scan finds an error exactly when JSON.parse throws, and at the same
    // offset whenever V8's message names one.
    const base =
      '{\n  "a": [1, -2.5e+3, 4E-1, 0, true, false, null, "x\\n\\u00e9\\"y\\/\\r"],\n  "b": {"c": {}, "d": []}\r\n}';
    const characters = [...'"{}[],:x01-.eE+/u\\ \t\n\rt', "\u0001", "\uFEFF"];
    const variants = new Set<string>();
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
        assert.ok(error instanceof SyntaxError);
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
}
