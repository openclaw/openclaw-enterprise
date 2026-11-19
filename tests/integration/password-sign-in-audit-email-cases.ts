import assert from "node:assert/strict";
import test from "node:test";
import {
  issueKnownDevice,
  knownDeviceCookieName,
} from "../../apps/controller/src/auth/known-device.ts";
import {
  baseURL,
  controller,
  createControllerAuth,
  email,
  errorOf,
  guardedController,
  memoryAdapter,
  password,
  secret,
  signIn,
} from "./password-sign-in-audit-fixture.ts";
import type { AdapterFactory, Database, Outcome, Sent } from "./password-sign-in-audit-fixture.ts";

// A Better Auth store that, like PostgreSQL text, cannot look up a NUL character.
function nulRefusingDatabase(memoryDatabase: Database): AdapterFactory {
  return (options) => {
    const adapter = memoryAdapter(memoryDatabase)(options);
    return {
      ...adapter,
      async findOne(query) {
        if (JSON.stringify(query.where ?? []).includes("\\u0000")) {
          throw new Error("invalid byte sequence for encoding UTF8: 0x00");
        }
        return adapter.findOne(query);
      },
    };
  };
}

const unstorableEmails: [string, string][] = [
  ["nul\u0000@example.test", "a NUL character"],
  ["surrogate\ud800@example.test", "an unpaired UTF-16 surrogate"],
];

function assertUnstorableEmail(response: Sent, problem: string) {
  assert.equal(response.status, 400, JSON.stringify(response.payload));
  assert.deepEqual(errorOf(response), {
    code: "INVALID_REQUEST",
    message: `The request does not match the operation contract: body /email contains ${problem}.`,
  });
}

export function registerPasswordSignInEmailCases(): void {
  test("an email no account can hold is a 400 that spends the password budget", async () => {
    const outcomes: Outcome[] = [];
    const reads: string[] = [];
    const memoryDatabase = { user: [], session: [], account: [], verification: [], apikey: [] };
    const auth = createControllerAuth({
      mode: "development",
      installationId: "ins_sign_in_audit_unstorable",
      baseURL,
      agentDomain: "agents.oce.localhost",
      secret,
      database: nulRefusingDatabase(memoryDatabase),
      passwordSignInAudit: {
        accepted: async (userId) => {
          outcomes.push(["accepted", userId]);
        },
        refused: async () => {
          outcomes.push(["refused"]);
        },
      },
      knownDeviceState: async (address) => {
        reads.push(address);
        return undefined;
      },
      // Every Installation administrator's email is reserved, so a spent email takes the
      // slow lane, which looks the email up.
      passwordAdministrator: async () => true,
      passwordSlowLaneFloors: { floorMs: 1, maxFloorMs: 1 },
    });
    for (const [address, problem] of unstorableEmails) {
      outcomes.length = 0;
      // Refused like the bad-credential answer it replaces: audited, and counted.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        assertUnstorableEmail(
          await signIn(auth, { email: address, password: "wrong-password-guess" }),
          problem,
        );
      }
      assert.equal(outcomes.length, 10);
      assert.deepEqual(new Set(outcomes.flat()), new Set(["refused"]));
      // The spent email is refused, not looked up (PostgreSQL would answer 503).
      const limited = await signIn(auth, { email: address, password: "wrong-password-guess" });
      assert.equal(limited.status, 429, JSON.stringify(limited.payload));
      assert.equal(outcomes.length, 10);
    }
    assert.deepEqual(reads, [], "no account state is read for an email no account can hold");

    // The password is never stored as text, so it is not checked: such an account still signs in.
    const nulPassword = "account-password-\u0000-\ud800";
    const account = await auth.createAccount({ email, password: nulPassword });
    outcomes.length = 0;
    assert.equal((await signIn(auth, { email, password: nulPassword })).status, 200);
    assert.deepEqual(outcomes, [["accepted", account.id]]);
  });

  test("guarded profile: an email no account can hold is a 400 that spends the password budget", async () => {
    const snapshots: string[] = [];
    const denials: string[] = [];
    const auth = guardedController({
      installationId: "ins_sign_in_audit_guarded_unstorable",
      state: {
        // Like PostgreSQL text, which cannot hold a NUL character.
        snapshotPassword: async (address) => {
          snapshots.push(address);
          if (address.includes("\u0000")) {
            throw new Error("invalid byte sequence for encoding UTF8: 0x00");
          }
          return undefined;
        },
        recordDenied: async (reason) => {
          denials.push(reason);
        },
      },
      passwordSlowLaneFloors: { floorMs: 1, maxFloorMs: 1 },
    });
    for (const [address, problem] of unstorableEmails) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        assertUnstorableEmail(
          await signIn(auth, { email: address, password: "wrong-password-guess" }),
          problem,
        );
      }
      const limited = await signIn(auth, { email: address, password: "wrong-password-guess" });
      assert.equal(limited.status, 429, JSON.stringify(limited.payload));
    }
    assert.deepEqual(snapshots, [], "no account is read for an email no account can hold");
    // The existing guarded denial owner records every admitted invalid attempt.
    assert.equal(denials.length, 20);
    assert.deepEqual(new Set(denials), new Set(["INVALID_CREDENTIALS"]));
  });

  // A real cookie for the replacement-character spelling also matches the UTF-8 encoding
  // of the surrogate spelling. Invalid input must skip that proof read in both profiles.
  for (const profile of ["password-only", "guarded", "recovery-only"]) {
    test(`${profile}: malformed email skips known-device state and preserves denial auditing`, async () => {
      const reads: string[] = [];
      const denials: string[] = [];
      let failAudit = false;
      const recordDenied = async () => {
        denials.push("INVALID_CREDENTIALS");
        if (failAudit) {
          throw new Error("audit unavailable");
        }
      };
      const accountState = async (address: string) => {
        reads.push(address);
        return "test-password-state";
      };
      const auth =
        profile === "password-only"
          ? createControllerAuth({
              mode: "development",
              installationId: "ins_invalid_email_known_device",
              baseURL,
              agentDomain: "agents.oce.localhost",
              secret,
              database: memoryAdapter({
                user: [],
                session: [],
                account: [],
                verification: [],
                apikey: [],
              }),
              knownDeviceState: accountState,
              passwordSignInAudit: { accepted: async () => {}, refused: recordDenied },
              passwordSlowLaneFloors: { floorMs: 1, maxFloorMs: 1 },
            })
          : guardedController({
              installationId: "ins_invalid_email_known_device",
              state: {
                snapshotPassword: async (address) => {
                  reads.push(address);
                  return undefined;
                },
                knownDeviceState: accountState,
                recordDenied,
              },
              ...(profile === "recovery-only" ? { passwordSignIn: "recovery-only" as const } : {}),
              passwordSlowLaneFloors: { floorMs: 1, maxFloorMs: 1 },
            });
      const malformed = "cookie-\ud800@example.test";
      const cookie = issueKnownDevice(
        secret,
        "cookie-\ufffd@example.test",
        "test-password-state",
        Date.now(),
      );
      const headers = { cookie: `${knownDeviceCookieName(true)}=${cookie}` };
      assertUnstorableEmail(
        await signIn(auth, { email: malformed, password }, headers),
        "an unpaired UTF-16 surrogate",
      );
      assert.deepEqual(
        reads,
        [],
        "malformed email must not reach known-device or credential State",
      );
      assert.equal(denials.length, 1);
      failAudit = true;
      for (let attempt = 1; attempt < 10; attempt += 1) {
        const failed = await signIn(auth, { email: malformed, password }, headers);
        assert.equal(failed.status, 503);
        assert.equal(failed.headers["set-cookie"], undefined);
      }
      assert.equal(denials.length, 10);
      assert.equal((await signIn(auth, { email: malformed, password }, headers)).status, 429);
      assert.equal(denials.length, 10, "exhausted admission does not repeat the denial audit");
      assert.deepEqual(reads, []);
    });
  }

  // Preserve the dependency's existing email contract; the password itself is supported.
  test("password-only distinguishes unsupported stored email from an unusual password", async () => {
    const outcomes: Outcome[] = [];
    const { auth, memoryDatabase } = controller({
      accepted: async (id) => {
        outcomes.push(["accepted", id]);
      },
      refused: async () => {
        outcomes.push(["refused"]);
      },
    });
    const unusualPassword = "account-password-\u0000-\ud800-\ufffd";
    const ordinary = await auth.createAccount({
      email: "ordinary-unusual@example.test",
      password: unusualPassword,
    });
    await auth.createAccount({ email: "stored-\ufffd@example.test", password: unusualPassword });
    assert.equal(
      (await signIn(auth, { email: ordinary.email, password: unusualPassword })).status,
      200,
    );
    const sessions = memoryDatabase.session.length;
    const refused = await signIn(auth, {
      email: "stored-\ufffd@example.test",
      password: unusualPassword,
    });
    assert.equal(refused.status, 400);
    assert.equal(errorOf(refused).code, "FORBIDDEN");
    assert.equal(refused.headers["set-cookie"], undefined);
    assert.equal(
      memoryDatabase.session.length,
      sessions,
      "unsupported stored email issues no session",
    );
    assert.deepEqual(outcomes, [["accepted", ordinary.id], ["refused"]]);
  });

  for (const passwordSignIn of ["all", "recovery-only"] as const) {
    test(`guarded ${passwordSignIn}: literal replacement email reaches normal credential checks`, async () => {
      const reads: string[] = [];
      const denials: string[] = [];
      const literalEmail = "stored-\ufffd@example.test";
      const auth = guardedController({
        installationId: "ins_literal_email_guarded",
        state: {
          snapshotPassword: async (address) => {
            reads.push(address);
            return undefined;
          },
          recordDenied: async (reason) => {
            denials.push(reason);
          },
        },
        ...(passwordSignIn === "recovery-only" ? { passwordSignIn } : {}),
      });
      const refused = await signIn(auth, {
        email: literalEmail,
        password: "account-password-\u0000-\ud800-\ufffd",
      });
      // Missing-account State is a denial, not fabricated successful authentication.
      assert.equal(refused.status, 401);
      assert.equal(refused.headers["set-cookie"], undefined);
      assert.deepEqual(reads, [literalEmail]);
      assert.deepEqual(denials, ["INVALID_CREDENTIALS"]);
    });
  }
}
