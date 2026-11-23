import assert from "node:assert/strict";
import test from "node:test";
import { importConsoleModule } from "../helpers/console-browser-module.ts";
import { registerAgentNameRunStructureCases } from "./console-agent-name-run-structure.ts";

const { UNBROKEN_ALTERNATIVES, UNBROKEN_RUN, hasUnbrokenRun } =
  await importConsoleModule("agents/list.mjs");

// The Agents list tests every name for a run the browser cannot wrap, on each render and each
// search keystroke. A name of word-joiner (U+2060) or zero-width-joiner (U+200D) runs made that
// test backtrack exponentially: 10.7 s for one 210-character name, about 2.5 s per keystroke in
// the console (finding 1999). Each of these names is a run of 20 that just fails to be marked,
// which is the worst case; the test must stay linear in the name's length.
const joinerNames = {
  "word joiners": `${"\u2060".repeat(20)} `.repeat(10),
  "a letter, then word joiners": `a${"\u2060".repeat(19)} `.repeat(10),
  "a letter, then zero-width joiners": `a${"\u200d".repeat(19)} `.repeat(10),
  "a hyphen, then word joiners": `-${"\u2060".repeat(19)} `.repeat(10),
  "an en dash, then word joiners": `\u2013${"\u2060".repeat(19)} `.repeat(10),
  "a thin space, then word joiners": `\u2009${"\u2060".repeat(19)} `.repeat(10),
  "an ideograph, then word joiners": `\u4e2d${"\u2060".repeat(19)} `.repeat(10),
  "combining marks between word joiners": `a${"\u0301\u2060".repeat(19)} `.repeat(10),
  "hyphens before Arabic-Indic digits": `${"\u2060-\u0660".repeat(6)}\u2060\u2060 `.repeat(10),
  // U+16FE4 is both an ideograph and a combining mark.
  "an ideographic combining mark before word joiners": `a${"\u{16fe4}".repeat(18)}\u2060 `.repeat(
    10,
  ),
  "letter emoji before word joiners": `${"\u26a1\u2060".repeat(10)} `.repeat(10),
  "hyphens before Devanagari digits after letters":
    `${"\u00e9-\u0967".repeat(6)}\u00e9\u00e9 `.repeat(10),
  "word joiners before opening quotes": `${"\u2060\u00ab".repeat(10)} `.repeat(10),
  "word joiners, 1,050 characters": `${"\u2060".repeat(20)} `.repeat(50),
  // Plain names too: an alternative that overlaps an ordinary letter froze these for about 2 s
  // while every joiner name above stayed fast (finding 2031).
  "plain lowercase letters": `${"a".repeat(20)} `.repeat(10),
  "plain digits": `${"1".repeat(20)} `.repeat(10),
  "letters before a hyphen": `${"a".repeat(19)}- `.repeat(10),
  // A run of marks after each character whose alternative looks ahead past marks: a nested
  // quantifier there (`(?:\p{M}+)*`) matches the same names but takes 0.6 to 4 s on these
  // (finding 2037). Nothing after the marks completes the lookahead, so every split is tried.
  "a hyphen, then combining marks": `a-${"\u0301".repeat(25)}x`,
  "an accented letter and a hyphen, then combining marks": `\u00e9-${"\u0301".repeat(25)}x`,
  "an en dash, then combining marks": `a\u2013${"\u0301".repeat(25)}x`,
  "a thin space, then combining marks": `a\u2009${"\u0301".repeat(25)}x`,
  "an ideograph, then combining marks": `\u4e2d${"\u0301".repeat(25)}x`,
};

// The first call builds the rule's matcher (6.6 ms idle, about 40 ms on a loaded runner; finding
// 2038) and the second compiles it to machine code (about 1 ms idle), so both happen before any
// case is timed.
for (let call = 0; call < 3; call += 1) {
  hasUnbrokenRun(joinerNames["word joiners"]);
}
// A linear rule takes about 0.1 ms on each name; the cases this bound catches take 0.6 s or more. A slow
// runner can still stall one call, so a call over the bound is retried twice and the fastest of
// the three counts: a steep blowup is slow every time.
const BOUND_MS = 50;
function fastestCall(name: string) {
  let fastest = Infinity;
  let marked;
  for (let attempt = 0; attempt < 3 && fastest >= BOUND_MS; attempt += 1) {
    const started = performance.now();
    marked = hasUnbrokenRun(name);
    fastest = Math.min(fastest, performance.now() - started);
  }
  return { marked, fastest };
}

for (const [label, name] of Object.entries(joinerNames)) {
  test(`The long-name check settles quickly on ${label}`, () => {
    const { marked, fastest } = fastestCall(name);
    assert.equal(marked, false, "a run of 20 is not marked");
    assert.ok(fastest < BOUND_MS, `${name.length} characters took ${fastest.toFixed(1)} ms`);
  });
}

// The narrower joiner rule still counts what a joiner holds: an ideograph through its own
// alternative, a hyphen, dash or wide space through CLOSING, and a combining mark with its letter.
test("Joiners still hold the character before them", () => {
  assert.equal(hasUnbrokenRun("\u2060".repeat(21)), true);
  assert.equal(hasUnbrokenRun(`${"\u4e2d\u2060".repeat(10)}a`), true);
  assert.equal(hasUnbrokenRun("\u4e2d\u2060".repeat(10)), false);
  assert.equal(hasUnbrokenRun(`${"-\u2060".repeat(10)}a`), true);
  assert.equal(hasUnbrokenRun(`${"-\u2060".repeat(10)}`), false);
  assert.equal(hasUnbrokenRun(`${"\u2013\u2060".repeat(10)}a`), true);
  assert.equal(hasUnbrokenRun(`${"\u2009\u2060".repeat(10)}a`), true);
  assert.equal(hasUnbrokenRun(`${"e\u0301\u2060".repeat(10)}a`), true);
  assert.equal(hasUnbrokenRun(`${"e\u0301\u2060".repeat(10)}`), false);
  assert.equal(hasUnbrokenRun(`a${"\u{16fe4}".repeat(19)}\u2060`), false);
  assert.equal(hasUnbrokenRun(`${"a\u{16fe4}\u2060".repeat(10)}a`), true);
});

registerAgentNameRunStructureCases({ UNBROKEN_ALTERNATIVES, UNBROKEN_RUN });
