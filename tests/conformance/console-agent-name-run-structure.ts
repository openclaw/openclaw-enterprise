import assert from "node:assert/strict";
import test from "node:test";

type LongNameRule = Pick<
  typeof import("../../apps/controller/src/console/agents/list.mts"),
  "UNBROKEN_ALTERNATIVES" | "UNBROKEN_RUN"
>;

export function registerAgentNameRunStructureCases({
  UNBROKEN_ALTERNATIVES,
  UNBROKEN_RUN,
}: LongNameRule): void {
  // The 50 ms performance bound catches only steep blowups: an overlap that doubles a few splits stays
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
  const sticky = (source: string) => new RegExp(source, "uy");
  const alternatives = UNBROKEN_ALTERNATIVES.map(sticky);
  // Splits off every lookahead and lookbehind group, skipping escapes and character classes:
  // `kept` is the source without them, `bodies` what each one holds.
  function splitLookarounds(source: string) {
    let kept = "";
    const bodies: string[] = [];
    let depth = 0;
    let inClass = false;
    for (let index = 0; index < source.length; index += 1) {
      const character = source.charAt(index);
      const text = character === "\\" ? source.slice(index, index + 2) : character;
      index += text.length - 1;
      if (character === "[" && !inClass) {
        inClass = true;
      } else if (character === "]" && inClass) {
        inClass = false;
      } else if (!inClass && character === "(") {
        if (depth === 0 && /^\(\?<?[=!]/.test(source.slice(index))) {
          const match = source.slice(index).match(/^\(\?<?[=!]/);
          assert.ok(match);
          const opener = match[0];
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
  const withoutLookarounds = (source: string) => splitLookarounds(source).kept;
  const widened = UNBROKEN_ALTERNATIVES.map((source: string) => sticky(withoutLookarounds(source)));
  const consumes = (regex: RegExp, text: string, at = 0) => {
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
  function matchingPairs(character: string, candidates: number[]) {
    const found = [];
    for (const before of CONTEXTS) {
      for (const after of CONTEXTS) {
        const text = `${before}${character}${after}`;
        const hits = candidates.filter((index) => {
          const alternative = alternatives[index];
          assert.ok(alternative);
          return consumes(alternative, text, before.length);
        });
        if (hits.length > 0) {
          found.push({ before, after, hits });
        }
      }
    }
    return found;
  }
  const shown = (text: string) =>
    [...text]
      .map((c) => {
        const point = c.codePointAt(0);
        assert.ok(point !== undefined);
        return `U+${point.toString(16).padStart(4, "0")}`;
      })
      .join(" ");

  test("No two long-name alternatives match the same character, and no mark starts one", () => {
    assert.ok(UNBROKEN_ALTERNATIVES.length > 1);
    const overlaps = [];
    const markStarts = [];
    const isMark = /^\p{M}$/u;
    for (const character of codePoints()) {
      const candidates = [];
      for (let index = 0; index < widened.length; index += 1) {
        const alternative = widened[index];
        assert.ok(alternative);
        if (consumes(alternative, character)) {
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
  function atomWithoutLookarounds(source: string) {
    return new RegExp(`^${ATOM}$`).test(withoutLookarounds(source));
  }
  // A lookaround runs at every position the rule tries, so a body that can split marks two ways
  // brings the freeze back as well (finding 2037). Each branch of a body is one character class or
  // escape, after at most one run of marks, or the start of the name.
  const LOOKAROUND_BRANCH = new RegExp(String.raw`^(?:\^|(?:\\p\{M\}\*)?${ATOM})$`);
  // Splits a body on its top-level bars; a group inside a body is refused as a branch.
  function lookaroundBranches(body: string) {
    const branches = [""];
    let inClass = false;
    for (let index = 0; index < body.length; index += 1) {
      const character = body.charAt(index);
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
    assert.ok(rest[1] !== undefined);
    assert.match(rest[1], /^\{20\}\[[^\]()|]*\]$/);
    assert.equal(UNBROKEN_RUN.flags, "u");
  });
}
