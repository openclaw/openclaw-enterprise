import assert from "node:assert/strict";
import test from "node:test";

import {
  UNBROKEN_ALTERNATIVES,
  hasUnbrokenRun,
} from "../../apps/controller/src/console/agents/list.mjs";

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
  assert.equal(hasUnbrokenRun(`a${"\u{16fe4}".repeat(19)}\u2060`), false);
  assert.equal(hasUnbrokenRun(`${"a\u{16fe4}\u2060".repeat(10)}a`), true);
});

// The 50 ms bound above catches only steep blowups: an overlap that doubles a few splits stays
// far under it at the 200-character limit (finding 2013). So check the rule directly: no two
// alternatives match the same character, and no combining mark starts one. Removing an
// alternative's lookarounds only widens what it matches, so a character that no two widened
// alternatives can consume needs no further check. The few that remain are tried between
// characters that satisfy each lookaround.
const CONTEXTS = [
  ...["", " ", "a", "Z", "5", "é", "-", "‐", "–", "—", " ", "​"],
  ...["‑", " ", "中", "́", "٠", "१", "１", "⁠", "‍"],
  ...["«", '"', "'", "|", ")", "$", "⚡", "\u{1f600}", "　", "­", "﻿"],
];
const sticky = (source) => new RegExp(source, "uy");
const alternatives = UNBROKEN_ALTERNATIVES.map(sticky);
// Drops every lookahead and lookbehind group, skipping escapes and character classes.
function withoutLookarounds(source) {
  let kept = "";
  let depth = 0;
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const text = character === "\\" ? source.slice(index, index + 2) : character;
    index += text.length - 1;
    if (character === "[" && !inClass) {
      inClass = true;
    } else if (character === "]" && inClass) {
      inClass = false;
    } else if (!inClass && character === "(") {
      if (depth > 0 || /^\(\?<?[=!]/.test(source.slice(index))) {
        depth += 1;
        continue;
      }
    } else if (!inClass && character === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) {
      kept += text;
    }
  }
  return kept;
}
const widened = UNBROKEN_ALTERNATIVES.map((source) => sticky(withoutLookarounds(source)));
const consumes = (regex, text, at = 0) => {
  regex.lastIndex = at;
  return regex.test(text);
};
// Every code point but the surrogates.
function* codePoints() {
  for (let cp = 0; cp <= 0x10ffff; cp += 1) {
    if (cp < 0xd800 || cp > 0xdfff) {
      yield String.fromCodePoint(cp);
    }
  }
}
// Alternatives that match `character` between some pair of contexts.
function matchingPairs(character, candidates) {
  const found = [];
  for (const before of CONTEXTS) {
    for (const after of CONTEXTS) {
      const text = `${before}${character}${after}`;
      const hits = candidates.filter((index) => consumes(alternatives[index], text, before.length));
      if (hits.length > 0) {
        found.push({ before, after, hits });
      }
    }
  }
  return found;
}
const shown = (text) =>
  [...text].map((c) => `U+${c.codePointAt(0).toString(16).padStart(4, "0")}`).join(" ");

test("No two long-name alternatives match the same character, and no mark starts one", () => {
  assert.ok(UNBROKEN_ALTERNATIVES.length > 1);
  const overlaps = [];
  const markStarts = [];
  const isMark = /^\p{M}$/u;
  for (const character of codePoints()) {
    const candidates = [];
    for (let index = 0; index < widened.length; index += 1) {
      if (consumes(widened[index], character)) {
        candidates.push(index);
      }
    }
    const mark = isMark.test(character);
    if (candidates.length === 0 || (candidates.length === 1 && !mark)) {
      continue;
    }
    for (const { before, after, hits } of matchingPairs(character, candidates)) {
      if (hits.length > 1) {
        overlaps.push(
          `${shown(character)} between "${shown(before)}" and "${shown(after)}": ${hits}`,
        );
      }
      if (mark) {
        markStarts.push(`${shown(character)} after "${shown(before)}": ${hits}`);
      }
    }
  }
  assert.deepEqual(overlaps.slice(0, 5), [], `${overlaps.length} overlaps`);
  assert.deepEqual(markStarts.slice(0, 5), [], `${markStarts.length} marks start an alternative`);
});
