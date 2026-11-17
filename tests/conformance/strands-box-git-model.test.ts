import assert from "node:assert/strict";
import test from "node:test";
import {
  GIT_STEPS,
  gitAnswerFor,
  gitCommand,
  gitOutcome,
  gitPlan,
  gitPromptFor,
} from "../../deploy/examples/strands-box/git/controlled-git-model.ts";

const nonce = "a1".repeat(24);
const plan = gitPlan({
  repository: "example/review",
  otherRepository: "example/other",
  branch: "review/agent",
  otherRef: "not-assigned",
  base: "main",
});

test("the scripted dry-run model asks only for stock git and gh against GitHub's canonical URLs", () => {
  for (const step of GIT_STEPS) {
    const command = gitCommand(plan, nonce, step);
    assert.doesNotMatch(command, /insteadOf|credential\.|helper|askpass|auth login|token=|\/draft-pull/i);
    for (const url of command.match(/https:\/\/[^\s]+/g) ?? []) {
      assert.match(url, /^https:\/\/github\.com\/example\/(?:review|other)\.git$/);
    }
    assert.ok(gitPromptFor(nonce, step).endsWith(`${step}: run the operator-scripted repository step.`));
  }
  assert.match(gitCommand(plan, nonce, "push"), /git push https:\/\/github\.com\/example\/review\.git HEAD:refs\/heads\/review\/agent/);
  assert.match(
    gitCommand(plan, nonce, "draft"),
    /gh pr create --draft --repo example\/review --head review\/agent --base main/,
  );
  // The placeholder step prints digests and lengths, never a variable's value.
  const placeholders = gitCommand(plan, nonce, "placeholders");
  assert.match(placeholders, /printf %s "\$v" \| sha256sum \| cut -c1-16/);
  assert.equal(placeholders.split('"$v"').length, 3, "the value is only tested and hashed");
  assert.doesNotMatch(placeholders, /echo "?\$v|\$GITHUB_TOKEN/);
  assert.throws(() => gitPlan({ ...plan, repository: "example/review; curl x" }));
  assert.throws(() => gitPlan({ ...plan, branch: "a/../b" }));
  assert.throws(() => gitPlan({ ...plan, otherRepository: plan.repository }));
});

test("the dry-run result line carries the exit code and Box's refusal code only", () => {
  const output = [
    "Wall time: 0.4100 seconds",
    "Process exited with code 128",
    "Output:",
    "remote: credential refused by its source: request_not_allowed",
  ].join("\n");
  assert.deepEqual(gitOutcome(output), { exit: 128, refusal: "request_not_allowed" });
  assert.equal(
    gitAnswerFor(nonce, "other-repository", gitOutcome(output)),
    `BOX_GIT_REPRO_RESULT ${nonce} other-repository exit=128 refusal=request_not_allowed`,
  );
  assert.equal(gitOutcome("no header"), undefined);
  assert.equal(gitAnswerFor(nonce, "push", undefined), `BOX_GIT_REPRO_RESULT ${nonce} push unparsed`);
});
