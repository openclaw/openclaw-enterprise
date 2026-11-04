import assert from "node:assert/strict";
import test from "node:test";

import {
  UNBROKEN_ALTERNATIVES,
  UNBROKEN_RUN,
  hasUnbrokenRun,
} from "../../apps/controller/src/console/agents/list.mts";

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
function fastestCall(name) {
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

// The 50 ms bound above catches only steep blowups: an overlap that doubles a few splits stays
// far under it at the 200-character limit (finding 2013). So check the rule directly: no two
// alternatives match the same character, and no combining mark starts one. Removing an
// alternative's lookarounds only widens what it matches, so a character that no two widened
// alternatives can consume needs no further check. The few that remain are tried between
// characters that satisfy each lookaround.
const CONTEXTS = [
  ...["", " ", "a", "Z", "5", "\u00e9", "-", "\u2010", "\u2013", "\u2014", "\u2009", "\u200b"],
  ...["\u2011", "\u00a0", "\u4e2d", "\u0301", "\u0660", "\u0967", "\uff11", "\u2060", "\u200d"],
  ...["\u00ab", '"', "'", "|", ")", "$", "\u26a1", "\u{1f600}", "\u3000", "\u00ad", "\ufeff"],
  // A mark before what a lookahead looks for (\p{M}*).
  ...["\u03015", "\u0301\u0660", "\u0301\u2060", "\u0301-", "\u0301\u00ab", "\u0301)"],
];
const sticky = (source) => new RegExp(source, "uy");
const alternatives = UNBROKEN_ALTERNATIVES.map(sticky);
// Splits off every lookahead and lookbehind group, skipping escapes and character classes:
// `kept` is the source without them, `bodies` what each one holds.
function splitLookarounds(source) {
  let kept = "";
  const bodies = [];
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
      if (depth === 0 && /^\(\?<?[=!]/.test(source.slice(index))) {
        const opener = source.slice(index).match(/^\(\?<?[=!]/)[0];
        index += opener.length - 1;
        bodies.push("");
        depth = 1;
        continue;
      }
      if (depth > 0) {
        depth += 1;
      }
    } else if (!inClass && character === ")" && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        continue;
      }
    }
    if (depth === 0) {
      kept += text;
    } else {
      bodies[bodies.length - 1] += text;
    }
  }
  return { kept, bodies };
}
const withoutLookarounds = (source) => splitLookarounds(source).kept;
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

// The overlap check above compares alternatives with each other, one character at a time. Two
// shapes escape it and bring the finding-1999 freeze back on plain names (finding 2031): an
// alternative of its own that overlaps (a second branch inside one entry, or one that consumes
// more than one character), and anything added where the alternatives are joined into the rule.
// So each alternative must be one character class or escape, with only lookarounds beside it.
const ATOM = String.raw`(?:\[(?:\\.|[^\]\\])*\]|\\u\{[0-9a-fA-F]+\}|\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}|\\[pP]\{[\w=]+\}|\\[dDwWsSfnrtv0\\/.^$|?*+()[\]{}-]|[^\\[\](){}|*+?.^$])`;
function atomWithoutLookarounds(source) {
  return new RegExp(`^${ATOM}$`).test(withoutLookarounds(source));
}
// A lookaround runs at every position the rule tries, so a body that can split marks two ways
// brings the freeze back as well (finding 2037). Each branch of a body is one character class or
// escape, after at most one run of marks, or the start of the name.
const LOOKAROUND_BRANCH = new RegExp(String.raw`^(?:\^|(?:\\p\{M\}\*)?${ATOM})$`);
// Splits a body on its top-level bars; a group inside a body is refused as a branch.
function lookaroundBranches(body) {
  const branches = [""];
  let inClass = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    const text = character === "\\" ? body.slice(index, index + 2) : character;
    index += text.length - 1;
    if (character === "[" && !inClass) {
      inClass = true;
    } else if (character === "]" && inClass) {
      inClass = false;
    } else if (character === "|" && !inClass) {
      branches.push("");
      continue;
    }
    branches[branches.length - 1] += text;
  }
  return branches;
}

test("Each long-name alternative consumes one character, with no branch of its own", () => {
  for (const source of UNBROKEN_ALTERNATIVES) {
    assert.ok(atomWithoutLookarounds(source), `not a single character: ${source}`);
  }
});

test("Each long-name lookaround checks one character, after at most one run of marks", () => {
  let bodies = 0;
  for (const source of UNBROKEN_ALTERNATIVES) {
    for (const body of splitLookarounds(source).bodies) {
      bodies += 1;
      for (const branch of lookaroundBranches(body)) {
        assert.match(branch, LOOKAROUND_BRANCH, `in ${source}`);
      }
    }
  }
  assert.ok(bodies > 0, "the rule has lookarounds to check");
});

test("The long-name rule joins exactly those alternatives, each with its marks", () => {
  const run = String.raw`(?:(?:${UNBROKEN_ALTERNATIVES.join("|")})\p{M}*)`;
  const [emDashes, ...rest] = UNBROKEN_RUN.source.split(run);
  assert.equal(emDashes, String.raw`\u2014{21,}|`);
  assert.equal(rest.length, 2, "the rule uses the run twice");
  assert.equal(rest[0], "{21,}|");
  // Twenty run characters, then one break character the line keeps.
  assert.match(rest[1], /^\{20\}\[[^\]()|]*\]$/);
  assert.equal(UNBROKEN_RUN.flags, "u");
});
