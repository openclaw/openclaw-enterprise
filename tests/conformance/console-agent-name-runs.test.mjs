import assert from "node:assert/strict";
import test from "node:test";

import { hasUnbrokenRun } from "../../apps/controller/src/console/agents/list.mjs";

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
  "word joiners, 1,050 characters": `${"\u2060".repeat(20)} `.repeat(50),
};

for (const [label, name] of Object.entries(joinerNames)) {
  test(`The long-name check settles quickly on ${label}`, () => {
    const started = performance.now();
    const marked = hasUnbrokenRun(name);
    const elapsed = performance.now() - started;
    assert.equal(marked, false, "a run of 20 is not marked");
    assert.ok(elapsed < 50, `${name.length} characters took ${elapsed.toFixed(1)} ms`);
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
});
