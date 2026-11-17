import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import {
  createExternalDriver,
  createExternalProtectedDriver,
  loadDriverPackage,
} from "../../apps/controller/src/composition/driver-packages.ts";
import { signComputeExecutionRelease } from "../../apps/controller/src/drivers/compute/egress-enrollment.ts";
import {
  endpoint,
  id,
  implementation,
  installPackage,
  namespace,
  packageName,
  pairedFixture,
  publicCa,
  relay,
  sha,
  stageBEndToEnd,
} from "../helpers/strands-box-protected-fixture.ts";

test(
  "only the paired loader admits a protectedRepository registration, and only with both capabilities",
  { timeout: 60_000 },
  async (t) => {
    const { directory, packageRoot } = await installPackage(t);
    const loaded = await loadDriverPackage({ package: packageName }, "sandbox", packageRoot, false);
    assert.ok(loaded);
    const ordinary = {
      namespace: namespace.name,
      controlSocket: join(directory, "control.sock"),
      nativeEndpoint: endpoint.url,
      nativeCaBundle: await publicCa(directory),
      workspaceRoot: endpoint.workspaceRoot,
      relay,
    };
    // Nothing about the repository, branch or sender is configured: OCE's grant selects it.
    const paired = { ...ordinary, protectedRepository: { provider: "github" } };
    assert.deepEqual(loaded.module.validateConfiguration?.(paired), []);
    assert.deepEqual(
      (loaded.module.configurationSchema as { properties: Record<string, unknown> }).properties
        .protectedRepository,
      {
        type: "object",
        additionalProperties: false,
        required: ["provider"],
        properties: { provider: { type: "string", enum: ["github"] } },
      },
    );
    const selection = (configuration: object) => ({
      id,
      implementation,
      configuration: configuration as Record<string, unknown>,
      definition: loaded.module,
    });
    // The ordinary loader refuses the registration; the paired loader refuses the plain Driver.
    assert.throws(
      () => createExternalDriver(loaded.module, selection(paired), "sandbox"),
      /unselected Driver identity/,
    );
    assert.throws(
      () => createExternalProtectedDriver(loaded.module, selection(ordinary)),
      /one Driver registration/,
    );
    const plain = createExternalDriver(loaded.module, selection(ordinary), "sandbox");
    assert.equal("repositoryAccess" in plain, false);
    assert.equal("enrollHarness" in plain, false);
    const owner = createExternalProtectedDriver(loaded.module, selection(paired));
    t.after(() => owner.close());
    assert.equal(typeof owner.requireRepositoryGitTransport(), "function");
    const sandbox = owner.require("sandbox");
    assert.ok(sandbox.repositoryAccess);
    assert.equal(typeof sandbox.enrollHarness, "function");
    assert.equal(
      typeof (sandbox as { protectedWorkspaceEndpoint?: unknown }).protectedWorkspaceEndpoint,
      "function",
    );
    const proxy = owner.require("credential_proxy");
    assert.deepEqual(
      await proxy.sourceControl.assertAvailable?.(AbortSignal.timeout(1_000), "github_repository"),
      { profile: "github_repository", authorization: "online-request" },
    );
    await assert.rejects(
      async () =>
        proxy.sourceControl.assertAvailable?.(AbortSignal.timeout(1_000), "github_installation"),
      /only one GitHub repository/,
    );
  },
);

test(
  "Compute's held enrollment releases one host-observed Box execution through the paired Driver",
  { timeout: 30_000 },
  async (t) => {
    const f = await pairedFixture(t);
    const signal = AbortSignal.timeout(20_000);
    assert.equal(f.release.admits(f.revision, "stored"), true);
    // Compute rechecks the sender guarantee and the paired wiring before anything is installed.
    await assert.rejects(
      f.release.configure({ ...f.context, plan: { ...f.plan, routes: [{} as never] } }),
      /no longer owns|one online-request/,
    );
    const wiring = await f.release.configure(f.context);
    assert.deepEqual(wiring, { plan: f.plan, configuration: f.wiringConfiguration });
    assert.equal(
      await f.proxy.wiringStatus(f.context, { ...wiring, configuration: { version: 2 } }),
      undefined,
    );

    // The held reservation is the installation: its recipient is the host control process and
    // the execution bearer, fixed before Box starts; Box presents the bearer to the source.
    const endpoint = (
      f.sandbox as unknown as {
        protectedWorkspaceEndpoint(c: object): Promise<Record<string, unknown> | undefined>;
      }
    ).protectedWorkspaceEndpoint.bind(f.sandbox);
    const withdrawal = {
      namespace,
      kubernetes: undefined,
      revision: f.revision,
      signal,
    };
    assert.deepEqual((await endpoint(withdrawal))?.original, {
      purpose: "normal-protected-codex-workspace",
      generationSha256: f.host.generationSha256,
      state: "reserved",
    });
    const installed = await f.release.observe(f.context, wiring);
    assert.ok(installed);
    assert.equal(installed.sandboxId, "box-execution");
    assert.deepEqual(installed.enforcement.repositoryGitRecipient, {
      providerId: `${id}-box-egress`,
      attachmentEpoch: "box-execution",
      processInstanceId: f.host.processInstanceId,
      networkInstanceId: `box-source-sha256:${f.host.bearerSha256}`,
      authorization: "online-request",
      deliveryProfile: "github_repository",
    });
    assert.equal(installed.enforcement.peerKeyId, undefined);

    // An installation that is not the host's current one is refused before any release.
    const tampered = structuredClone(installed);
    (
      tampered.enforcement.repositoryGitRecipient as { processInstanceId: string }
    ).processInstanceId = `${f.host.processInstanceId.split(":")[0]}:2:1`;
    await assert.rejects(
      f.sandbox.enrollHarness!(f.harness, tampered, async () => {
        throw new Error("release must not be requested");
      }),
      /not the host's current held Box execution/,
    );
    assert.equal(f.host.releases.length, 0);

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
    assert.equal(f.host.releases.length, 1);
    assert.ok(f.host.startup);
    assert.deepEqual((await endpoint(withdrawal))?.original, {
      purpose: "normal-protected-codex-workspace",
      generationSha256: f.host.generationSha256,
      state: "release-acknowledged",
      startupSha256: f.host.startup.startupSha256,
    });
    // A repeated pass after the release acknowledges it without a second release.
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
    assert.equal(f.host.releases.length, 1);

    // A replaced `box run` (new bearer) no longer verifies as the committed installation.
    const committed = f.committed();
    assert.ok(committed);
    assert.equal(await f.release.verify(f.context, committed), true);
    const previous = f.host.bearerSha256;
    f.host.bearerSha256 = sha("replacement");
    assert.equal(await f.release.verify(f.context, committed), false);
    f.host.bearerSha256 = previous;
    const access = f.sandbox.repositoryAccess!;
    const verified = await access.verifyExecution({
      revision: f.revision,
      signal,
    } as never);
    assert.equal(verified?.executionId, f.plan.execution.executionId);
  },
);

// The Git steps of the Stage B end-to-end case run here, everywhere; the stock gh
// steps need a host input CI does not stage and run in strands-box-protected-gh.test.ts.
test(
  "Box asks OCE for every request: stock git pushes with one decision per request, renewal needs no restart, OCE refuses the wrong repository and, after withdrawal, the next request before any provider connection",
  { timeout: 90_000 },
  async (t) => {
    await stageBEndToEnd(t, undefined);
  },
);
