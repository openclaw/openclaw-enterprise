import assert from "node:assert/strict";
import {
  UnixRepositoryCredentialControlClient,
  type RepositoryCredentialControlClient,
} from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import type {
  Agent,
  AgentRevision,
  RepositoryRevisionState,
} from "../../packages/contracts/src/index.ts";
import type {
  DroppedAdmission,
  startControlResponseRelay,
} from "../fixtures/repository-credentials/control-relay.ts";
import type { RevisionFixture } from "../helpers/postgres-worker-refused-candidate.ts";
import { repositoryAttempts } from "../helpers/postgres-worker-revision-support.mjs";
import { waitFor } from "../helpers/wait-for.ts";

type CapabilityFixture = Pick<RevisionFixture, "revision" | "requestStop" | "state" | "work">;

interface BrokerCapabilityScenario {
  fixture: CapabilityFixture;
  owner: Agent;
  selection: RepositoryRevisionState;
  incompatible: Awaited<ReturnType<CapabilityFixture["revision"]>>;
  relay: Awaited<ReturnType<typeof startControlResponseRelay>>;
  brokerSocket: string;
  isReady: () => boolean;
  hasIssuedProviderToken: () => boolean;
}

async function assertDisposedSession(
  fixture: Pick<CapabilityFixture, "state">,
  revision: AgentRevision,
  { admissionId, sessionId }: DroppedAdmission,
  broker: Pick<RepositoryCredentialControlClient, "status">,
) {
  const attempts = await waitFor(
    "the observed repository session to be disposed in PostgreSQL",
    async () => {
      const rows = await repositoryAttempts(fixture, revision);
      return rows.some((row) => row.admissionId === admissionId && row.phase === "disposed")
        ? rows
        : undefined;
    },
  );
  assert.deepEqual(
    attempts.map((attempt) => ({
      admissionId: attempt.admissionId,
      sessionId: attempt.sessionId,
      phase: attempt.phase,
    })),
    [{ admissionId, sessionId, phase: "disposed" }],
  );
  const receipt = await fixture.state.read((view) =>
    view.repositorySessions.findBrokerReceipt(admissionId),
  );
  assert.equal(receipt?.state, "disposed");
  assert.equal(receipt.sessionId, sessionId);
  const status = await broker.status(sessionId, AbortSignal.timeout(5_000));
  assert.equal(status?.state, "DISPOSED");
}

export async function verifyBrokerCapability({
  fixture,
  owner,
  selection,
  incompatible,
  relay,
  brokerSocket,
  isReady,
  hasIssuedProviderToken,
}: BrokerCapabilityScenario): Promise<void> {
  const broker = new UnixRepositoryCredentialControlClient({ controlSocket: brokerSocket });

  // Four jittered retry delays can total nearly 15 seconds before the fifth claim.
  const rejected = await fixture.work(incompatible, "failed_permanent", 20_000);
  assert.equal(rejected.attempt_count, 5);
  assert.equal(isReady(), false);
  assert.deepEqual(await repositoryAttempts(fixture, incompatible), []);
  assert.equal(hasIssuedProviderToken(), false);

  relay.setCapabilitiesHidden(false);
  await waitFor("worker readiness after compatible broker selection", () =>
    isReady() ? true : undefined,
  );
  const observeDrop = relay.dropNextAdmissionResponse();
  const uncertain = await fixture.revision(owner, 2, { repositoryCredentials: selection });
  const lost = await waitFor("a completed broker 201 to be dropped before forwarding", observeDrop);
  const exhausted = await fixture.work(uncertain, "failed_permanent", 20_000);
  assert.equal(exhausted.attempt_count, 5);
  await assertDisposedSession(fixture, uncertain, lost, broker);

  // Recovery settled the lost admission with capability hidden. Fresh material
  // requires restoring capability and explicitly admitting another revision.
  relay.setCapabilitiesHidden(false);
  const compatible = await fixture.revision(owner, 3, { repositoryCredentials: selection });
  await fixture.work(compatible, "succeeded");
  const [open, ...others] = await repositoryAttempts(fixture, compatible);
  assert.equal(others.length, 0);
  assert.equal(open?.phase, "open");
  const { admissionId, sessionId } = open;
  assert.ok(sessionId, "the successful revision must own a broker session");

  // Losing capability again must still permit Stop to dispose of that session.
  relay.setCapabilitiesHidden(true);
  const stop = await fixture.requestStop(owner);
  await fixture.work(stop, "succeeded");
  await assertDisposedSession(fixture, compatible, { admissionId, sessionId }, broker);
}
