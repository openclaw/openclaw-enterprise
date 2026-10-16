import assert from "node:assert/strict";
import { createPreparedStore } from "../fixtures/repository-credentials/github/prepared-store.mjs";
import {
  fixtureRepository,
  fixtureRepositoryId,
  fixtureInstallationId,
  fixtureAppId,
} from "../fixtures/repository-credentials/github.mjs";
import {
  createGitHubPreparationOwner,
  preparationIssuerAuthority,
  createGitHubWarmReader,
  createGitHubKeyOwner,
} from "../../apps/controller/src/drivers/repo/github/credentials/index.ts";

/** Actual scoped preparation owner and warm-only reader; this fixture's preparation store is in memory.
 * Both installed senders use the same signed selection, current-material check and controlled issuance.
 */
export function preparedMetadataFixture(
  t,
  {
    gh,
    clock,
    loadIssuer = (secret) => {
      assert.equal(secret.name, "provider-key");
      return gh.privateKey;
    },
  },
) {
  let key;
  t.after(() => key?.close());
  let reads = 0;
  let sendChecks = 0;
  let store;
  let admission;
  let reader;
  let owner;
  const config = {
    app_id: fixtureAppId,
    installation_id: fixtureInstallationId,
    repository_id: fixtureRepositoryId,
    repository: fixtureRepository,
  };
  return {
    config,
    get reads() {
      return reads;
    },
    get sendChecks() {
      return sendChecks;
    },
    get configured() {
      return !!owner;
    },
    prepare: () =>
      owner.run("managed-prepare-1", {
        signal: AbortSignal.timeout(20000),
        deadlineMonoMs: clock.monotonicNow() + 20000,
      }),
    disable: () =>
      store.transact(admission.familyId, (row) => {
        row.enabled = false;
      }),
    preparedGitHub: {
      apiOrigin: gh.origin,
      async configure(source, secret) {
        const privateKey = await loadIssuer(secret);
        key = createGitHubKeyOwner({ appId: fixtureAppId, clock, privateKey });
        const { grant } = source;
        const { id, generation } = source.key.source;
        admission = {
          familyId: id,
          issuerAuthority: preparationIssuerAuthority(gh.origin, gh.tls.ca),
          generation,
          ownerEpoch: 1,
          inputVersion: "fixture-key-1",
          grant: { ...grant, id },
        };
        store = createPreparedStore(admission).connect();
        reader = createGitHubWarmReader(store, clock.wallNow);
        owner = createGitHubPreparationOwner({
          admission,
          store,
          clock,
          getKey: async () => key,
          apiOrigin: gh.origin,
          ca: gh.tls.ca,
          renewBeforeMs: 120000,
          minimumValidityMs: 10000,
        });
      },
      async readWarm(source, { signal, deadlineAt }) {
        signal.throwIfAborted();
        assert.ok(Date.parse(deadlineAt) > clock.wallNow());
        reads++;
        assert.equal(source.origin, gh.origin);
        const result = await reader.readWarm(admission);
        if (result.kind !== "warm") {
          return undefined;
        }
        const { materialVersion, providerExpiresAt, usableUntil, bytes, attemptId } =
          result.material;
        try {
          return {
            value: Buffer.from(bytes).toString(),
            materialVersion,
            providerExpiresAt: new Date(providerExpiresAt).toISOString(),
            usableUntil: new Date(usableUntil).toISOString(),
            materialId: admission.familyId,
            family: source.key.source,
            preparationAttemptId: attemptId,
            ownerEpoch: 1,
            inputVersion: admission.inputVersion,
          };
        } finally {
          bytes.fill(0);
        }
      },
      async current(_source, evidence) {
        sendChecks++;
        return store.readCurrent(
          admission.familyId,
          (row) =>
            row?.enabled === true &&
            row.committed.materialVersion === evidence.materialVersion &&
            row.committed.attemptId === evidence.preparationAttemptId,
        );
      },
    },
  };
}
