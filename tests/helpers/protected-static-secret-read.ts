import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { Secret, SecretDriver, SecretIdentity } from "@openclaw-enterprise/contracts";

/** Run inside a test with a finite timeout; Node owns cancellation and cleanup. */
export async function assertProtectedStaticSecretRead(
  t: TestContext,
  driver: SecretDriver,
  identity: SecretIdentity,
  isIdentityRefusal: (error: unknown) => boolean,
  readBudgetMs = 1_000,
): Promise<void> {
  assert.ok(driver.readCredentialInput, "Protected static reads require readCredentialInput.");
  assert.ok(
    Number.isSafeInteger(readBudgetMs) && readBudgetMs > 0 && readBudgetMs <= 2_147_483_647,
  );
  const read = driver.readCredentialInput.bind(driver);
  const call = async <T>(operation: string, action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch {
      assert.fail(`${operation} failed.`);
    }
  };
  const backendRef = await call("Create", () => driver.create(identity, "synthetic-initial"));
  const secret: Secret = {
    ...identity,
    driverId: driver.id,
    backendRef,
    createdAt: new Date().toISOString(),
  };
  t.after(() => call("Cleanup", () => driver.delete(secret)));
  const deadline = Date.now() + readBudgetMs;
  const signal = AbortSignal.any([t.signal, AbortSignal.timeout(readBudgetMs)]);
  const lifetime = { signal, deadlineAt: new Date(deadline).toISOString() };
  const active = () => assert.ok(!signal.aborted && Date.now() < deadline, "Read lifetime ended.");
  const check = async (expected: string) => {
    const result = await call("Read", () => read({ secret, retention: "none", lifetime }));
    active();
    assert.ok(result?.value === expected, "Unexpected synthetic material.");
    assert.ok(
      typeof result.version === "string" && result.version.trim().length > 0,
      "Missing version.",
    );
    assert.ok(
      typeof result.authoritativeObservedAt === "string" &&
        Number.isFinite(Date.parse(result.authoritativeObservedAt)),
      "Invalid observation time.",
    );
    assert.ok(
      result.expiresAt === undefined ||
        (typeof result.expiresAt === "string" && Number.isFinite(Date.parse(result.expiresAt))),
      "Invalid expiry time.",
    );
    return result.version;
  };
  const initial = await check("synthetic-initial");
  await call("Rotate", () => driver.update(secret, "synthetic-rotated"));
  assert.ok(initial !== (await check("synthetic-rotated")), "Rotation did not change the version.");
  const uid =
    backendRef.uid === "00000000-0000-4000-8000-000000000001"
      ? "00000000-0000-4000-8000-000000000002"
      : "00000000-0000-4000-8000-000000000001";
  try {
    await call("Foreign UID read", async () => {
      let refused = false;
      try {
        await read({
          secret: { ...secret, backendRef: { ...backendRef, uid } },
          retention: "none",
          lifetime,
        });
      } catch (error) {
        active();
        refused = isIdentityRefusal(error);
      }
      active();
      assert.ok(refused, "Foreign UID was not refused.");
    });
  } finally {
    // A cancelled test cannot prove recovery; Node still runs the registered cleanup.
    if (!t.signal.aborted) {
      await check("synthetic-rotated");
    }
  }
}
