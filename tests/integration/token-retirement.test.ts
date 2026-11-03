import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { retireToken } from "../../apps/controller/src/backends/token-service/retirement.ts";

test("token retirement preserves failed stages without replay or disclosing errors", async () => {
  for (const revokeFails of [false, true]) {
    for (const settlementFails of [false, true]) {
      const bytes = Uint8Array.of(1, 2, 3);
      const providerError = new Error("sensitive provider detail");
      const settlementError = new Error("sensitive settlement detail");
      const calls: string[] = [];
      const store = {
        async takeRetirement() {
          calls.push("take");
          return {
            id: "original-attempt",
            admission: {
              familyId: "family",
              issuerAuthority: "issuer",
              generation: 1,
              ownerEpoch: 1,
              inputVersion: "version",
              grant: { id: "grant", isolationId: "isolation" },
            },
            bytes,
          };
        },
        async finishRetirement(attemptId: string, revoked: boolean) {
          calls.push("settle");
          assert.equal(attemptId, "original-attempt");
          assert.equal(revoked, !revokeFails);
          assert.deepEqual(bytes, Uint8Array.of(0, 0, 0));
          if (settlementFails) {
            throw settlementError;
          }
        },
      };
      const retirement = retireToken(store, "family", async () => {
        calls.push("revoke");
        if (revokeFails) {
          throw providerError;
        }
        return true;
      });

      if (revokeFails && settlementFails) {
        await assert.rejects(retirement, (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /revocation/i);
          assert.match(error.message, /settlement/i);
          assert.doesNotMatch(
            inspect(error, { depth: null }),
            /sensitive (provider|settlement) detail/,
          );
          return true;
        });
      } else if (revokeFails || settlementFails) {
        await assert.rejects(
          retirement,
          (error: unknown) => error === (revokeFails ? providerError : settlementError),
        );
      } else {
        assert.equal(await retirement, "retired");
      }
      assert.deepEqual(calls, ["take", "revoke", "settle"]);
    }
  }
});
