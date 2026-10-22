import assert from "node:assert/strict";
import test from "node:test";

import {
  NAME_MAX_CHARACTERS,
  NAME_PATTERN,
  namespaceNameProblem,
} from "../../apps/controller/src/console/namespaces.mts";
import {
  NAME_MAX_CHARACTERS as API_NAME_MAX_CHARACTERS,
  PLAIN_TEXT_PATTERN,
  isName,
} from "../../packages/contracts/src/api/plain-text.ts";

test("the console's Namespace name rule is the API's Name rule", () => {
  assert.equal(NAME_PATTERN.source, PLAIN_TEXT_PATTERN);
  assert.equal(NAME_PATTERN.flags, "u");
  assert.equal(NAME_MAX_CHARACTERS, API_NAME_MAX_CHARACTERS);
});

test("the console refuses exactly the trimmed names the API refuses", () => {
  const samples = [
    "Support",
    "  Support team  ",
    "Tab\tteam",
    "Line\nteam",
    "Bell\u0007team",
    "Delete\u007fteam",
    "C1\u0085team",
    "Line\u2028separator",
    "Paragraph\u2029separator",
    "No-break\u00a0space",
    "Lone\ud800surrogate",
    "n".repeat(200),
    "n".repeat(201),
    "\u{1F680}".repeat(200),
    "\u{1F680}".repeat(201),
    `${"n".repeat(200)}   `,
  ];
  for (const value of samples) {
    const trimmed = value.trim();
    const consoleAccepts = trimmed !== "" && namespaceNameProblem(value) === "";
    assert.equal(consoleAccepts, isName(trimmed), JSON.stringify(value));
  }
  assert.equal(namespaceNameProblem("n".repeat(201)), "Use at most 200 characters.");
  assert.match(namespaceNameProblem("Tab\tteam"), /Remove tabs/);
  // An empty name is the required check's to report.
  assert.equal(namespaceNameProblem("   "), "");
});
