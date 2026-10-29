import assert from "node:assert/strict";
import test from "node:test";
import type { PlatformStateStore, PlatformUnitOfWork } from "../../packages/occ/src/index.ts";
import { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { staticEgressFixture } from "../helpers/static-egress.mjs";

test("credential exchange consults revision history only for inactive executions", async (t) => {
  let revisionListings = 0;
  const f = await staticEgressFixture(t, {
    recordInstallation: false,
    appFactory: (context, options) =>
      createConsoleAppFixture(context, {
        ...options,
        wrapState: (state: PlatformStateStore): PlatformStateStore => ({
          read: (work) => state.read(work),
          transact: (work) =>
            state.transact((unit) =>
              work({
                ...unit,
                revisions: {
                  ...unit.revisions,
                  listRevisionMetadata: (...args) => {
                    revisionListings += 1;
                    return unit.revisions.listRevisionMetadata(...args);
                  },
                },
              }),
            ),
        }),
      }),
  });
  assert.ok("revision" in f);
  await f.controller.transact((unit: PlatformUnitOfWork) =>
    unit.credentialSources.recordEgressInstallation(f.installation),
  );

  // A newly provisioned execution can probe before the Agent activates it.
  revisionListings = 0;
  assert.ok((await f.resolve(f.capture())).ready);
  assert.equal(revisionListings, 1);

  await f.activateRevision(f.namespace.id, f.agent.id, f.revision.id);
  const successor = await f.deployAgent(f.namespace.id, f.agent.id);
  revisionListings = 0;
  assert.ok((await f.resolve(f.capture())).ready);
  assert.equal(revisionListings, 0, "the active execution needs no revision-history lookup");

  // Once its successor activates, the older installed execution must be refused.
  await f.activateRevision(f.namespace.id, f.agent.id, successor.id, f.revision.id);
  revisionListings = 0;
  assert.equal((await f.resolve(f.capture())).refused?.code, f.refusalCode("DENIED"));
  assert.equal(revisionListings, 1);
});
