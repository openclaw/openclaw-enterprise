import assert from "node:assert/strict";
import test from "node:test";

import {
  GITLAB_PROVIDER_ORIGIN,
  gitlabProviderOrigin,
} from "../../apps/controller/src/drivers/repo/gitlab/credentials/origin.ts";
import { createGitLabStaticTokenOwner } from "../../apps/controller/src/drivers/repo/gitlab/credentials/static-token.ts";
import { permissionsForProfile } from "../../apps/controller/src/drivers/repo/gitlab/credentials/profiles.ts";

test("the GitLab provider origin is fixed and HTTPS-only", () => {
  assert.equal(gitlabProviderOrigin(GITLAB_PROVIDER_ORIGIN), "https://gitlab.com");
  for (const refused of [
    "http://gitlab.com",
    "https://gitlab.example.test",
    "https://gitlab.com/",
    "https://user@gitlab.com",
    "https://gitlab.com/path",
  ]) {
    assert.throws(() => gitlabProviderOrigin(refused), /invalid-endpoint/, refused);
  }
});

test("the static token owner lends a zeroed copy and can be closed", async () => {
  const raw = Buffer.from("glpat-synthetic-validation-token");
  const owner = createGitLabStaticTokenOwner({ token: raw });
  assert.equal(owner.tokenClass, "personal");
  let lent;
  await owner.withToken(async (bytes) => {
    lent = bytes;
    assert.equal(Buffer.from(bytes).toString(), raw.toString());
    return bytes.length;
  });
  assert.ok(
    lent.every((byte) => byte === 0),
    "the lent copy must be zeroed after use",
  );
  owner.close();
  await assert.rejects(
    owner.withToken(async () => undefined),
    /authority-unavailable/,
  );
});

test("profiles expose only read, branch write, draft merge request, and issue effects", () => {
  assert.deepEqual(permissionsForProfile("git-read"), {
    project: "read",
    branches: "read",
    issues: "read",
    merge_requests: "read",
    pipelines: "read",
  });
  assert.equal(permissionsForProfile("git-write").issues, "read");
  assert.equal(permissionsForProfile("git-write").merge_requests, "write");
  assert.equal(permissionsForProfile("git-full").issues, "write");
  assert.throws(() => permissionsForProfile("merge"), /unsupported-profile/);
});
