import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const read = async (name) =>
  stripComments(
    await readFile(new URL(`../../apps/controller/src/console/${name}`, import.meta.url), "utf8"),
  );
const consoleCss = await read("console.css");
const channelsCss = await read("channels.css");

function declarations(block) {
  return new Map(
    [...block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => [
      name,
      value.trim(),
    ]),
  );
}

// The top-level rule, not an indented :root inside an at-rule.
const rootStart = consoleCss.search(/^:root \{/m);
const root = declarations(consoleCss.slice(rootStart, consoleCss.indexOf("}", rootStart)));

// Design-language token families. Everything else in :root is an older name kept for existing rules.
const tokenName =
  /^--(color|font|text|weight|tracking|space|radius|shadow|duration|ease|focus|control|touch|content|form|prose|sidebar)(-|$)/;
// Older names that the family pattern above also matches.
const olderInFamily = new Set(["--text", "--text-strong", "--shadow", "--radius"]);
const isToken = (name) => tokenName.test(name) && !olderInFamily.has(name);

test("older console custom properties are aliases of design tokens, not separate values", () => {
  const older = [...root].filter(([name]) => !isToken(name));
  assert.ok(older.length > 0, "older names are still defined for existing rules");
  for (const [name, value] of older) {
    const token = value.match(/^var\((--[\w-]+)\)$/)?.[1];
    assert.ok(token && isToken(token), `${name}: ${value} should be var(--<token>)`);
    assert.ok(root.has(token), `${name} aliases undefined ${token}`);
  }
});

test("every custom property console.css and channels.css read is defined", () => {
  const defined = new Set(declarations(consoleCss).keys());
  // Set at runtime on the log pane (agents/logs-view.mjs).
  defined.add("--log-time-width").add("--log-time-ems");
  // Set on the document element by trackVisualViewport (dom.mjs).
  defined.add("--visual-viewport-top").add("--visual-viewport-bottom");
  const reads = new Set(
    [...(consoleCss + channelsCss).matchAll(/var\((--[\w-]+)/g)].map(([, name]) => name),
  );
  assert.deepEqual(
    [...reads].filter((name) => !defined.has(name)),
    [],
  );
});

// Every rule (selector text) with its declarations, outside :root. At-rule preludes are skipped;
// rules nested in @media/@container keep their own selector.
function rules(css) {
  const found = [];
  const stack = [];
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      stack.push({ selector: css.slice(start, i).trim(), body: i + 1 });
      start = i + 1;
    } else if (css[i] === "}") {
      const rule = stack.pop();
      if (rule && !rule.selector.startsWith("@") && rule.selector !== ":root") {
        const body = css.slice(rule.body, i).replace(/[^;{}]*\{[^{}]*\}/g, "");
        for (const [, prop, value] of body.matchAll(/(?:^|;)\s*([a-z-]+)\s*:\s*([^;]+)/g)) {
          found.push({ selector: rule.selector.replace(/\s+/g, " "), prop, value: value.trim() });
        }
      }
      start = i + 1;
    } else if (css[i] === ";" && stack.length === 0) {
      start = i + 1;
    }
  }
  return found;
}

// A length literal that is not zero.
const lengthLiteral = /(?<![\w.-])-?\d*\.?\d+(px|rem|em)\b/g;
const literalsOf = (value) =>
  (value.match(lengthLiteral) ?? []).filter((literal) => !/^-?0*\.?0+[a-z]+$/.test(literal));

test("spacing and radius use the design-language scale (UX plan B3, spec P12)", () => {
  // Kept on purpose: each is geometry tied to a border or a fixed-size mark, not spacing.
  const allowed = new Map([
    [
      '.nav a[aria-current="page"] padding-left',
      "forced colours draw the 3px bar as a border; subtract it so the label stays put",
    ],
    [".checklist-mark margin-top", "centres the 20px mark on the first text line"],
    [
      '.checklist > li[data-state="done"] .checklist-mark::after margin',
      "the check glyph inside the 20px mark",
    ],
    [".plugin-list-item .badge margin-left", "aligns under the name: the 32px logo plus the gap"],
    [".repository-result-row + .repository-result-row margin-top", "overlaps the 1px row border"],
    [".log-level padding", "1px block padding keeps the 10px caps chip one line high"],
  ]);
  const spacing = /^(padding|margin|gap|row-gap|column-gap)(-[a-z-]+)?$/;
  const radius = /^border(-[a-z]+)*-radius$/;
  const offScale = [];
  const used = new Set();
  for (const { selector, prop, value } of rules(consoleCss + channelsCss)) {
    if ((!spacing.test(prop) && !radius.test(prop)) || !literalsOf(value).length) {
      continue;
    }
    if (allowed.has(`${selector} ${prop}`)) {
      used.add(`${selector} ${prop}`);
      continue;
    }
    offScale.push(`${selector} { ${prop}: ${value} }`);
  }
  assert.deepEqual(offScale, [], "use --space-* and --radius-* (design-language 2.3/2.4)");
  assert.deepEqual(
    [...allowed.keys()].filter((key) => !used.has(key)),
    [],
    "drop allowances that no longer match a literal",
  );
});

test("the console breakpoints are the documented 520, 760 and 1100 px (design-language 2.4)", () => {
  const widths = [...(consoleCss + channelsCss).matchAll(/@media([^{]*)\{/g)].flatMap(
    ([, prelude]) => [...prelude.matchAll(/width:\s*(\d+)px/g)].map(([, px]) => Number(px)),
  );
  assert.deepEqual(
    [...new Set(widths)].filter((px) => ![520, 760, 1100, 1101].includes(px)),
    [],
  );
});
