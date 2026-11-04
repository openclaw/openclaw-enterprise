import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  appModule,
  createLoopbackServiceConfiguration,
  gatewayRequest,
} from "../fixtures/repository-credentials/service.mjs";
import { startServiceListeners } from "../fixtures/repository-credentials/service-resources.mjs";
import { createTestResourceScope } from "../fixtures/repository-credentials/resources.mjs";
import { createTlsMaterial } from "../fixtures/repository-credentials/process.mjs";

const tokenFile = process.env.GITLAB_TEST_TOKEN_FILE;
const project = process.env.GITLAB_TEST_PROJECT;
const projectId = process.env.GITLAB_TEST_PROJECT_ID;
// A source branch with no open merge request; the lane provisions a fresh branch per run,
// because GitLab refuses a second open merge request from the same source branch.
const writeBranch = process.env.GITLAB_TEST_WRITE_BRANCH;
const live = process.env.GITLAB_TEST_LIVE === "1";

function requireLiveAuthorization() {
  assert.equal(
    process.env.GITLAB_TEST_AUTHORIZED,
    "1",
    "explicit authorization for the disposable GitLab project is required",
  );
  assert.ok(
    tokenFile && project && projectId && writeBranch,
    "the live lane requires GitLab inputs",
  );
}

async function startGitLabService(t, limits = {}) {
  const resources = createTestResourceScope(t);
  try {
    const [
      { createSystemClock },
      { createGitLabStaticTokenOwner },
      { createGitLabDriverFactory },
      { validateGitLabRepositoryRegistry, resolveGitLabRepositoryBinding },
      { UnixRepositoryCredentialControlClient },
    ] = await Promise.all([
      appModule("drivers/repo/credentials/clock"),
      appModule("drivers/repo/gitlab/credentials/static-token"),
      appModule("drivers/repo/gitlab/credentials/factory"),
      appModule("drivers/repo/gitlab/credentials/registry"),
      appModule("backends/repository-credentials/control-client"),
    ]);
    const clock = createSystemClock();
    const token = (await readFile(tokenFile, "utf8")).trim();
    assert.ok(token.length > 0, "the token file must contain a token");
    const tls = await createTlsMaterial(resources);
    const config = await createLoopbackServiceConfiguration(resources, limits);
    const owner = createGitLabStaticTokenOwner({ token: Buffer.from(token) });
    resources.after(() => owner.close());
    const factory = createGitLabDriverFactory({
      configuration: {
        kind: "gitlab-token",
        providerInstanceId: "gitlab-live",
        configVersion: "1",
        projectId,
        project,
        namespaceId: "rmcook84",
        tokenFile,
        developmentOnly: true,
        pushRefAllowlist: [`refs/heads/${writeBranch}`],
        allowGraphql: false,
        leaseSeconds: 900,
      },
      authority: owner,
      namespaceId: "rmcook84",
      gatewayOrigin: config.gateway.publicOrigin,
      limits: config.limits,
      clock,
    });
    const started = await startServiceListeners(resources, {
      config,
      factory,
      clock,
      tls,
      upstreamOrigins: ["https://gitlab.com"],
      trustedUpstreamOrigins: new Set(["https://gitlab.com"]),
      trustSystemUpstream: true,
    });
    const control = new UnixRepositoryCredentialControlClient({
      controlSocket: config.gateway.controlSocket,
    });
    await control.checkAdmissionReady(t.signal);
    const registry = validateGitLabRepositoryRegistry(
      {
        version: 1,
        backendId: "gitlab-live",
        providerInstanceId: "gitlab-live",
        configVersion: "1",
        maximumDurationSeconds: 900,
        projects: [
          {
            projectId,
            path: project,
            namespaces: [
              {
                namespaceId: "rmcook84",
                profiles: ["git-read", "git-write", "git-full"],
                pushRefAllowlist: [`refs/heads/${writeBranch}`],
              },
            ],
          },
        ],
      },
      "gitlab-live",
    );
    const expected = resolveGitLabRepositoryBinding(registry, {
      namespaceId: "rmcook84",
      repositoryRef: projectId,
      profile: "git-write",
    });
    const opened = (
      await control.open(
        {
          durationSeconds: 900,
          profile: "git-write",
          namespaceId: "rmcook84",
          repositoryRef: projectId,
          expectedBinding: expected.grant,
          deadlineWallMs: clock.wallNow() + 900000,
          preparedOnly: true,
        },
        `${clock.wallNow()}-${randomUUID()}`,
        t.signal,
      )
    ).result;
    return { ...started, clock, tls, config, resources, opened };
  } catch (error) {
    await resources.close(error);
  }
}

test(
  "GitLab Agent sessions read, refuse a forbidden route before dispatch, and stop after withdrawal",
  { skip: !live },
  async (t) => {
    requireLiveAuthorization();
    const fixture = await startGitLabService(t);
    const allowed = await gatewayRequest(fixture, `/api/v4/projects/${projectId}`);
    assert.equal(allowed.status, 200, allowed.body);
    assert.equal(JSON.parse(allowed.body).path_with_namespace, project);

    const forbidden = await gatewayRequest(
      fixture,
      `/api/v4/projects/${projectId}/repository/commits?per_page=100`,
    );
    assert.equal(forbidden.status, 400);
    assert.equal(JSON.parse(forbidden.body).error.code, "unsupported-request");

    const forbiddenBranch = await gatewayRequest(
      fixture,
      `/api/v4/projects/${projectId}/merge_requests`,
      {
        method: "POST",
        body: {
          source_branch: "main",
          target_branch: "main",
          title: "Draft: Unauthorized source branch",
        },
      },
    );
    assert.equal(forbiddenBranch.status, 400);
    assert.equal(JSON.parse(forbiddenBranch.body).error.code, "unsupported-request");

    fixture.service.close(fixture.opened.session.sessionId);
    const withdrawn = await gatewayRequest(fixture, `/api/v4/projects/${projectId}`);
    assert.equal(withdrawn.status, 401);
    assert.equal(JSON.parse(withdrawn.body).error.code, "session-unavailable");
  },
);

test(
  "a GitLab Agent draft create with a lost response is not replayed",
  { skip: !live },
  async (t) => {
    requireLiveAuthorization();
    const title = `Draft: Agent workflow ${Date.now()}`;
    const uncertain = await startGitLabService(t, { apiResponseBytes: 1 });
    const result = await gatewayRequest(uncertain, `/api/v4/projects/${projectId}/merge_requests`, {
      method: "POST",
      body: {
        source_branch: writeBranch,
        target_branch: "main",
        title,
        description: "Created by the GitLab Agent workflow proof.",
      },
    });
    assert.notEqual(result.status, 201);
    uncertain.service.close(uncertain.opened.session.sessionId);

    const verification = await startGitLabService(t);
    const listed = await gatewayRequest(
      verification,
      `/api/v4/projects/${projectId}/merge_requests?state=opened&per_page=100`,
    );
    assert.equal(listed.status, 200, listed.body);
    const matches = JSON.parse(listed.body).filter((mergeRequest) => mergeRequest.title === title);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].draft, true);
    verification.service.close(verification.opened.session.sessionId);
  },
);
