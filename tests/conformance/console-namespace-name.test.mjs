import assert from "node:assert/strict";
import test from "node:test";

import {
  NAME_MAX_CHARACTERS,
  NAME_PATTERN,
  namespaceNameProblem,
} from "../../apps/controller/src/console/namespaces.mts";
import {
  SECRET_NAME_MAX_CHARACTERS,
  suggestedSecretName,
} from "../../apps/controller/src/console/agents/secret-picker.mts";
import {
  NAME_MAX_CHARACTERS as API_NAME_MAX_CHARACTERS,
  PLAIN_TEXT_PATTERN,
  isName,
} from "../../packages/contracts/src/api/plain-text.ts";

test("the console's Namespace name rule is the API's Name rule", () => {
  assert.equal(NAME_PATTERN.source, PLAIN_TEXT_PATTERN);
  assert.equal(NAME_PATTERN.flags, "u");
  assert.equal(NAME_MAX_CHARACTERS, API_NAME_MAX_CHARACTERS);
  assert.equal(SECRET_NAME_MAX_CHARACTERS, API_NAME_MAX_CHARACTERS);
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

test("suggested Secret names meet the Name rule and keep what the Secret is for", () => {
  // Create Secret dialogs suggest "<Agent name> <purpose>", and an Agent name may use all 200
  // characters, so a long suggestion is shortened in the middle (finding 1809).
  for (const agentName of [
    "Support",
    "a".repeat(185),
    "a".repeat(200),
    "\u{1F680}".repeat(200),
    `${"a".repeat(158)} ${"b".repeat(41)}`,
  ]) {
    for (const purpose of ["model credential", "harness authentication", "Slack bot token"]) {
      const suggestion = `${agentName} ${purpose}`;
      const name = suggestedSecretName(suggestion);
      assert.ok(isName(name), JSON.stringify(name));
      assert.ok(name.endsWith(` ${purpose}`), name);
      if (Array.from(suggestion).length <= NAME_MAX_CHARACTERS) {
        assert.equal(name, suggestion, "a suggestion that fits is kept as is");
      } else {
        assert.ok(name.startsWith(Array.from(agentName).slice(0, 100).join("")), name);
        assert.match(name, /…/u);
      }
    }
  }
});
