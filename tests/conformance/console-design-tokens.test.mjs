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
