import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createRepositoryPlatformFixture,
  repositoryPlatformSelected,
} from "../helpers/repository-credentials-platform.mjs";

function gatewayContainerId(pod) {
  const container = pod.status.containerStatuses.find(({ name }) => name === "gateway");
  assert.match(container.containerID, /^containerd:\/\/[a-f0-9]+$/);
  return container.containerID.slice("containerd://".length);
}

test(
  "ordinary Agent repository bindings traverse HTTP, PostgreSQL, Unix control and Kubernetes material",
  {
    skip: repositoryPlatformSelected
      ? false
      : "Set OCC_TEST_REPOSITORY_CREDENTIALS_PLATFORM=1 with dedicated PostgreSQL, disposable k3d and the final-runtime fixture image.",
    timeout: 900_000,
  },
  async (context) => {
    const fixture = await createRepositoryPlatformFixture(context);
    const { namespace, credentials, kube, placement } = fixture;
    const agent = await fixture.createAgent([
      { repositoryRef: "repo-a", profile: "git-full" },
      { repositoryRef: "repo-b", profile: "git-read" },
    ]);
    const path = `/namespaces/${namespace.id}/agents/${agent.id}`;
    await fixture.request(
      "PATCH",
      path,
      {
        configurationId: agent.configurationId,
        repositoryBindings: [{ repositoryRef: "unapproved-repository" }],
      },
      404,
    );
    assert.ok(credentials.repositories.every(({ github }) => github.issuesOfTokens.length === 0));
    assert.deepEqual(
      (await fixture.request("GET", path)).repositoryBindings,
      agent.repositoryBindings,
    );
    // The second real admission succeeds remotely while its response is held.
    // Expiring the real PostgreSQL lease leaves a partly recorded binding set;
    // recovery must close the once-delivered session before replacing it.
    const gate = fixture.control.holdCreatedResponse(2);
    let withheld;
    let withheldAdmission;
    void gate.observed.then((receipt) => {
      withheld = receipt;
    });
    const revision = await fixture.request("POST", `${path}/deploy`, undefined, 202);
    try {
      await kube.waitFor(
        "second admission response at the actual Unix transport",
        () => withheld,
        30_000,
      );
      const partial = await fixture.attempts(revision);
      assert.equal(partial.filter(({ phase }) => phase === "open").length, 1);
      assert.equal(partial.filter(({ phase }) => phase === "opening").length, 1);
      withheldAdmission = partial.find(({ phase }) => phase === "opening").admission_id;
      assert.equal((await credentials.status(withheld.sessionId)).state, "OPEN");
      const pods = await kube.resources("pods", placement, "-l", `openclaw.dev/agent=${agent.id}`);
      assert.equal(pods.length, 0, "a partial credential set must not reach Compute");
      const claimCursor = fixture.events.length;
      const expired = await fixture.pool.query(
        "UPDATE occ.controller_work SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE revision_id=$1 AND state='claimed' RETURNING idempotency_key",
        [revision.id],
      );
      assert.equal(expired.rowCount, 1);
      await kube.waitFor(
        "actual lease loss to abort the partial deployment",
        () =>
          fixture.events
            .slice(claimCursor)
            .some((event) => event.event === "worker.error" && event.code === "CLAIM_LOST"),
        30_000,
      );
    } finally {
      gate.release();
    }
    let pod = await fixture.readyPod(agent, revision);
    const original = await fixture.material(pod);
    assert.deepEqual(
      original.bindings.map(({ repositoryRef }) => repositoryRef),
      ["repo-a", "repo-b"],
    );
    assert.notEqual(original.bindings[0].sessionId, original.bindings[1].sessionId);
    for (const binding of original.bindings) {
      assert.equal(binding.directoryMode, 0o700);
      for (const file of binding.files) {
        assert.equal(file.regular, true);
        assert.equal(file.symbolicLink, false);
        assert.equal(file.mode, 0o600);
      }
    }
    // Recovery needs confirmed disposal once it has persisted a session identity.
    // Missing inventory is safe only for a never-delivered opening with no known session.
    await kube.waitFor("lost-response admission cleanup", async () =>
      (await fixture.attempts(revision)).some(
        ({ admission_id, session_id, phase }) =>
          admission_id === withheldAdmission &&
          ((phase === "disposed" && session_id === withheld.sessionId) ||
            (phase === "invalidated" && session_id === null)),
      ),
    );
    const recovered = await fixture.attempts(revision);
    assert.ok(
      recovered.some(
        ({ admission_id, session_id, phase }) =>
          admission_id === withheldAdmission &&
          ((phase === "disposed" && session_id === withheld.sessionId) ||
            (phase === "invalidated" && session_id === null)),
      ),
    );
    assert.notEqual((await credentials.status(withheld.sessionId))?.state, "OPEN");
    const owned = recovered.filter(({ phase }) => phase === "open");
    assert.equal(owned.length, 2);
    for (const binding of original.bindings) {
      const attempt = owned.find((row) => row.repository_ref === binding.repositoryRef);
      assert.equal(attempt.phase, "open");
      assert.equal(attempt.session_id, binding.sessionId);
      const status = await credentials.status(binding.sessionId);
      assert.equal(status.state, "OPEN");
      assert.equal(status.deadlineWallMs, binding.deadlineWallMs);
      // Whole-second session duration may shorten the immutable ceiling.
      assert.ok(binding.deadlineWallMs > 0);
      assert.ok(binding.deadlineWallMs <= Number(attempt.deadline_wall_ms));
    }
    context.diagnostic(
      "Actual HTTP admission and PostgreSQL-owned sessions reached private regular files in the Agent Pod.",
    );

    // The runtime image retains the real clients. Only the Harness is a fixture;
    // this deterministic case makes no model-execution claim.
    const [first, second] = credentials.repositories;
    const workspace = "/home/node/.openclaw/workspace";
    const firstCheckout = `${workspace}/repository`;
    const secondCheckout = `${workspace}/other`;
    await fixture.tool(pod, "git", ["clone", `https://github.com/${first.repository}.git`]);
    await fixture.tool(pod, "git", ["clone", `https://github.com/${second.repository}.git`]);
    const [metadata, remote] = await Promise.all([
      fixture.tool(pod, "gh", ["api", `repos/${first.repository}`], { cwd: firstCheckout }),
      fixture.tool(pod, "git", ["-C", secondCheckout, "ls-remote", "origin", "HEAD"]),
    ]);
    assert.equal(JSON.parse(metadata).full_name, first.repository);
    assert.match(remote, /^[a-f0-9]{40}\s+HEAD\s*$/);
    assert.deepEqual(first.github.issuesOfTokens[0].repositoryIds.map(String), [
      first.repositoryId,
    ]);
    assert.deepEqual(second.github.issuesOfTokens[0].repositoryIds.map(String), [
      second.repositoryId,
    ]);
    assert.equal(second.github.issuesOfTokens[0].permissions.contents, "read");

    await fixture.tool(pod, "git", ["-C", firstCheckout, "fetch", "origin"]);
    await fixture.tool(pod, "git", ["-C", firstCheckout, "switch", "-c", "native-feature"]);
    await fixture.podNode(
      pod,
      `require('node:fs').writeFileSync(${JSON.stringify(`${firstCheckout}/platform-proof.txt`)}, ${JSON.stringify("repository platform proof\n")});`,
    );
    await fixture.tool(pod, "git", ["-C", firstCheckout, "add", "platform-proof.txt"]);
    await fixture.tool(pod, "git", [
      "-C",
      firstCheckout,
      "-c",
      "user.name=Platform Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "Repository platform proof",
    ]);
    const commit = (
      await fixture.tool(pod, "git", ["-C", firstCheckout, "rev-parse", "HEAD"])
    ).trim();
    await fixture.tool(pod, "git", [
      "-C",
      firstCheckout,
      "push",
      "origin",
      "HEAD:refs/heads/native-feature",
    ]);
    assert.equal(await first.git.ref("refs/heads/native-feature"), commit);
    // One forbidden destination rejects the whole native push before
    // receive-pack; the real upstream must retain both observed refs.
    const beforeMain = await first.git.ref("refs/heads/main");
    const beforeFeature = await first.git.ref("refs/heads/native-feature");
    const beforeMixed = first.git.trace.length;
    await fixture.tool(
      pod,
      "git",
      [
        "-C",
        firstCheckout,
        "push",
        "origin",
        "HEAD:refs/heads/agent/mixed",
        "HEAD:refs/heads/main",
      ],
      { expected: "failure" },
    );
    assert.equal(await first.git.ref("refs/heads/main"), beforeMain);
    assert.equal(await first.git.ref("refs/heads/native-feature"), beforeFeature);
    assert.equal(
      (
        await fixture.tool(pod, "git", [
          "-C",
          firstCheckout,
          "ls-remote",
          "origin",
          "refs/heads/agent/mixed",
        ])
      ).trim(),
      "",
    );
    assert.equal(
      first.git.trace.slice(beforeMixed).some(({ path }) => path.endsWith("/git-receive-pack")),
      false,
    );
    // Collaborator can create ordinary issues; the Contributor Agent below
    // opens the single PR retained by the restart and no-replay assertions.
    const issue = JSON.parse(
      await fixture.tool(
        pod,
        "gh",
        ["api", `repos/${first.repository}/issues`, "-X", "POST", "-f", "title=Collaborator issue"],
        { cwd: firstCheckout },
      ),
    );
    assert.equal(first.github.issues.get(issue.number)?.title, "Collaborator issue");
    assert.equal(second.github.issues.size, 0);

    // A different admitted binding cannot upgrade this read-only repository.
    const secondBefore = second.git.trace.length;
    await fixture.tool(
      pod,
      "git",
      ["-C", secondCheckout, "push", "origin", "HEAD:refs/heads/denied-write"],
      { expected: "failure" },
    );
    assert.equal(
      second.git.trace.slice(secondBefore).some(({ path }) => path.endsWith("/git-receive-pack")),
      false,
    );
    await fixture.tool(pod, "gh", ["api", `repos/${second.repository}`], {
      cwd: secondCheckout,
    });
    const beforeDeniedApi = second.github.trace.length;
    await fixture.tool(
      pod,
      "gh",
      ["api", "--method", "POST", `repos/${second.repository}/issues`],
      {
        cwd: secondCheckout,
        expected: 1,
      },
    );
    assert.equal(second.github.trace.length, beforeDeniedApi);

    // Contributor admits selected reads and PR work, while ordinary issue
    // creation still requires Collaborator authority.
    const writer = await fixture.createAgent([{ repositoryRef: "repo-a", profile: "git-write" }]);
    const writerPath = `/namespaces/${namespace.id}/agents/${writer.id}`;
    const writerRevision = await fixture.request("POST", `${writerPath}/deploy`, undefined, 202);
    const writerPod = await fixture.readyPod(writer, writerRevision);
    await fixture.tool(writerPod, "git", [
      "ls-remote",
      `https://github.com/${first.repository}.git`,
      "HEAD",
    ]);
    assert.deepEqual(first.github.issuesOfTokens.at(-1).permissions, {
      metadata: "read",
      contents: "write",
      issues: "read",
      pull_requests: "write",
      checks: "read",
      statuses: "read",
    });
    await fixture.tool(writerPod, "gh", ["api", `repos/${first.repository}`]);
    await fixture.tool(writerPod, "gh", [
      "pr",
      "create",
      "--repo",
      `github.com/${first.repository}`,
      "--head",
      "native-feature",
      "--base",
      "main",
      "--title",
      "Contributor PR",
      "--body",
      "Contributor can open pull requests",
    ]);
    assert.ok([...first.github.pulls.values()].some((pull) => pull.title === "Contributor PR"));
    assert.equal([...first.github.pulls.values()].filter(({ native }) => native).length, 1);
    assert.equal(second.github.pulls.size, 0);
    const writerTrace = first.github.trace.length;
    await fixture.tool(
      writerPod,
      "gh",
      [
        "api",
        `repos/${first.repository}/issues`,
        "-X",
        "POST",
        "-f",
        "title=Denied ordinary issue",
      ],
      { expected: "failure" },
    );
    assert.equal(first.github.trace.length, writerTrace);
    await fixture.request("POST", `${writerPath}/stop`, undefined, 202);
    await kube.waitFor("write-profile Agent stop without affecting its sibling", async () =>
      (await fixture.attempts(writerRevision)).every(
        ({ phase }) => phase === "disposed" || phase === "invalidated",
      ),
    );
    assert.equal((await fixture.request("GET", path)).activeRevisionId, revision.id);
    assert.equal((await fixture.material(pod)).generation, original.generation);
    context.diagnostic(
      "The same Agent used both independently scoped bindings; real Git/gh preserved profile denial and repository routing.",
    );

    // TEST-007: only the worker process dies. The existing HTTP listener,
    // service sessions and running Agent must survive without fresh authority.
    const previousWorkerPid = fixture.workerPid;
    const endpoint = fixture.endpoint;
    const service = credentials.process;
    const admissions = (await fixture.attempts(revision))
      .map(({ admission_id }) => admission_id)
      .sort();
    const issuanceCounts = credentials.repositories.map(
      ({ github }) => github.issuesOfTokens.length,
    );
    const death = await fixture.killWorker();
    let replacementCursor;
    try {
      assert.deepEqual(death, { pid: previousWorkerPid, code: null, signal: "SIGKILL" });
      assert.equal((await fixture.request("GET", path)).activeRevisionId, revision.id);
      assert.equal(fixture.endpoint, endpoint);
      assert.deepEqual(credentials.process, service);
      const survivingPod = await fixture.readyPod(agent, revision);
      assert.equal(survivingPod.metadata.uid, pod.metadata.uid);
      assert.equal(gatewayContainerId(survivingPod), gatewayContainerId(pod));
      assert.deepEqual(await fixture.material(survivingPod), original);
      await fixture.tool(survivingPod, "git", ["-C", firstCheckout, "fetch", "origin"]);
    } finally {
      // Teardown needs a live worker to settle Agent stop even if an assertion fails.
      replacementCursor = fixture.events.length;
      await fixture.startWorker();
    }
    assert.notEqual(fixture.workerPid, previousWorkerPid);
    await kube.waitFor("maintenance after worker replacement", async () =>
      fixture.events
        .slice(replacementCursor)
        .some(
          (event) =>
            event.event === "worker.completed" &&
            event.revisionId === revision.id &&
            event.code === "REVISION_ALREADY_ACTIVE",
        ),
    );
    assert.deepEqual(
      (await fixture.attempts(revision))
        .filter(({ phase }) => phase === "open")
        .map(({ session_id }) => session_id)
        .sort(),
      owned.map(({ session_id }) => session_id).sort(),
    );
    const maintainedPod = await fixture.readyPod(agent, revision);
    assert.equal(maintainedPod.metadata.uid, pod.metadata.uid);
    assert.equal(gatewayContainerId(maintainedPod), gatewayContainerId(pod));
    assert.deepEqual(await fixture.material(maintainedPod), original);
    assert.equal(fixture.endpoint, endpoint);
    assert.deepEqual(credentials.process, service);
    assert.deepEqual(
      (await fixture.attempts(revision)).map(({ admission_id }) => admission_id).sort(),
      admissions,
    );
    assert.deepEqual(
      credentials.repositories.map(({ github }) => github.issuesOfTokens.length),
      issuanceCounts,
      "worker recovery must not mint provider authority",
    );
    for (const binding of original.bindings) {
      const status = await credentials.status(binding.sessionId);
      assert.equal(status.state, "OPEN");
      assert.equal(status.deadlineWallMs, binding.deadlineWallMs);
    }

    // TEST-009: retain both unpushed history and dirty work across material-driven
    // Pod replacement. This makes no claim about resuming a command or model turn.
    const retainedFiles = {
      [`${workspace}/replacement-sentinel.txt`]: "workspace survives material replacement\n",
      [`${firstCheckout}/local-only.txt`]: "local commit survives material replacement\n",
      [`${firstCheckout}/platform-proof.txt`]: "uncommitted edit survives material replacement\n",
    };
    await fixture.podNode(
      pod,
      `
      const fs = require("node:fs");
      const files = JSON.parse(fs.readFileSync(0, "utf8"));
      for (const [path, content] of Object.entries(files)) fs.writeFileSync(path, content);
    `,
      JSON.stringify(retainedFiles),
    );
    await fixture.tool(pod, "git", ["-C", firstCheckout, "add", "local-only.txt"]);
    await fixture.tool(pod, "git", [
      "-C",
      firstCheckout,
      "-c",
      "user.name=Platform Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-m",
      "Retain local workspace change",
    ]);
    const localCommit = (
      await fixture.tool(pod, "git", ["-C", firstCheckout, "rev-parse", "HEAD"])
    ).trim();
    assert.notEqual(localCommit, commit);
    assert.equal(
      (await fixture.tool(pod, "git", ["-C", firstCheckout, "rev-parse", "HEAD^"])).trim(),
      commit,
    );
    assert.equal(await first.git.ref("refs/heads/native-feature"), commit);
    async function workspaceSnapshot(currentPod) {
      const result = await fixture.podNode(
        currentPod,
        `
        const fs = require("node:fs");
        const { createHash } = require("node:crypto");
        const paths = JSON.parse(fs.readFileSync(0, "utf8"));
        console.log(JSON.stringify(paths.map(path => ({path,
          hash: createHash("sha256").update(fs.readFileSync(path)).digest("hex")}))));
      `,
        JSON.stringify(Object.keys(retainedFiles)),
      );
      return {
        volume: await fixture.workspaceVolume(currentPod, workspace),
        files: JSON.parse(result.stdout),
        head: (
          await fixture.tool(currentPod, "git", ["-C", firstCheckout, "rev-parse", "HEAD"])
        ).trim(),
        status: await fixture.tool(currentPod, "git", [
          "-C",
          firstCheckout,
          "status",
          "--porcelain=v1",
        ]),
      };
    }
    const workspaceBefore = await workspaceSnapshot(pod);
    assert.equal(workspaceBefore.head, localCommit);
    assert.equal(workspaceBefore.status, " M platform-proof.txt\n");
    assert.deepEqual(
      workspaceBefore.files,
      Object.entries(retainedFiles).map(([path, content]) => ({
        path,
        hash: createHash("sha256").update(content).digest("hex"),
      })),
    );
    assert.ok((await fixture.runningPodContainers(pod)).includes(gatewayContainerId(pod)));
    async function assertWorkspaceReplacement(previous, replacement) {
      assert.notEqual(replacement.metadata.uid, previous.metadata.uid);
      assert.notEqual(gatewayContainerId(replacement), gatewayContainerId(previous));
      await kube.waitFor("predecessor Pod and container processes to terminate", async () => {
        const pods = await kube.resources(
          "pods",
          placement,
          "-l",
          `openclaw.dev/agent=${agent.id}`,
        );
        return (
          !pods.some(({ metadata }) => metadata.uid === previous.metadata.uid) &&
          (await fixture.runningPodContainers(previous)).length === 0
        );
      });
      assert.ok(
        (await fixture.runningPodContainers(replacement)).includes(gatewayContainerId(replacement)),
      );
      assert.deepEqual(await workspaceSnapshot(replacement), workspaceBefore);
      assert.equal(await first.git.ref("refs/heads/native-feature"), commit);
    }

    // Removing exactly one real immutable Secret exercises retained-material
    // repair through Compute's observation and the normal worker retry path.
    const projected = pod.spec.volumes.find(
      ({ name }) => name === "repository-material-projection",
    );
    assert.equal(projected.projected.sources.length, 2);
    await kube.kubectl(
      "delete",
      "secret",
      projected.projected.sources[0].secret.name,
      "-n",
      placement,
    );
    const repairedPod = await fixture.readyPod(agent, revision, pod.metadata.uid);
    await assertWorkspaceReplacement(pod, repairedPod);
    const repaired = await fixture.material(repairedPod);
    assert.notEqual(repaired.generation, original.generation);
    assert.notEqual(repaired.bindings[0].sessionId, original.bindings[0].sessionId);
    assert.equal(repaired.bindings[1].sessionId, original.bindings[1].sessionId);
    assert.notEqual((await credentials.status(original.bindings[0].sessionId))?.state, "OPEN");
    pod = repairedPod;

    async function revisionWork(currentRevision) {
      return (
        await fixture.pool.query(
          `SELECT idempotency_key, namespace_id, agent_id, revision_id, actor_id, state, reason_code
         FROM occ.controller_work WHERE namespace_id=$1 AND agent_id=$2 AND revision_id=$3`,
          [namespace.id, agent.id, currentRevision.id],
        )
      ).rows;
    }
    async function assertRefused(currentRevision, previousPod, before) {
      const failed = await kube.waitFor("lost session to refuse its exact revision", async () =>
        (await revisionWork(currentRevision)).find(
          (work) =>
            work.state === "failed_permanent" &&
            work.reason_code === "REPOSITORY_SESSION_RECOVERY_UNSAFE",
        ),
      );
      const retirementKey = `agent_revision:${currentRevision.id}:repository_cleanup:retire:${createHash(
        "sha256",
      )
        .update(failed.idempotency_key)
        .digest("hex")}`;
      const retirement = await kube.waitFor("exact unresolved retirement Work owner", async () =>
        (await revisionWork(currentRevision)).find(
          (work) =>
            work.idempotency_key === retirementKey &&
            work.state === "queued" &&
            work.reason_code === null,
        ),
      );
      assert.equal(retirement.namespace_id, namespace.id);
      assert.equal(retirement.agent_id, agent.id);
      assert.equal(retirement.revision_id, currentRevision.id);
      assert.equal(retirement.actor_id, failed.actor_id);
      // Queued Work has no terminal reason; the worker reports pending cleanup separately.
      await kube.waitFor("exact retirement Work pending cleanup event", () =>
        fixture.events.some(
          (event) =>
            event.event === "worker.completed" &&
            event.workId === retirementKey &&
            event.namespaceId === namespace.id &&
            event.agentId === agent.id &&
            event.revisionId === currentRevision.id &&
            event.outcome === "pending" &&
            event.code === "REPOSITORY_CLEANUP_PENDING",
        ),
      );
      await kube.waitFor(
        "refused revision's actual Pod, process and Secret retirement",
        async () => {
          const pods = await kube.resources(
            "pods",
            placement,
            "-l",
            `openclaw.dev/agent=${agent.id}`,
          );
          const secrets = await kube.resources(
            "secrets",
            placement,
            "-l",
            `openclaw.dev/agent=${agent.id},openclaw.dev/repository-material=session`,
          );
          return (
            pods.length === 0 &&
            secrets.length === 0 &&
            (await fixture.runningPodContainers(previousPod)).length === 0
          );
        },
      );
      const after = await fixture.attempts(currentRevision);
      assert.deepEqual(
        after.map(({ admission_id }) => admission_id),
        before.map(({ admission_id }) => admission_id),
        "no automatic same-revision admission",
      );
      for (const attempt of before.filter(({ phase }) => phase === "open")) {
        const retained = after.find(({ admission_id }) => admission_id === attempt.admission_id);
        assert.deepEqual(retained, { ...attempt, phase: "invalidated" });
        assert.equal(retained.live_revision_id, currentRevision.id);
        assert.ok(retained.cleanup_context.driver);
        assert.equal(retained.cleanup_context.binding.repositoryRef, attempt.repository_ref);
      }
      return { attempts: after, retirementKey };
    }
    async function deployAfterLoss(previousRevision, previousPod, previousMaterial) {
      // This real authorized HTTP request creates a new immutable revision. It does
      // not settle old provider effects or replay the earlier Git/PR operations.
      const next = await fixture.request("POST", `${path}/deploy`, undefined, 202);
      assert.notEqual(next.id, previousRevision.id);
      const nextPod = await fixture.readyPod(agent, next, previousPod.metadata.uid);
      await assertWorkspaceReplacement(previousPod, nextPod);
      const material = await fixture.material(nextPod);
      assert.notEqual(material.generation, previousMaterial.generation);
      const attempts = await fixture.attempts(next);
      for (const binding of material.bindings) {
        assert.notEqual(
          binding.sessionId,
          previousMaterial.bindings.find((entry) => entry.repositoryRef === binding.repositoryRef)
            .sessionId,
        );
        const status = await credentials.status(binding.sessionId);
        assert.equal(status.state, "OPEN");
        assert.equal(status.deadlineWallMs, binding.deadlineWallMs);
        assert.ok(
          binding.deadlineWallMs <=
            Number(
              attempts.find((attempt) => attempt.session_id === binding.sessionId).deadline_wall_ms,
            ),
        );
      }
      return { revision: next, pod: nextPod, material };
    }

    // Graceful shutdown settles the service's tracked tokens, but destroying its
    // inventory leaves the worker without surviving disposition evidence.
    const gracefulAttempts = await fixture.attempts(revision);
    const gracefulService = credentials.process;
    await credentials.restart();
    assert.notEqual(credentials.process.pid, gracefulService.pid);
    assert.equal(credentials.process.generation, gracefulService.generation + 1);
    const gracefulRefusal = await assertRefused(revision, pod, gracefulAttempts);
    const restarted = await deployAfterLoss(revision, pod, repaired);
    await fixture.tool(restarted.pod, "git", ["-C", firstCheckout, "fetch", "origin"]);
    await fixture.tool(restarted.pod, "git", ["-C", secondCheckout, "fetch", "origin"]);

    // Kill only the service. The provider observations, HTTP listener, worker and
    // actual workload remain alive so loss cannot masquerade as successful cleanup.
    const crashService = credentials.process;
    const crashWorkerPid = fixture.workerPid;
    const crashAttempts = await fixture.attempts(restarted.revision);
    const oldBearerProbe = await fixture.retainBearerProbe(restarted.pod, "repo-a");
    const outstanding = credentials.repositories.map(({ github }) => {
      const lastUse = github.authenticationAttempts.at(-1);
      const token = github.tokenState().find(({ index }) => index === lastUse.tokenIndex);
      assert.equal(token.revoked, false);
      assert.ok(token.expires > credentials.clock.wallNow());
      return token;
    });
    const beforeCrashIssuance = credentials.repositories.map(
      ({ github }) => github.issuesOfTokens.length,
    );
    let crashFailure;
    let replacementFailure;
    try {
      const serviceDeath = await credentials.kill();
      assert.deepEqual(serviceDeath, { pid: crashService.pid, code: null, signal: "SIGKILL" });
      assert.equal((await fixture.request("GET", path)).activeRevisionId, restarted.revision.id);
      assert.equal(fixture.endpoint, endpoint);
      assert.equal(fixture.workerPid, crashWorkerPid);
      assert.doesNotThrow(() => process.kill(crashWorkerPid, 0));
      const survivingPod = await fixture.readyPod(agent, restarted.revision);
      assert.equal(survivingPod.metadata.uid, restarted.pod.metadata.uid);
      assert.equal(gatewayContainerId(survivingPod), gatewayContainerId(restarted.pod));
      assert.ok(
        (await fixture.runningPodContainers(survivingPod)).includes(
          gatewayContainerId(survivingPod),
        ),
      );
      assert.deepEqual(await fixture.material(survivingPod), restarted.material);
      for (const [index, { github }] of credentials.repositories.entries()) {
        assert.deepEqual(
          github.tokenState().find((token) => token.index === outstanding[index].index),
          outstanding[index],
          "service death cannot revoke parent-owned provider authority",
        );
      }
    } catch (error) {
      crashFailure = error;
    } finally {
      // Production startup must recover its stale Unix socket after joined death.
      // A replacement remains available for normal worker/Agent teardown on failure.
      try {
        if (!credentials.process.alive) {
          await credentials.start();
        }
      } catch (error) {
        replacementFailure = error;
      }
    }
    if (crashFailure !== undefined && replacementFailure !== undefined) {
      throw new AggregateError(
        [crashFailure, replacementFailure],
        "service crash observation and replacement failed",
        { cause: crashFailure },
      );
    }
    if (crashFailure !== undefined || replacementFailure !== undefined) {
      throw crashFailure ?? replacementFailure;
    }
    assert.notEqual(credentials.process.pid, crashService.pid);
    assert.equal(credentials.process.generation, crashService.generation + 1);
    for (const binding of restarted.material.bindings) {
      assert.equal(await credentials.status(binding.sessionId), undefined);
    }
    const crashRefusal = await assertRefused(restarted.revision, restarted.pod, crashAttempts);
    assert.equal(fixture.workerPid, crashWorkerPid);
    assert.doesNotThrow(() => process.kill(crashWorkerPid, 0));
    assert.deepEqual(
      credentials.repositories.map(({ github }) => github.issuesOfTokens.length),
      beforeCrashIssuance,
    );
    for (const [index, { github }] of credentials.repositories.entries()) {
      const token = github.tokenState().find((token) => token.index === outstanding[index].index);
      assert.deepEqual(token, outstanding[index]);
      assert.ok(token.expires > credentials.clock.wallNow());
    }
    const recoveredAfterCrash = await deployAfterLoss(
      restarted.revision,
      restarted.pod,
      restarted.material,
    );
    const beforeProbe = credentials.repositories.map(
      ({ github }) => github.authenticationAttempts.length,
    );
    assert.deepEqual(await oldBearerProbe(recoveredAfterCrash.pod), {
      status: 401,
      code: "session-unavailable",
    });
    assert.deepEqual(
      credentials.repositories.map(({ github }) => github.authenticationAttempts.length),
      beforeProbe,
    );
    for (const [index, { github }] of credentials.repositories.entries()) {
      const token = github.tokenState().find((token) => token.index === outstanding[index].index);
      assert.deepEqual(token, outstanding[index]);
      assert.ok(token.expires > credentials.clock.wallNow());
    }
    await fixture.tool(recoveredAfterCrash.pod, "git", ["-C", firstCheckout, "fetch", "origin"]);
    assert.equal([...first.github.pulls.values()].filter(({ native }) => native).length, 1);
    assert.equal(await first.git.ref("refs/heads/native-feature"), commit);
    const beforeRenewal = first.github.issuesOfTokens.length;
    // Controlled provider/service time proves hour-thirteen renewal without a
    // wall-clock wait. Perform it after repairs so new admission timestamps use
    // the same real clock as the worker throughout the lifecycle assertions.
    await credentials.clock.advance(13 * 60 * 60 * 1000);
    await fixture.tool(recoveredAfterCrash.pod, "git", ["-C", firstCheckout, "fetch", "origin"]);
    assert.ok(first.github.issuesOfTokens.length > beforeRenewal);
    assert.equal(
      (await fixture.material(recoveredAfterCrash.pod)).generation,
      recoveredAfterCrash.material.generation,
    );
    context.diagnostic(
      "Worker survival, material repair, graceful restart and SIGKILL refusal, explicit new revisions, and controlled hour-thirteen renewal traversed the real platform path.",
    );

    await fixture.request("POST", `${path}/stop`, undefined, 202);
    await kube.waitFor(
      "ordinary Agent stop to retire runtime and settle current sessions",
      async () => {
        const current = await fixture.request("GET", path);
        const attempts = await fixture.attempts(recoveredAfterCrash.revision);
        const pods = await kube.resources(
          "pods",
          placement,
          "-l",
          `openclaw.dev/agent=${agent.id}`,
        );
        return (
          current.activeRevisionId === undefined &&
          pods.length === 0 &&
          attempts.every(({ phase }) => phase === "disposed" || phase === "invalidated")
        );
      },
    );
    for (const binding of recoveredAfterCrash.material.bindings) {
      assert.notEqual((await credentials.status(binding.sessionId))?.state, "OPEN");
    }
    // Neither a new revision nor later token expiry rewrites lost custody as disposal.
    for (const [lostRevision, retained] of [
      [revision, gracefulRefusal],
      [restarted.revision, crashRefusal],
    ]) {
      assert.deepEqual(await fixture.attempts(lostRevision), retained.attempts);
      const cleanup = (await revisionWork(lostRevision)).find(
        ({ idempotency_key }) => idempotency_key === retained.retirementKey,
      );
      assert.ok(["queued", "claimed"].includes(cleanup.state));
      assert.notEqual(cleanup.state, "succeeded");
    }
    const remaining = await kube.resources(
      "secrets",
      placement,
      "-l",
      `openclaw.dev/agent=${agent.id},openclaw.dev/repository-material=session`,
    );
    assert.equal(
      remaining.length,
      0,
      "runtime material must be removed after actual Pod termination",
    );
    for (const repository of credentials.repositories) {
      assert.deepEqual(repository.github.errors, []);
    }
  },
);
