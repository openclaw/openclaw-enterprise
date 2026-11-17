import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { signComputeExecutionRelease } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import {
  githubCredentialEnvironment,
  githubCredentials,
  policy,
} from "../../deploy/examples/strands-box/host/egress.ts";
import { boxGitHubEgress } from "../helpers/strands-box-egress.ts";
import { gh, pairedFixture } from "../helpers/strands-box-protected-fixture.ts";

// Manual lane strands-box-native (docs/testing/strands-box.md): stock gh is a
// host input CI does not stage, so this case runs only when the lane selects it
// and then fails, never skips, without gh.
const selection =
  process.env.OCC_TEST_STRANDS_BOX_NATIVE === "1"
    ? false
    : "select the strands-box-native lane (OCC_TEST_STRANDS_BOX_NATIVE=1)";

test(
  "after activation the Worker installs OCE's token in Box once; stock git and gh push and open one draft, and withdrawal refuses fresh requests while the execution runs",
  { timeout: 90_000, skip: selection },
  async (t) => {
    assert.ok(
      gh,
      "install stock gh at /usr/local/bin/gh or /usr/bin/gh, as the runtime image does",
    );
    const f = await pairedFixture(t);
    const signal = AbortSignal.timeout(80_000);
    const wiring = await f.release.configure(f.context);
    const bind = f.owner.requireRepositoryGitTransport();
    let binding = await bind(f.authority);
    assert.ok(binding.reconcile);
    // Before the release and activation OCE has no committed recipient and prepares nothing.
    await binding.reconcile(signal);
    assert.equal(f.state.materialReads, 0);
    assert.equal(f.host.deliveries.length, 0);
    assert.equal(
      await f.release.enroll(
        f.context,
        wiring,
        f.custody,
        async () => true,
        async () => f.harness,
        (startupId, current) => signComputeExecutionRelease(f.keys.privateKey, startupId, current),
      ),
      true,
    );
    assert.equal(f.sandbox.repositoryAccess!.materialSettledAt(f.revision.id), undefined);
    // A lost delivery reply leaves the OCC intent pending; the next pass reads the host back and
    // confirms that exact version without a second intent or a second Box restart.
    f.host.loseDeliveryReply = true;
    await assert.rejects(binding.reconcile(signal), /did not confirm the repository material/);
    assert.equal(f.state.installs, 1);
    assert.equal(f.state.confirms, 0);
    await binding.reconcile(signal);
    assert.equal(f.state.installs, 1);
    assert.equal(f.state.confirms, 1);
    assert.equal(f.host.deliveries.length, 1);
    assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "ready");
    assert.equal(typeof f.sandbox.repositoryAccess!.materialSettledAt(f.revision.id), "number");
    const delivered = f.host.deliveries[0]!;
    assert.deepEqual(Object.keys(delivered).sort(), [
      "expiresAt",
      "installationId",
      "materialVersion",
      "preparationAttemptId",
      "repositories",
      "value",
    ]);
    // A Worker restart adopts the version the host shows in the live `box run`.
    await binding.close();
    binding = await bind(f.authority);
    await binding.reconcile!(signal);
    assert.equal(f.state.installs, 1);
    assert.equal(f.host.deliveries.length, 1);
    assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "ready");
    // STAGE_A_PROTOTYPE: a renewed version is not installed; Box keeps the one it read.
    f.renew();
    await binding.reconcile!(signal);
    assert.equal(f.state.installs, 1);
    assert.equal(f.host.deliveries.length, 1);

    // The host starts `box run` with exactly these routes, policy and environment.
    const box = await boxGitHubEgress(t, {
      config: githubCredentials(),
      policy: policy([], true),
      boxEnvironment: githubCredentialEnvironment(delivered.value),
      upstream: f.origin.upstreamAgent,
    });
    const workload = box.workloadEnvironment;
    for (const secret of box.secrets) {
      assert.ok(!Object.values(workload).some((value) => value.includes(f.origin.credential)));
      assert.ok(secret.includes(f.origin.credential));
    }
    const git = (args: readonly string[]) => f.client(workload, "/usr/bin/git", args);
    const ghClient = (args: readonly string[]) => f.client(workload, gh!, args);
    const remote = `https://github.com/${f.origin.repository.repository}.git`;
    await git(["clone", remote, "."]);
    await git(["switch", "-c", "review"]);
    await writeFile(join(f.workspace, "tracked.txt"), "review change\n");
    await git([
      "-c",
      "user.name=Agent",
      "-c",
      "user.email=agent@example.invalid",
      "commit",
      "-am",
      "review change",
    ]);
    const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
    await git(["push", remote, "review"]);
    assert.equal(
      (
        await f.origin.git(["--git-dir", f.origin.repoPath, "rev-parse", "refs/heads/review"])
      ).stdout.trim(),
      head,
    );
    const created = await ghClient([
      "pr",
      "create",
      "--draft",
      "--repo",
      f.origin.repository.repository,
      "--head",
      "review",
      "--base",
      "main",
      "--title",
      "Review change",
      "--body",
      "From the Box workload",
    ]);
    assert.match(created.stdout, /https:\/\/github\.com\/example\/review\/pull\/7/);
    assert.deepEqual(f.origin.pulls, [
      {
        number: 7,
        id: "PR_7",
        draft: true,
        head: "review",
        base: "main",
        title: "Review change",
        actor: "installation",
      },
    ]);
    assert.ok(box.requests.every(({ outcome }) => outcome === "injected"));
    assert.deepEqual([...new Set(box.requests.map(({ host }) => host))].sort(), [
      "api.github.com",
      "github.com",
    ]);
    // Box's egress, not OCE, decided each request: Stage A has no per-request authorization.
    assert.equal(f.state.authorizations, 0);

    // The wrong repository: the installation token does not cover it, so GitHub refuses it.
    const refusedBefore = f.origin.refusals.length;
    await assert.rejects(git(["push", "https://github.com/example/other.git", "review"]), {
      code: 128,
      stderr: /Repository not found|not found/,
    });
    await assert.rejects(
      ghClient([
        "pr",
        "create",
        "--draft",
        "--repo",
        "example/other",
        "--head",
        "review",
        "--base",
        "main",
        "--title",
        "Elsewhere",
        "--body",
        "x",
      ]),
      { code: 1, stderr: /Could not resolve to a Repository/ },
    );
    assert.ok(f.origin.refusals.length > refusedBefore);
    // A host outside Box's policy is refused at CONNECT.
    await assert.rejects(git(["ls-remote", "https://gitlab.com/example/review.git"]), {
      code: 128,
    });
    assert.equal(box.requests.at(-1)?.outcome, "refused");
    assert.equal(f.origin.pulls.length, 1);

    // Withdrawal: OCC stops the material and its retirement revokes the token at GitHub. The
    // Driver sends nothing to the host, so `box run` and the chat keep running.
    assert.equal(
      await f.sandbox.repositoryAccess!.retireExpired({ revision: f.revision, signal } as never),
      "withdrawn",
    );
    f.state.withdrawn = true;
    f.origin.revoke();
    await binding.reconcile!(signal);
    assert.equal(f.host.deliveries.length, 1);
    assert.equal(f.host.deletes, 0);
    assert.equal(f.host.state, "running");
    const writes = f.origin.writes.length;
    const revokedBefore = f.origin.refusals.filter(({ status }) => status === 401).length;
    // Git answers GitHub's 401 by asking for a credential, which the workload does not have.
    await assert.rejects(git(["push", remote, "review:refs/heads/again"]), {
      code: 128,
      stderr: /could not read Username|Authentication failed/,
    });
    await assert.rejects(
      ghClient([
        "pr",
        "create",
        "--draft",
        "--repo",
        f.origin.repository.repository,
        "--head",
        "review",
        "--base",
        "main",
        "--title",
        "Again",
        "--body",
        "x",
      ]),
      { code: 1, stderr: /401|Bad credentials/ },
    );
    assert.equal(f.origin.writes.length, writes);
    assert.equal(f.origin.pulls.length, 1);
    assert.ok(f.origin.refusals.filter(({ status }) => status === 401).length >= revokedBefore + 2);
    // The host no longer reports the execution: the next pass retires the recipient.
    f.host.present = false;
    await binding.reconcile!(signal);
    assert.equal(f.sandbox.repositoryAccess!.routeReadiness(f.revision.id), "pending");
    await binding.close();
  },
);
