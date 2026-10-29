import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { get } from "node:https";
import { join } from "node:path";
import test from "node:test";
import { UnixRepositoryCredentialControlClient } from "../../apps/controller/src/backends/repository-credentials/control-client.ts";
import { startRepositoryReceiptServer } from "../../apps/controller/src/backends/repository-credentials/receipt-server.ts";
import { RepositoryReceiptStore } from "../../apps/controller/src/backends/repository-credentials/receipt-store.ts";
import { createSystemClock } from "../../apps/controller/src/drivers/repo/credentials/clock.ts";
import { validateServiceConfig } from "../../apps/controller/src/drivers/repo/credentials/configuration.ts";
import { startListeners } from "../../apps/controller/src/drivers/repo/credentials/server.ts";
import { createCredentialService } from "../../apps/controller/src/drivers/repo/credentials/service.ts";
import { PreparedRepositoryGitStore } from "../../apps/controller/src/drivers/repo/github/credentials/prepared-repository-git.ts";
import {
  resolveGitHubRepositoryBinding,
  validateGitHubRepositoryRegistry,
} from "../../apps/controller/src/drivers/repo/github/credentials/registry.ts";
import { createPreparedGitHubRegistryFactory } from "../../apps/controller/src/drivers/repo/github/credentials/warm-registry-factory.ts";
import { sessionAttempt } from "../conformance/repository-sessions.contract.mjs";
import { disposeBrokerSession, fixture, prepare } from "../fixtures/prepared-repository-git.mjs";
import { serviceConfigurationData } from "../fixtures/repository-credentials/builders.mjs";
import { startGitSmartHttpFixture } from "../fixtures/repository-credentials/git.mjs";
import { requiresPostgres } from "../helpers/postgres-database.mjs";

test(
  "prepared Git keeps the reserved route and rechecks a withdrawn grant before origin I/O",
  requiresPostgres,
  async (t) => {
    const f = await fixture(t);
    // Replace the fixture's seeded receipt with sessions opened over the durable control protocol.
    await disposeBrokerSession(f);
    const { binding, gh, state, revision, agent } = f;
    const namespaceId = agent.namespaceId;
    const selected = f.registry.repositories[0]!;
    const other = {
      ...selected,
      repository: "other/project",
      repositoryId: "91",
      repositoryRef: "other",
    };
    const registry = validateGitHubRepositoryRegistry({
      ...f.registry,
      repositories: [other, selected],
    });
    const competitor = resolveGitHubRepositoryBinding(registry, {
      namespaceId,
      repositoryRef: other.repositoryRef,
      profile: binding.profile,
    });
    const origin = await startGitSmartHttpFixture(t, {
      repository: selected.repository,
      tls: gh.tls,
      authorize: gh.authorize,
    });
    const controlSocket = join(f.socketPath, "..", "control.sock");
    const gatewayOrigin = "https://127.0.0.1";
    const config = validateServiceConfig(
      serviceConfigurationData({ gateway: { publicOrigin: gatewayOrigin, controlSocket } }),
    );
    const clock = createSystemClock();
    const factory = createPreparedGitHubRegistryFactory({
      registry,
      clock,
      limits: config.limits,
      gatewayOrigin,
      gitOrigin: origin.origin,
      socketPath: f.socketPath,
    });
    const service = createCredentialService({ config, clock, factory });
    const receipts = await startRepositoryReceiptServer({
      controlSocket,
      state,
      driverId: "repository-credentials",
      implementation: "github",
      backendId: registry.backendId,
    });
    let closeListener: (() => Promise<void>) | undefined;
    try {
      const server = await startListeners({
        service,
        clock,
        factory,
        tls: gh.tls,
        upstreamCa: gh.tls.ca,
        trustedUpstreamOrigins: factory.trustedUpstreamOrigins,
        config: { ...config, gateway: { ...config.gateway, listen: "127.0.0.1:0" } },
      });
      closeListener = () => server.close();
      const client = new UnixRepositoryCredentialControlClient({ controlSocket });
      const wire = {
        namespaceId,
        repositoryRef: binding.repositoryRef,
        profile: binding.profile,
        expectedBinding: binding.grant,
        durationSeconds: 3600,
        deadlineWallMs: f.deadlineWallMs,
        durableAdmission: true as const,
        preparedOnly: true as const,
      };
      const createAttempt = async () => {
        const admissionId = Date.now() + "-" + randomUUID();
        await state.transact((u) =>
          u.repositorySessions.createAttempt(
            sessionAttempt(revision, { admissionId, durationSeconds: 3600, brokerProtocol: 3 }),
          ),
        );
        return admissionId;
      };
      const receipt = (id: string) => state.read((v) => v.repositorySessions.findBrokerReceipt(id));
      const open = async (admissionId: string) => {
        const opened = await client.open(wire, admissionId, t.signal);
        assert.equal(opened.kind, "created");
        const { session, bearer } = opened.result;
        const saved = await receipt(admissionId);
        assert.equal(saved?.admissionId, admissionId);
        assert.equal(saved.state, "active");
        assert.equal(saved.sessionId, session.sessionId);
        assert.deepEqual(session.binding, binding.grant);
        assert.ok(
          await state.transact((u) =>
            u.repositorySessions.advanceAttempt({
              admissionId,
              expectedPhase: "opening",
              phase: "open",
              sessionId: session.sessionId,
              updatedAt: new Date().toISOString(),
            }),
          ),
        );
        return { sessionId: session.sessionId, bearer };
      };
      const use = t.mock.method(PreparedRepositoryGitStore.prototype, "use");
      const observations = () => ({
        ownerCalls: use.mock.callCount(),
        requests: origin.traffic().requests,
        authenticated: origin.trace.length,
      });
      const discovery = (bearer: string, repository = selected.repository) =>
        new Promise<number | undefined>((resolve, reject) => {
          const url =
            gatewayOrigin +
            ":" +
            server.address.port +
            "/" +
            repository +
            ".git/info/refs?service=git-upload-pack";
          const headers = {
            host: "127.0.0.1",
            authorization: "Basic " + Buffer.from("gateway-session:" + bearer).toString("base64"),
          };
          get(url, { ca: gh.tls.ca, headers, agent: false }, (res) => {
            res.resume();
            res.once("end", () => resolve(res.statusCode));
            res.once("error", reject);
          }).once("error", reject);
        });
      const exchange = async (
        admissionId: string,
        session: { sessionId: string; bearer: string },
        allowed: boolean,
      ) => {
        const before = observations();
        const status = await discovery(session.bearer);
        const after = observations();
        assert.equal(status, allowed ? 200 : 503);
        assert.deepEqual(after, {
          ownerCalls: before.ownerCalls + 1,
          requests: before.requests + Number(allowed),
          authenticated: before.authenticated + Number(allowed),
        });
        const [q] = use.mock.calls.at(-1)!.arguments;
        assert.equal(q.sessionId, session.sessionId);
        assert.equal(q.grantId, binding.grant.grantId);
        assert.equal(q.repositoryId, binding.grant.repositoryId);
        assert.equal(q.providerInstanceId, binding.grant.providerInstanceId);
        assert.equal(q.pushRef, selected.namespaces[0]!.pushRefAllowlist![0]);
        assert.equal(q.operation, "advertise-upload-pack");
        const result = await f.pool.query(
          "SELECT admission_id, operation FROM occ.prepared_repository_git_uses WHERE exchange_id=$1",
          [q.exchangeId],
        );
        assert.deepEqual(
          result.rows,
          allowed ? [{ admission_id: admissionId, operation: q.operation }] : [],
        );
        t.diagnostic(
          JSON.stringify({
            status,
            ownerCalls: after.ownerCalls - before.ownerCalls,
            committedUses: result.rows.length,
            originRequests: after.requests - before.requests,
            authenticatedRequests: after.authenticated - before.authenticated,
          }),
        );
      };
      const setBinding = (enabled: boolean) =>
        state.transact(async (u) => {
          const bindings = enabled
            ? [{ repositoryRef: binding.repositoryRef, profile: binding.profile }]
            : [];
          const updated = await u.agents.updateConfiguration(
            namespaceId,
            agent.id,
            agent.configurationId,
            undefined,
            undefined,
            undefined,
            undefined,
            bindings,
          );
          assert.ok(updated);
          assert.deepEqual(updated.repositoryBindings ?? [], bindings);
          assert.equal(updated.activeRevisionId, revision.id);
        });

      const first = await createAttempt();
      await assert.rejects(
        client.open(
          { ...wire, repositoryRef: other.repositoryRef, expectedBinding: competitor.grant },
          first,
          t.signal,
        ),
        { name: "RepositoryCredentialControlError" },
      );
      assert.equal(await receipt(first), undefined);
      assert.deepEqual(observations(), { ownerCalls: 0, requests: 0, authenticated: 0 });
      const control = await open(first);
      await prepare(f);
      await exchange(first, control, true);
      assert.equal(await discovery(control.bearer, other.repository), 400);
      assert.deepEqual(observations(), { ownerCalls: 1, requests: 1, authenticated: 1 });
      assert.equal((await client.close(control.sessionId, t.signal))?.state, "DISPOSED");
      for (const [expectedPhase, phase] of [
        ["open", "closing"],
        ["closing", "disposed"],
      ] as const) {
        assert.ok(
          await state.transact((u) =>
            u.repositorySessions.advanceAttempt({
              admissionId: first,
              expectedPhase,
              phase,
              updatedAt: new Date().toISOString(),
            }),
          ),
        );
      }

      const second = await createAttempt();
      const reserve = RepositoryReceiptStore.prototype.admission;
      let reservedGeneration: string | undefined;
      t.mock.method(
        RepositoryReceiptStore.prototype,
        "admission",
        async function (this: RepositoryReceiptStore, ...args: Parameters<typeof reserve>) {
          const result = await reserve.apply(this, args);
          if (args[0] === second && result.kind === "reserved") {
            const reserved = await receipt(second);
            assert.equal(reserved?.state, "reserved");
            assert.equal(reserved.generation, args[2]);
            reservedGeneration = reserved.generation;
            // The original OPEN is still waiting on this committed reservation's Unix reply.
            await setBinding(false);
          }
          return result;
        },
      );
      const withdrawn = await open(second);
      assert.notEqual(withdrawn.sessionId, control.sessionId);
      assert.ok(reservedGeneration);
      assert.equal((await receipt(second))?.generation, reservedGeneration);
      assert.deepEqual(observations(), { ownerCalls: 1, requests: 1, authenticated: 1 });
      await exchange(second, withdrawn, false);

      // The same session can send once its binding is restored and its material prepared.
      // Withdraw it again with that exact token still warm to distinguish withdrawal from a cold miss.
      await setBinding(true);
      await f.owner.maintain();
      await f.owner.maintain();
      await exchange(second, withdrawn, true);
      await setBinding(false);
      await exchange(second, withdrawn, false);
      assert.equal((await receipt(second))?.sessionId, withdrawn.sessionId);
      assert.equal((await client.close(withdrawn.sessionId, t.signal))?.state, "DISPOSED");
    } finally {
      try {
        await service.shutdown(1000);
      } finally {
        try {
          await closeListener?.();
        } finally {
          await receipts.close();
        }
      }
    }
  },
);
