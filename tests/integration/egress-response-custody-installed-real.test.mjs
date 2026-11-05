import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";
import test from "node:test";
import {
  repository,
  startCustodyRepositoryOrigin,
} from "../fixtures/egress-custody-repository-origin.mjs";
import {
  arrangeRealPrerequisites,
  createRunEvidence,
  observePreparedStack,
} from "../helpers/egress-installed-stack.mjs";
import { verifyCredentialFreeReadAndWithdrawal } from "../helpers/egress-credential-free-installed.mjs";
import { verifyLiveRecipients } from "../helpers/egress-custody-live-recipients.mjs";
import { registerCleanupAndStartProvider } from "../helpers/egress-installed-agent.mjs";
import {
  admitRepositoryAgent,
  activateRepositoryAgent,
  restartDedicatedAuthority,
} from "../helpers/egress-custody-installed-agent.mjs";
import {
  agentClients,
  assertIdentityResponse,
  faultObserver,
  receipts,
  refusal,
  tryDirectTcp,
} from "../helpers/egress-custody-observations.mjs";

const selected = process.env.OCC_TEST_EGRESS_CUSTODY_INSTALLED === "1";
test(
  "installed protected repository read binds execution, exact dispatch and final response",
  {
    skip: selected ? false : "Dedicated installed-custody lane requires a fresh disposable pair.",
    timeout: 74 * 60_000,
  },
  async (t) => {
    const progress = { stage: "input-preflight" };
    // Assertions/subprocess errors may carry provider or proof bytes. Only disclose a
    // source location and durable phase. Abort after a failed child; do not replay it.
    const safeError = (error) => {
      const at = error.stack?.match(/egress-[\w.-]+\.mjs:\d+:\d+/)?.[0] ?? "external-operation";
      return Error(
        "Installed custody failed at " +
          progress.stage +
          " (" +
          at +
          "); inspect private phase ledger",
      );
    };
    const stage = async (name, fn) => {
      let failure;
      await t.test(name, async () => {
        progress.stage = name;
        try {
          await fn();
        } catch (error) {
          failure = safeError(error);
          throw failure;
        }
      });
      if (failure) {
        throw failure;
      }
    };
    try {
      const socket = process.env.OCC_TEST_EGRESS_DISPATCH_OBSERVER_SOCKET;
      assert.ok(isAbsolute(socket));
      const fault = (cmd) => faultObserver(socket, cmd);
      assert.deepEqual(
        await fault(),
        { authorizations: 0, observed: false, armed: false },
        "fresh dedicated dispatch observer",
      );
      const setup = await arrangeRealPrerequisites(
        t,
        progress,
        process.env.OCC_TEST_EGRESS_CONNECTED_INPUTS,
        { wholeExecution: true },
      );
      assert.equal(
        execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        setup.input.oceCommit,
      );
      const evidence = await createRunEvidence(t, setup, progress);
      const stack = await observePreparedStack(t, setup, evidence, progress);
      const owned = await registerCleanupAndStartProvider(
        t,
        setup,
        stack,
        evidence,
        startCustodyRepositoryOrigin,
      );
      const { provider } = owned;
      const admitted = await admitRepositoryAgent(setup, stack, evidence, owned);
      const activate = () => activateRepositoryAgent(setup, stack, evidence, owned, admitted);
      const installed = await activate();
      const clientFor = (recipient) => agentClients(recipient, provider.businessOrigin);
      const { curl, node, inAgent } = clientFor(installed);
      const { custodyTransitions: custody } = installed;
      const rows = (i = installed) => receipts(stack.pool, i.installation);
      const { checkpoint } = evidence;

      const exchange = async (client, expected, getResponse) => {
        const before = await custody.snapshot();
        const origin = provider.observations.length;
        const prior = await rows();
        const raw = await client();
        getResponse(raw);
        const id = await custody.expectAfter(before, expected);
        const fresh = (await rows()).filter((row) => !prior.some((old) => old.id === row.id));
        assert.equal(fresh.length, 1, "one dispatch authorization for exactly this request");
        const [receipt] = fresh;
        assert.equal(receipt.id, id);
        assert.equal(
          receipt.exact,
          true,
          "receipt binds exact execution, installed peer, unique response custody and material family",
        );
        return { id, receipt, sends: provider.observations.slice(origin) };
      };
      const accepted = ["resolve_accepted", "permit_accepted", "response_released"];
      const verifyRead = async (client) => {
        const { id, receipt, sends } = await exchange(
          client,
          accepted,
          client === curl
            ? assertIdentityResponse
            : (raw) => {
                const result = JSON.parse(raw);
                assert.equal(result.status, 200);
                assert.ok(
                  result.body === JSON.stringify(repository),
                  "sibling receives exactly the approved repository identity",
                );
              },
        );
        assert.equal(sends.length, 1);
        assert.ok(sends[0].exactRead && sends[0].finished);
        assert.equal(receipt.observation.kind, "response");
        return id;
      };
      await stage(
        "two ordinary clients in the admitted execution receive only the selected repository identity",
        async () => {
          const first = await verifyRead(curl);
          const sibling = await verifyRead(node);
          assert.notEqual(first, sibling);
          assert.equal(
            (await fault()).authorizations,
            2,
            "positive control: target observer sees both actual installed dispatches",
          );
          await checkpoint("two-client-custody", {
            clientOperations: [first, sibling],
            authenticatedOriginReads: 2,
          });
        },
      );

      await stage(
        "unmanaged direct TCP cannot reach the independently observed permitted target",
        async () => {
          const observed = await tryDirectTcp(provider, setup.input.provider, inAgent);
          await checkpoint("direct-bypass", observed);
        },
      );

      await stage(
        "a forbidden final actual trailer reaches origin once and releases zero provider bytes",
        async () => {
          const preparse = provider.wireRequests;
          const throughFin = clientFor(installed).throughFin;
          const positive = await exchange(throughFin, accepted, assertIdentityResponse);
          assert.equal(positive.sends.length, 1);
          assert.ok(positive.sends[0].finished && positive.sends[0].exactRead);
          assert.equal(positive.sends[0].actualLastTrailer, null);
          provider.forbiddenFinal();
          const expected = ["resolve_accepted", "permit_accepted", "response_blocked"];
          const { id, receipt, sends } = await exchange(throughFin, expected, (raw) =>
            assert.ok(raw === refusal, "complete fixed local error only"),
          );
          assert.equal(sends.length, 1, "one origin send, no retries");
          assert.ok(
            sends[0].exactRead &&
              sends[0].finished &&
              sends[0].actualLastTrailer === "x-fixture-forbidden-last",
            "origin flushed body, then forbidden final trailer on the actual TLS socket",
          );
          assert.deepEqual(receipt.observation, {
            kind: "response_blocked",
            dispatch: "confirmed",
            code: "response_policy",
          });
          assert.equal(provider.wireRequests, preparse + 2, "one pre-parse request for each arm");
          await checkpoint("forbidden-final-actual-trailer", {
            requestId: id,
            positiveRequestId: positive.id,
            authenticatedOriginReadsPerArm: 1,
            providerBytesAtClient: 0,
          });
        },
      );

      await stage(
        "loss of the exact authorized dispatch COMMIT acknowledgement and authority restart produce no send",
        async () => {
          const instanceId = installed.installation.enforcement.instanceId;
          const preparse = provider.wireRequests;
          assert.equal((await fault("drop " + instanceId)).armed, true);
          const { id, receipt, sends } = await exchange(
            curl,
            ["resolve_accepted", "no_permit", "response_blocked"],
            (raw) => assert.ok(raw === refusal),
          );
          const proof = await fault();
          assert.deepEqual(proof.dropped, { instanceId, useId: id, attemptId: id });
          assert.equal(
            proof.observed,
            true,
            "real server COMMIT acknowledgement consumed, not an arbitrary disconnect",
          );
          assert.deepEqual(sends, []);
          assert.equal(
            provider.wireRequests,
            preparse,
            "no request reached the origin before parsing",
          );
          assert.deepEqual(receipt.outcome, { kind: "uncertain", dispatch: "possible" });
          assert.equal(receipt.observation, null);
          assert.equal(receipt.settled, false);
          const before = provider.observations.length;
          const original = await rows();
          const transitions = await custody.snapshot();
          await checkpoint("exact-dispatch-commit-ack-consumed", {
            requestId: id,
            supplierNoPermit: 1,
            originReads: 0,
          });
          const restarted = await restartDedicatedAuthority(setup);
          assert.deepEqual(
            await rows(),
            original,
            "restart preserves uncertain dispatch, no repair/replay",
          );
          assert.deepEqual(await custody.snapshot(), transitions);
          assert.equal(
            provider.wireRequests,
            preparse,
            "no request reached the origin across restart",
          );
          // A new operation after restart bounds the no-retry observation and proves the
          // actual transport recovered. Never submit the uncertain operation a second time.
          assert.notEqual(await verifyRead(curl), id);
          assert.equal(
            provider.wireRequests,
            preparse + 1,
            "only the fresh control reached the origin",
          );
          assert.equal(
            provider.observations.length,
            before + 1,
            "post-restart positive control only, no replay of uncertain dispatch",
          );
          assert.deepEqual(
            (await rows()).find((r) => r.id === id),
            receipt,
          );
          await checkpoint("authority-restarted-uncertain-preserved", {
            ...restarted,
            requestId: id,
            oldPermits: 0,
            oldOriginReads: 0,
            newControlReads: 1,
          });
        },
      );

      await stage(
        "two simultaneously authorized installed executions receive only their own interleaved replies",
        () =>
          verifyLiveRecipients({
            setup,
            stack,
            evidence,
            owned,
            installed,
            clientFor,
            rows,
          }),
      );

      await stage(
        "a replacement execution cannot inherit the old pending request or receive its late response",
        async () => {
          await verifyReplacement({
            activate,
            admitted,
            checkpoint,
            clientFor,
            curl,
            evidence,
            installed,
            owned,
            rows,
            setup,
            stack,
          });
        },
      );
      await stage(
        "explicit protected credential-free read, removal of authority and final route withdrawal",
        () => verifyCredentialFreeReadAndWithdrawal({ setup, stack, evidence, owned, admitted }),
      );
      await checkpoint("installed-custody-observations-complete", { requiredObservations: 7 });
    } catch (error) {
      throw safeError(error);
    }
  },
);

async function verifyReplacement({
  activate,
  admitted,
  checkpoint,
  clientFor,
  curl,
  evidence,
  installed,
  owned,
  rows,
  setup,
  stack,
}) {
  const { provider } = owned;
  const held = provider.holdNext();
  const count = provider.observations.length;
  const { custodyTransitions: custody } = installed;
  const baseline = await custody.snapshot();
  const preparse = provider.wireRequests;
  const start = Date.now();
  // Keep the *real* provider response unresolved across replacement. A transport
  // closing during rollout is safe; it must never be reassociated with the new sink.
  const original = curl().then(
    (raw) => {
      assert.ok(
        raw === refusal,
        "old sink may only observe the fixed refusal while its response is still withheld",
      );
      return "complete-local-refusal";
    },
    () => "old-client-transport-closed",
  );
  await held.arrived;
  const [atOrigin] = provider.observations.slice(count);
  assert.ok(
    atOrigin?.exactRead && !atOrigin.finished,
    "old authorized read actually pending at provider",
  );
  const old = await custody.expectAfter(baseline, ["resolve_accepted", "permit_accepted"]);
  assert.ok((await rows()).some((r) => r.id === old && r.exact && !r.observation));
  await checkpoint("old-response-suspended-at-origin", { requestId: old, originReads: 1 });

  const replacement = await activate();
  assert.notEqual(installed.installation.sandboxId, replacement.installation.sandboxId);
  assert.notEqual(installed.harness.metadata.uid, replacement.harness.metadata.uid);
  assert.notEqual(installed.supervisor.metadata.uid, replacement.supervisor.metadata.uid);
  assert.notEqual(
    installed.installation.enforcement.instanceId,
    replacement.installation.enforcement.instanceId,
  );
  const pods = await setup.f.resources("pods", stack.placement);
  assert.ok(
    !pods.some((p) => p.metadata.uid === installed.harness.metadata.uid),
    "old workload gone, not merely another sibling",
  );
  const oldClient = await original;
  // B stays authorized *through A's late release*. B's own accepted, pending read will
  // have a single forbidden trailer. If A's valid late response is delivered to B, the
  // exact refusal through FIN below fails. A's destroyed sink need not receive anything.
  const { custodyTransitions: replacementCustody } = replacement;
  const beforeB = await replacementCustody.snapshot();
  const gateB = provider.holdNext("forbidden-final");
  const { throughFin } = clientFor(replacement);
  const pendingB = throughFin();
  const atB = await Promise.race([
    gateB.arrived,
    pendingB.then(() => assert.fail("B ended before origin hold")),
  ]);
  assert.ok(atB.exactRead && !atB.finished && !atOrigin.finished);
  const authorized = ["resolve_accepted", "permit_accepted"];
  const crossed = await replacementCustody.expectAfter(beforeB, authorized);
  const pendingReceipt = (await rows(replacement)).find((r) => r.id === crossed);
  assert.ok(
    pendingReceipt?.exact && pendingReceipt.observation === null,
    "B accepted with a real pending dispatch",
  );

  const oldOriginRelease = await held.release();
  assert.equal(atB.finished, false, "authorized B pending through the old origin release");
  await gateB.release();
  assert.ok(
    (await pendingB) === refusal,
    "authorized B sees only local refusal through FIN, never A's late bytes",
  );
  assert.equal(
    await replacementCustody.expectAfter(beforeB, [...authorized, "response_blocked"]),
    crossed,
  );
  const blocked = (await rows(replacement)).find((r) => r.id === crossed);
  assert.ok(atB.finished && blocked?.exact && blocked.observation?.code === "response_policy");

  const priorB = await replacementCustody.snapshot();
  assertIdentityResponse(await throughFin());
  const own = await replacementCustody.expectAfter(priorB, [...authorized, "response_released"]);
  assert.ok(own !== crossed && own !== old);
  const reads = provider.observations.slice(count);
  assert.equal(reads.length, 3);
  assert.ok(reads[2].exactRead && reads[2].finished, "fresh own B read follows A's late release");
  const ownReceipt = (await rows(replacement)).find((r) => r.id === own);
  assert.ok(ownReceipt?.exact && ownReceipt.observation?.kind === "response");
  await checkpoint("authorized-replacement-pending-through-old-release-then-fresh-success", {
    oldRequestId: old,
    oldOriginRelease,
    authorizedPendingAtB: crossed,
    oldProviderBytesAtB: 0,
    ownFreshAtB: own,
  });

  // Separately retain the IAM withdrawal control, without crediting it as a
  // copied-opening attack. The lane runs that attack at the actual TLS gRPC authority.
  await evidence.api(
    "DELETE",
    stack.namespacePath + "/iam/access-bindings/" + admitted.binding.id,
    undefined,
    204,
  );
  const first = await replacementCustody.snapshot();
  const prior = await rows(replacement);
  const raw = await throughFin();
  assert.ok(
    raw === refusal,
    "replacement client receives complete fixed local error and zero old provider bytes",
  );
  const id = await replacementCustody.expectAfter(first, [
    "resolve_refused",
    "no_permit",
    "response_blocked",
  ]);
  assert.notEqual(id, old);
  assert.equal(
    provider.observations.length,
    count + 3,
    "only old read and two authorized B controls reached origin; no inherited request or retry",
  );
  assert.equal(
    provider.wireRequests,
    preparse + 3,
    "no retry or denied request at pre-parse origin",
  );
  assert.deepEqual(
    await rows(replacement),
    prior,
    "refused before selecting material or reserving dispatch in new installation",
  );
  const denied = (
    await stack.pool.query(
      `
    SELECT outcome, details->>'phase' AS phase, details->>'code' AS code FROM occ.audit_events
    WHERE namespace_id=$1 AND actor_id=$2 AND resource_id=$3 AND action='openclaw.egress.authorize'
          AND details->>'requestId'=$4 AND details->>'revisionId'=$5`,
      [
        stack.namespace.id,
        admitted.agent.servicePrincipalId,
        admitted.source.id,
        id,
        replacement.revision.id,
      ],
    )
  ).rows;
  assert.deepEqual(
    denied,
    [{ outcome: "denied", phase: "before_access", code: "unauthorized" }],
    "affirmative OCC denial before material access for this actual replacement request",
  );
  const oldReceipt = (await rows()).find((r) => r.id === old);
  assert.ok(
    oldReceipt?.exact && oldReceipt.observation?.kind !== "response",
    "late old response not transferred",
  );
  await checkpoint("replacement-denied-before-material", {
    oldRequestId: old,
    replacementRequestId: id,
    responseHeldThroughReplacementMs: Date.now() - start,
    oldClient,
    replacementMaterialAccess: 0,
    replacementOriginReads: 0,
    replacementProviderBytes: 0,
  });
}
