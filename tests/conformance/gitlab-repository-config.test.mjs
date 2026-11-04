import assert from "node:assert/strict";
import test from "node:test";

import { validateGitLabConfiguration } from "../../apps/controller/src/drivers/repo/gitlab/credentials/config.ts";

const valid = {
  kind: "gitlab-token",
  providerInstanceId: "rmcook84-test",
  configVersion: "1",
  projectId: "88516404",
  project: "rmcook84/test",
  tokenFile: "/run/secrets/gitlab-token",
  developmentOnly: true,
  pushRefAllowlist: ["refs/heads/*"],
  allowGraphql: false,
  leaseSeconds: 3600,
};

test("the GitLab static token configuration mirrors the GitHub token configuration", () => {
  assert.deepEqual(validateGitLabConfiguration(valid), {
    ...valid,
    pushRefAllowlist: ["refs/heads/*"],
  });
  assert.deepEqual(
    validateGitLabConfiguration({ ...valid, pushRefAllowlist: [] }).pushRefAllowlist,
    [],
  );
});

test("the GitLab static token configuration refuses every non-mirrored field or shape", () => {
  for (const refused of [
    { ...valid, host: "gitlab.example.test" },
    { ...valid, kind: "github-token" },
    { ...valid, project: "https://gitlab.com/rmcook84/test" },
    { ...valid, project: "rmcook84/test/" },
    { ...valid, projectId: "0" },
    { ...valid, projectId: "12x" },
    { ...valid, providerInstanceId: "" },
    { ...valid, configVersion: "v 1" },
    { ...valid, developmentOnly: false },
    { ...valid, developmentOnly: undefined },
    { ...valid, allowGraphql: "true" },
    { ...valid, leaseSeconds: 600 },
    { ...valid, leaseSeconds: 90000 },
    { ...valid, pushRefAllowlist: "refs/heads/*" },
    { ...valid, pushRefAllowlist: ["refs/tags/*"] },
    null,
    [],
  ]) {
    assert.throws(
      () => validateGitLabConfiguration(refused),
      /invalid-backend/,
      JSON.stringify(refused),
    );
  }
});

test("the GitLab project identity is canonical and numeric in configuration", () => {
  assert.equal(
    validateGitLabConfiguration({ ...valid, project: "group/sub/project", projectId: "1" }).project,
    "group/sub/project",
  );
  assert.throws(
    () => validateGitLabConfiguration({ ...valid, project: "group//project" }),
    /invalid-backend/,
  );
  assert.throws(
    () => validateGitLabConfiguration({ ...valid, projectId: "001" }),
    /invalid-backend/,
  );
});
