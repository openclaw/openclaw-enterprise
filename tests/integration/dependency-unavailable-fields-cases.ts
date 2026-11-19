import assert from "node:assert/strict";
import test from "node:test";

import { dependencyUnavailableLogFields } from "../../apps/controller/src/http/errors.ts";
import { WITHHELD_ERROR_TEXT } from "../../apps/controller/src/logging.ts";
import { DependencyUnavailableError } from "../../packages/occ/src/index.ts";
import {
  carriesFakeCredential,
  CREDENTIAL_SHAPE_TEXTS,
  LEGITIMATE_DIAGNOSTIC_TEXTS,
} from "../fixtures/logged-error-text-cases.ts";
import { syntheticCredentialUrl } from "../fixtures/synthetic-credential-url.mjs";

export function registerDependencyUnavailableFieldsCases(clientText: string) {
  test("dependency log fields keep only the class and code of a bounded cause chain", () => {
    const first = Object.assign(new Error(clientText), { code: "not a code: Bearer x" });
    const second = Object.assign(new Error(clientText), { name: "Bearer abc", code: 1.5 });
    first.cause = second;
    second.cause = first;
    const error = new DependencyUnavailableError("The selected secret Driver is unavailable.");
    error.cause = first;
    assert.deepEqual(dependencyUnavailableLogFields(error), {
      errorClass: "DependencyUnavailableError",
      message: "The selected secret Driver is unavailable.",
      causes: [{}, {}],
    });

    let chain = new Error("root");
    for (let depth = 0; depth < 6; depth += 1) {
      chain = Object.assign(new Error(`level ${depth}`), { code: `L${depth}`, cause: chain });
    }
    const deep = new DependencyUnavailableError("Deep outage.\nNext line\u0000.");
    deep.cause = chain;
    const fields = dependencyUnavailableLogFields(deep);
    assert.equal(fields.message, "Deep outage. Next line .");
    // Format characters (a bidi override, a zero-width space) collapse like control characters.
    const reordered = new DependencyUnavailableError("Gateway \u202Edown \u200Bretry.");
    assert.equal(dependencyUnavailableLogFields(reordered).message, "Gateway down retry.");
    assert.ok(fields.causes);
    assert.deepEqual(
      fields.causes.map(({ code }) => code),
      ["L5", "L4", "L3", "L2"],
    );
    for (const message of [
      `Fetch ${syntheticCredentialUrl({ username: "user", password: "pass", host: "example.test", port: undefined, pathname: "/x" })} failed.`,
      `Fetch https://example.test/x?${new URLSearchParams({ sig: "abc" })} failed.`,
      // A credential that straddles the 512-character cut is still withheld.
      `${"a".repeat(500)} Bearer abcdefghijklmnopqrstuvwxyz`,
    ]) {
      const withheld = new DependencyUnavailableError(message);
      assert.equal(dependencyUnavailableLogFields(withheld).message, WITHHELD_ERROR_TEXT, message);
    }
    const long = dependencyUnavailableLogFields(new DependencyUnavailableError("b".repeat(600)));
    assert.equal(long.message, "b".repeat(512));
    // A class name or code that resembles a credential is dropped, never logged.
    const credentialLike = new DependencyUnavailableError("Outage.");
    credentialLike.cause = Object.assign(new Error("x"), {
      name: "AKIA0123456789ABCDEF",
      code: "AKIA0123456789ABCDEF",
    });
    assert.deepEqual(dependencyUnavailableLogFields(credentialLike).causes, [{}]);
  });

  // Fake values, assembled so no complete token shape appears in the source.
  const FAKE = "Abcdefghij0123456789Abcdefghij012345";
  const POSTGRES_URL = syntheticCredentialUrl({
    protocol: "postgres",
    username: "fake-user",
    password: "fake-pass",
    host: "db.example.test",
    port: undefined,
    pathname: "/occ",
  });
  const POSTGRES_USER_ONLY = new URL("postgres://db.example.test/occ");
  POSTGRES_USER_ONLY.username = "fake-user";
  const CREDENTIAL_MESSAGES = [
    `Upstream sent ${["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmYWtlIn0", "c2lnbmF0dXJl"].join(".")}.`,
    `Header Authorization: Basic ${Buffer.from("fake-user:fake-pass").toString("base64")}`,
    "Header authorization: basic ZmFrZTpmYWtl",
    ...["ghs", "ghu", "ghr", "ghp", "gho"].map((prefix) => `Clone with ${prefix}_${FAKE} failed.`),
    `Slack answered for ${["xoxb", "1234567890", "fakefakefake"].join("-")}.`,
    ...["client_secret", "refresh_token", "id_token", "code", "apikey", "X-Amz-Signature"].map(
      (name) => `Fetch https://idp.example.test/token?a=1&${name}=fake-value failed.`,
    ),
    `Connect ${syntheticCredentialUrl({ protocol: "postgres", username: "fake-user", password: "pa/ss", host: "db.example.test", port: 5432, pathname: "/occ" })} failed.`,
    `Connect ${POSTGRES_USER_ONLY} failed.`,
    "Connect host=db.example.test user=occ password=fake-pass failed.",
    "Connect Server=db.example.test;Uid=occ;Pwd=fake-pass; failed.",
    "Token exchange body grant_type=refresh_token&refresh_token=fake-value was refused.",
  ];
  test("dependency log fields withhold common token, URL and connection-string credentials", () => {
    for (const message of CREDENTIAL_MESSAGES) {
      const fields = dependencyUnavailableLogFields(new DependencyUnavailableError(message));
      assert.equal(fields.message, WITHHELD_ERROR_TEXT, message);
    }
    for (const message of LEGITIMATE_DIAGNOSTIC_TEXTS) {
      const fields = dependencyUnavailableLogFields(new DependencyUnavailableError(message));
      assert.equal(fields.message, message);
    }
    // A JSON, form or connection-string pair, a credential header or a token prefix is withheld
    // too; the class and cause chain stay, and the value appears nowhere.
    for (const { shape, text } of CREDENTIAL_SHAPE_TEXTS) {
      const error = new DependencyUnavailableError(text);
      error.cause = Object.assign(new Error(text), { name: "ApiException", code: 401 });
      const fields = dependencyUnavailableLogFields(error);
      assert.deepEqual(
        fields,
        {
          errorClass: "DependencyUnavailableError",
          message: WITHHELD_ERROR_TEXT,
          causes: [{ errorClass: "ApiException", code: 401 }],
        },
        shape,
      );
      assert.equal(carriesFakeCredential(JSON.stringify(fields)), false, shape);
    }
    // A cause code shaped like a token is dropped; an ordinary code is kept.
    const error = new DependencyUnavailableError("Outage.");
    error.cause = Object.assign(new Error("x"), {
      code: `ghs_${FAKE}`,
      cause: Object.assign(new Error("y"), {
        code: ["xoxb", "1234567890", "fakefakefake"].join("-"),
        cause: Object.assign(new Error("z"), { code: "ECONNRESET" }),
      }),
    });
    assert.deepEqual(dependencyUnavailableLogFields(error).causes, [
      {},
      {},
      { code: "ECONNRESET" },
    ]);
  });

  test("dependency log fields check a bounded prefix of a long message", () => {
    // Inputs that made the URL pattern scan quadratically before the check was bounded.
    for (const message of [
      "a.".repeat(500_000),
      "a://b:".repeat(200_000),
      `${"x".repeat(1_000_000)} Bearer abcdefghijklmnopqrstuvwxyz`,
    ]) {
      const started = performance.now();
      const fields = dependencyUnavailableLogFields(new DependencyUnavailableError(message));
      const elapsedMs = performance.now() - started;
      assert.ok(elapsedMs < 1_000, `${message.slice(0, 12)}: ${elapsedMs} ms`);
      assert.equal(fields.message, message.slice(0, 512));
    }
    // A credential that starts before the cut and runs far past it is still withheld.
    const straddling = `${"c".repeat(500)} Bearer ${"t".repeat(5_000)}`;
    assert.equal(
      dependencyUnavailableLogFields(new DependencyUnavailableError(straddling)).message,
      WITHHELD_ERROR_TEXT,
    );
    // Padding collapses before the bound, so it cannot push a credential's end past the check.
    const padded = `x${" ".repeat(2_025)}${POSTGRES_URL}`;
    assert.equal(
      dependencyUnavailableLogFields(new DependencyUnavailableError(padded)).message,
      WITHHELD_ERROR_TEXT,
    );
  });
}
