import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { retireToken } from "../../apps/controller/src/backends/token-service/retirement.ts";

test("token retirement preserves failed stages without replay or disclosing errors", async () => {
  function startRetirement({
    revokeError,
    settlementError,
  }: { revokeError?: Error; settlementError?: Error } = {}) {
    const bytes = Uint8Array.of(1, 2, 3);
    const calls: string[] = [];
    let settlement: { attemptId: string; revoked: boolean; bytes: Uint8Array } | undefined;
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
        // Capture credential state at settlement, before a settlement failure can be redacted.
        settlement = { attemptId, revoked, bytes: bytes.slice() };
        if (settlementError) {
          throw settlementError;
        }
      },
    };
    const retirement = retireToken(store, "family", async () => {
      calls.push("revoke");
      if (revokeError) {
        throw revokeError;
      }
      return true;
    });
    return {
      retirement,
      assertSettled(expectedRevoked: boolean) {
        assert.deepEqual(calls, ["take", "revoke", "settle"]);
        assert.deepEqual(settlement, {
          attemptId: "original-attempt",
          revoked: expectedRevoked,
          bytes: Uint8Array.of(0, 0, 0),
        });
      },
    };
  }

  {
    const scenario = startRetirement();
    assert.equal(await scenario.retirement, "retired");
    scenario.assertSettled(true);
  }

  {
    const providerError = new Error("sensitive provider detail");
    const scenario = startRetirement({ revokeError: providerError });
    await assert.rejects(scenario.retirement, (error: unknown) => error === providerError);
    scenario.assertSettled(false);
  }

  {
    const settlementError = new Error("sensitive settlement detail");
    const scenario = startRetirement({ settlementError });
    await assert.rejects(scenario.retirement, (error: unknown) => error === settlementError);
    scenario.assertSettled(true);
  }

  {
    const scenario = startRetirement({
      revokeError: new Error("sensitive provider detail"),
      settlementError: new Error("sensitive settlement detail"),
    });
    // Both failed stages must remain visible without exposing either sensitive cause.
    await assert.rejects(scenario.retirement, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /revocation/i);
      assert.match(error.message, /settlement/i);
      assert.doesNotMatch(
        inspect(error, { depth: null }),
        /sensitive (provider|settlement) detail/,
      );
      return true;
    });
    scenario.assertSettled(false);
  }
});
