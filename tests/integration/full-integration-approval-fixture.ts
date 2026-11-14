import assert from "node:assert/strict";

import type { GithubReader } from "../../scripts/ci/full-integration-preflight.ts";

export function integrationEnvironment<Patch extends object = object>(patch?: Patch) {
  return {
    name: "integration-main",
    can_admins_bypass: false,
    protection_rules: [],
    deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    ...patch,
  };
}

export const mainOnlyPolicies = {
  total_count: 1,
  branch_policies: [{ name: "main", type: "branch" }],
};

export const mainRun = {
  GITHUB_REPOSITORY: "openclaw/openclaw-enterprise",
  GITHUB_REF: "refs/heads/main",
  GITHUB_REF_TYPE: "branch",
  GITHUB_EVENT_NAME: "push",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_RUN_ID: "123",
  GITHUB_ACTOR: "dispatcher",
  GITHUB_ACTOR_ID: "42",
  GITHUB_TRIGGERING_ACTOR: "dispatcher",
  GITHUB_TOKEN: "synthetic-workflow-token",
  INPUT_LANE: "all",
};

export const approvalEnvironment = {
  ...integrationEnvironment(),
  id: 26285522718,
  name: "integration-main-approval",
  protection_rules: [
    {
      type: "required_reviewers",
      prevent_self_review: false,
      reviewers: [{ type: "Team", reviewer: { id: 19674117 } }],
    },
  ] as const,
};
export const approvalReview = {
  state: "approved",
  environments: [{ id: 26285522718, name: "integration-main-approval" }],
  user: { id: 42, login: "dispatcher", type: "User" },
};

export function approvalApi(
  overrides: Record<string, unknown> = {},
  fetched: string[] = [],
): GithubReader {
  const responses: Record<string, unknown> = {
    "/environments/integration-main-approval": approvalEnvironment,
    "/environments/integration-main-approval/deployment-branch-policies": mainOnlyPolicies,
    "/actions/runs/123/approvals": [approvalReview],
    "/environments/integration-main": integrationEnvironment(),
    "/environments/integration-main/deployment-branch-policies": mainOnlyPolicies,
    ...overrides,
  };
  return async ({ repository, path }) => {
    assert.equal(repository, mainRun.GITHUB_REPOSITORY);
    fetched.push(path);
    assert.ok(Object.hasOwn(responses, path), `unexpected API path ${path}`);
    return responses[path];
  };
}
