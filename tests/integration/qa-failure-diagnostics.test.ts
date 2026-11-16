import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { failingQaCommand } from "../fixtures/qa-error-redaction-child.ts";
import { listen } from "../helpers/listen.ts";
import { createNativePluginAssertions } from "../helpers/native-plugin-assertions.ts";
import { redactQaError, redactedQaTail, registerQaSecret } from "../helpers/qa-secrets.ts";

type NativePluginOptions = Parameters<typeof createNativePluginAssertions>[0];
type RuntimeLogReader = NonNullable<NativePluginOptions["readRuntimeLogs"]>;
type RuntimeLogWriter = NonNullable<NativePluginOptions["recordRuntimeLogs"]>;
type RuntimeLogEntry = Awaited<ReturnType<RuntimeLogReader>>["records"][number];

test("QA error redaction keeps errors whose message cannot be written", () => {
  const value = "synthetic-qa-error-secret-2026";
  registerQaSecret(value);

  // An ordinary error is redacted in place, message and stack.
  const ordinary = new Error(`request failed: ${value}`);
  assert.equal(redactQaError(ordinary), ordinary);
  assert.equal(ordinary.message, "request failed: [REDACTED]");
  assert.ok(ordinary.stack);
  assert.ok(!ordinary.stack.includes(value), ordinary.stack);
  assert.match(ordinary.stack, /request failed: \[REDACTED\]/);

  // AbortSignal.timeout's error: nothing to redact, so it is returned untouched.
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  assert.equal(redactQaError(timeout), timeout);
  assert.equal(timeout.message, "The operation was aborted due to timeout");

  // A DOMException carrying a secret: its message is getter-only, so a plain
  // Error replaces it, with the name, code and redacted stack, and without the
  // original as `cause` (inspecting that would print the secret).
  const dom = new DOMException(`timed out reading ${value}`, "TimeoutError");
  const replaced = redactQaError(dom);
  assert.notEqual(replaced, dom);
  assert.ok(replaced instanceof Error);
  assert.equal(replaced.message, "timed out reading [REDACTED]");
  assert.equal(replaced.name, "TimeoutError");
  assert.ok("code" in replaced);
  assert.equal(replaced.code, dom.code);
  assert.equal(replaced.cause, undefined);
  assert.ok(replaced.stack);
  assert.match(replaced.stack, /^TimeoutError: timed out reading \[REDACTED\]/);
  assert.ok(!inspect(replaced).includes(value), inspect(replaced));

  // A frozen error cannot be updated either.
  const frozen = Object.freeze(Object.assign(new Error(`denied ${value}`), { code: "EACCES" }));
  const unfrozen = redactQaError(frozen);
  assert.notEqual(unfrozen, frozen);
  assert.ok(unfrozen instanceof Error && "code" in unfrozen);
  assert.equal(unfrozen.message, "denied [REDACTED]");
  assert.equal(unfrozen.name, "Error");
  assert.equal(unfrozen.code, "EACCES");
  assert.ok(unfrozen.stack);
  assert.match(unfrozen.stack, /^Error: denied \[REDACTED\]\n/);
  assert.ok(!inspect(unfrozen).includes(value), inspect(unfrozen));

  // A thrown string is redacted; other non-objects pass through.
  assert.equal(redactQaError(`token ${value}`), "token [REDACTED]");
  assert.equal(redactQaError(undefined), undefined);
});

test("QA error redaction covers causes, AggregateError errors and command output", async () => {
  const value = "synthetic-qa-nested-secret-2026";
  registerQaSecret(value);
  // Everything node:test prints, getters included, at any depth.
  const printed = (error: unknown) => inspect(error, { depth: Infinity, getters: true });
  const assertClean = (error: unknown) => {
    const text = printed(error);
    for (const variant of printedSecretForms(value)) {
      assert.ok(!text.includes(variant), `variant survived: ${text}`);
    }
  };
  // A real execFile failure: the secret is in argv (cmd), stdout and stderr.
  for (const encoding of ["utf8", "buffer"] as const) {
    const error = await failingQaCommand(value, encoding);
    assert.equal(Buffer.isBuffer(error.stdout), encoding === "buffer");
    assert.equal(redactQaError(error), error);
    assert.equal(Buffer.isBuffer(error.stdout), encoding === "buffer");
    assert.equal(Buffer.isBuffer(error.stderr), encoding === "buffer");
    assert.equal(String(error.stdout), "[REDACTED]");
    assert.equal(String(error.stderr), "[REDACTED]");
    assert.ok(typeof error.cmd === "string");
    assert.match(error.cmd, / \[REDACTED\]$/);
    assert.equal(error.code, 3);
    assertClean(error);
  }

  // A cause chain, a string cause and an AggregateError's errors, with a
  // Buffer stderr two levels down.
  const chained = new Error("outer", {
    cause: new AggregateError(
      [
        new Error("first", { cause: new Error(`inner ${value}`) }),
        Object.assign(new Error("second"), { stderr: Buffer.from(`denied ${value}\n`) }),
        new Error("third", { cause: `token ${value}` }),
      ],
      `aggregate ${value}`,
    ),
  });
  assert.equal(redactQaError(chained), chained);
  assert.ok(chained.cause instanceof AggregateError);
  assert.equal(chained.cause.message, "aggregate [REDACTED]");
  const causes: readonly unknown[] = chained.cause.errors;
  const [first, second, third] = causes;
  assert.ok(first instanceof Error && first.cause instanceof Error);
  assert.equal(first.cause.message, "inner [REDACTED]");
  assert.ok(second instanceof Error && "stderr" in second);
  assert.equal(String(second.stderr), "denied [REDACTED]\n");
  assert.ok(third instanceof Error);
  assert.equal(third.cause, "token [REDACTED]");
  assertClean(chained);

  // A cause that points back at its own error is cut, not followed forever.
  const cyclic = new Error(`cyclic ${value}`);
  cyclic.cause = cyclic;
  assert.equal(redactQaError(cyclic), cyclic);
  assert.equal(cyclic.cause, "[Circular]");
  assertClean(cyclic);

  // A two-error cycle whose top error is frozen: the replacement's cause must
  // not lead back to the unredacted original.
  const top = new Error(`top ${value}`);
  const middle = new Error(`middle ${value}`, { cause: top });
  top.cause = middle;
  Object.freeze(top);
  const replaced = redactQaError(top);
  assert.notEqual(replaced, top);
  assert.ok(replaced instanceof Error);
  assert.equal(replaced.message, "top [REDACTED]");
  assert.equal(replaced.cause, middle);
  assert.equal(middle.message, "middle [REDACTED]");
  assert.equal(middle.cause, "[Circular]");
  assertClean(replaced);

  // A frozen cause is replaced inside a writable parent.
  const frozenCause = Object.freeze(Object.assign(new Error(`frozen ${value}`), { code: "E1" }));
  const parent = new Error("parent", { cause: frozenCause });
  assert.equal(redactQaError(parent), parent);
  assert.notEqual(parent.cause, frozenCause);
  assert.ok(parent.cause instanceof Error && "code" in parent.cause);
  assert.equal(parent.cause.message, "frozen [REDACTED]");
  assert.equal(parent.cause.code, "E1");
  assertClean(parent);

  // A getter-only field (node:test prints getters) forces a replacement that
  // keeps the other fields, redacted.
  const getter = Object.assign(new Error(`getter ${value}`), {
    code: "EGETTER",
    stderr: `stderr ${value}`,
    request: { headers: { authorization: value } },
  });
  Object.defineProperty(getter, "stdout", { enumerable: true, get: () => `stdout ${value}` });
  const fromGetter = redactQaError(getter);
  assert.notEqual(fromGetter, getter);
  assert.ok(
    fromGetter instanceof Error &&
      "stdout" in fromGetter &&
      "stderr" in fromGetter &&
      "code" in fromGetter &&
      "request" in fromGetter,
  );
  assert.equal(fromGetter.message, "getter [REDACTED]");
  assert.equal(fromGetter.stdout, "stdout [REDACTED]");
  assert.equal(fromGetter.stderr, "stderr [REDACTED]");
  assert.equal(fromGetter.code, "EGETTER");
  assert.deepEqual(fromGetter.request, { headers: { authorization: "[REDACTED]" } });
  assertClean(fromGetter);

  // Object-valued fields: a parsed response body, a Map, a Set, a class
  // instance, a symbol key, a self-containing array. Binary bytes around a
  // secret in a Buffer survive. Objects the error only refers to are copied,
  // never written: an assertion's `actual` may be a fixture still in use.
  class Detail {
    raw = Buffer.from(value);
  }
  const shared = { token: value };
  const symbol = Symbol("detail");
  const loop: unknown[] = [`loop ${value}`];
  loop.push(loop);
  const objects = Object.assign(new Error("objects"), {
    response: { status: 403, body: { message: `denied ${value}` } },
    headers: new Map([["authorization", value]]),
    raw: new Map([["body", Buffer.from(value)]]),
    seen: new Set([`set ${value}`]),
    detail: new Detail(),
    actual: shared,
    url: new URL(`https://registry.example.test/v2/?token=${value}`),
    requestHeaders: new Headers({ authorization: `Bearer ${value}` }),
    labels: Object.assign(new Map([["team", "qa"]]), { extra: `extra ${value}` }),
    loop,
    [symbol]: `symbol ${value}`,
    stdout: Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(value), Buffer.from([0xfe])]),
  });
  assert.equal(redactQaError(objects), objects);
  assert.equal(objects.response.body.message, "denied [REDACTED]");
  assert.equal(objects.response.status, 403);
  assert.equal(objects.headers.get("authorization"), "[REDACTED]");
  assert.equal(String(objects.raw.get("body")), "[REDACTED]");
  assert.deepEqual([...objects.seen], ["set [REDACTED]"]);
  assert.equal(String(objects.detail.raw), "[REDACTED]");
  assert.equal(objects.actual.token, "[REDACTED]");
  assert.equal(shared.token, value);
  // The redactor replaces hidden state with printable text.
  const redactedUrl: unknown = objects.url;
  const redactedHeaders: unknown = objects.requestHeaders;
  const redactedLabels: unknown = objects.labels;
  assert.ok(typeof redactedUrl === "string");
  assert.ok(typeof redactedHeaders === "string");
  assert.ok(typeof redactedLabels === "string");
  assert.match(redactedUrl, /token=\[REDACTED\]/);
  assert.match(redactedHeaders, /Bearer \[REDACTED\]/);
  assert.match(redactedLabels, /extra \[REDACTED\]/);
  assert.equal(objects.loop[0], "loop [REDACTED]");
  assert.equal(objects.loop[1], "[Circular]");
  assert.equal(objects[symbol], "symbol [REDACTED]");
  assert.deepEqual(
    objects.stdout,
    Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from("[REDACTED]"), Buffer.from([0xfe])]),
  );
  assertClean(objects);

  // A frozen error reached again through another field of its cause.
  const frozenTop = new Error(`frozen top ${value}`);
  const holder = Object.assign(new Error("holder"), { original: frozenTop });
  frozenTop.cause = holder;
  Object.freeze(frozenTop);
  const replacedTop = redactQaError(frozenTop);
  assert.notEqual(replacedTop, frozenTop);
  assert.ok(replacedTop instanceof Error);
  assert.equal(replacedTop.cause, holder);
  assert.equal(holder.original, "[Circular]");
  assertClean(replacedTop);

  // A setter that throws makes the field unwritable, not redaction itself fail.
  const throwing = new Error(`setter ${value}`);
  Object.defineProperty(throwing, "detail", {
    enumerable: true,
    get: () => `detail ${value}`,
    set: () => {
      throw new Error("read-only");
    },
  });
  const fromThrowing = redactQaError(throwing);
  assert.notEqual(fromThrowing, throwing);
  assert.ok(fromThrowing instanceof Error && "detail" in fromThrowing);
  assert.equal(fromThrowing.detail, "detail [REDACTED]");
  assertClean(fromThrowing);

  // A proxy whose traps throw falls back to a bare error with the message.
  const hostile = new Proxy(new Error(`proxy ${value}`), {
    ownKeys() {
      throw new Error("no keys");
    },
  });
  const fromHostile = redactQaError(hostile);
  assert.ok(fromHostile instanceof Error);
  assert.equal(fromHostile.message, "proxy [REDACTED]");
  assertClean(fromHostile);

  // A value first reached at the depth bound (its fields cut there) is walked
  // again when it is reached higher up, so the cut copy is not reused.
  const reused = { body: { token: value } };
  let chain: Error = Object.assign(new Error("bottom"), { ref: reused });
  for (let i = 0; i < 6; i += 1) {
    chain = new Error(`link ${i}`, { cause: chain });
  }
  const reusedTop = Object.assign(new Error("reused", { cause: chain }), { ref: reused });
  assert.equal(redactQaError(reusedTop), reusedTop);
  assert.deepEqual(reusedTop.ref, { body: { token: "[REDACTED]" } });
  assert.equal(reused.body.token, value);
  assertClean(reusedTop);

  // A multi-line secret (a PEM key) behind hidden state is matched whole.
  const pem = [
    "-----BEGIN SYNTHETIC QA KEY-----",
    "c3ludGhldGljLXFhLWtleS1saW5lLW9uZS0yMDI2LWFhYWFhYWFhYWFhYWFhYWFh",
    "c3ludGhldGljLXFhLWtleS1saW5lLXR3by0yMDI2LWJiYmJiYmJiYmJiYmJiYmJi",
    "-----END SYNTHETIC QA KEY-----",
  ].join("\n");
  registerQaSecret(pem);
  const pending = Object.assign(new Error("pending"), { key: Promise.resolve(pem) });
  assert.equal(redactQaError(pending), pending);
  assert.ok(!printed(pending).includes("c3ludGhldGljLXFhLWtleS1saW5l"), printed(pending));

  // A multi-line JSON key file: inspect escapes its quotes unlike JSON does.
  const keyFile = JSON.stringify(
    { type: "service_account", private_key: "synthetic-qa-key-file-body-2026\u0001" },
    null,
    2,
  );
  registerQaSecret(keyFile);
  const keyed = Object.assign(new Error("keyed"), { file: Promise.resolve(keyFile) });
  assert.equal(redactQaError(keyed), keyed);
  assert.ok(!printed(keyed).includes("synthetic-qa-key-file-body"), printed(keyed));

  // An error without a secret is left as it is, cycle included.
  const clean = new Error("clean");
  clean.cause = clean;
  Object.freeze(clean);
  assert.equal(redactQaError(clean), clean);
  assert.equal(clean.cause, clean);
  class Handle {
    [inspect.custom] = () => assert.fail("not printable");
  }
  const unprintable = Object.assign(new Error("unprintable"), { handle: new Handle() });
  assert.equal(redactQaError(unprintable), unprintable);

  // A cause chain deeper than the bound is cut rather than left unredacted.
  let deep = new Error(`deepest ${value}`);
  for (let i = 0; i < 20; i += 1) {
    deep = Object.freeze(new Error(`level ${i}`, { cause: deep }));
  }
  deep = new Error(`top ${value}`, { cause: deep });
  const shallow = redactQaError(deep);
  assert.ok(printed(shallow).includes("[Truncated]"), printed(shallow));
  assertClean(shallow);
});

test(
  "node:test failure output carries no QA secret from nested error fields",
  { timeout: 60_000 },
  async () => {
    const value = "synthetic-qa-reporter-secret-2026";
    const file = fileURLToPath(new URL("../fixtures/qa-error-redaction-child.ts", import.meta.url));
    // NODE_TEST_CONTEXT would make node:test emit runner events instead of spec output.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
      (resolve, reject: (reason: Error) => void) => {
        // execFile calls back after both pipes close. Run the fixture directly so a
        // timeout kills the reporter process itself.
        execFile(
          process.execPath,
          ["--test-reporter=spec", file, value],
          { env, encoding: "utf8", timeout: 55_000, killSignal: "SIGKILL" },
          (error, stdout, stderr) => {
            if (error?.code === 1) {
              resolve({ stdout, stderr });
            } else {
              reject(new Error("The independent reporter must exit with one failing test"));
            }
          },
        );
      },
    );
    const output = stdout + "\n" + stderr;
    for (const variant of printedSecretForms(value)) {
      assert.equal(output.includes(variant), false, "reporter emitted a synthetic secret variant");
    }
    // A launch error or unrelated test failure cannot prove reporter redaction.
    assert.match(output, /command failure/);
    assert.match(output, /code: 3/);
    assert.match(output, /cmd: '.* \[REDACTED\]'/);
    assert.match(output, /detail: 'getter \[REDACTED\]'/);
    assert.match(output, /stdout: <Buffer 5b 52 45 44 41 43 54 45 44 5d>/);
  },
);

// These reporter fixtures contain only URL-safe text. Check the raw text,
// both base64 forms and the opening hex bytes printed by util.inspect.
function printedSecretForms(value: string) {
  const bytes = Buffer.from(value);
  const inspectedBytes = Array.from(bytes.subarray(0, 12), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join(" ");
  return [value, bytes.toString("base64"), bytes.toString("base64url"), inspectedBytes];
}

test("QA log tails drop the body of an unregistered key that starts above the tail", () => {
  const key = [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "b3BlbnNzaC1rZXktdjEsyntheticAAAA",
    "syntheticBodyLineTwoBBBBBBBBBBBB",
  ];
  const tail = { lines: 3, lineChars: 200 };
  const masked = "[redacted credential-bearing line]";
  assert.deepEqual(
    redactedQaTail([...key, "-----END OPENSSH PRIVATE KEY-----", "after"].join("\n"), {}, tail),
    [masked, masked, "after"],
  );
  // If the log ends inside a key, there is no end marker to recover its deleted start.
  assert.deepEqual(
    redactedQaTail([...key, "syntheticBodyLineThreeCCCCCCCCCC"].join("\n"), {}, tail),
    [masked, masked, masked],
  );
});

test("failed native Gateway turns capture private bounded logs for the original revision", async (t) => {
  for (const mode of ["capture", "read-unavailable", "write-unavailable", "success"]) {
    await t.test(mode, async (t) => {
      const credential = `private-runtime-fixture-${randomUUID()}`;
      const password = `private-gateway-fixture-${randomUUID()}`;
      const target = {
        namespaceId: "ns_log_fixture",
        agentId: "agt_log_fixture",
        revisionId: "rev_original",
      };
      const agent = {
        namespaceId: target.namespaceId,
        id: target.agentId,
        revision: { id: target.revisionId },
      };
      const reads: Parameters<RuntimeLogReader>[0][] = [];
      const records: Parameters<RuntimeLogWriter>[0][] = [];
      const cleanup: string[] = [];
      // A real HTTP error crosses normalGatewayTurn. The log reader substitutes only
      // the external OCC response so this exercises the harness and its log evidence.
      const server = createServer((request, response) => {
        assert.equal(request.url, "/v1/chat/completions");
        // Simulate the fixture advancing after request admission: diagnostics stay pinned.
        agent.revision = { id: "rev_replaced" };
        response.writeHead(mode === "success" ? 200 : 500, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            mode === "success"
              ? { choices: [{ message: { content: "expected reply" } }] }
              : { error: { message: "internal error" } },
          ),
        );
      });
      const port = await listen(t, server);
      const fixture = createNativePluginAssertions({
        gatewayUrl: async () => ({
          url: `http://127.0.0.1:${port}`,
          gatewayPassword: password,
          close: () => {
            cleanup.push("close");
          },
        }),
        execGateway: async () => ({
          label: "fixture",
          stdout: JSON.stringify({ chatCompletionsEnabled: true }),
        }),
        readRuntimeLogs: async (identity) => {
          reads.push(identity);
          if (mode === "read-unavailable" && identity.source === "agent") {
            throw new Error(credential);
          }
          // Include extra fields to prove the evidence keeps only the approved fields.
          const withheld = {
            type: "withheld",
            time: null,
            reason: "unrecognised_structured",
            count: 1,
            message: credential,
            fields: { raw: credential },
          } satisfies Extract<RuntimeLogEntry, { type: "withheld" }> & {
            message: string;
            fields: { raw: string };
          };
          return {
            records: [
              ...Array.from({ length: 120 }, (): RuntimeLogEntry => ({
                type: "line",
                time: null,
                level: "info",
                message: "startup",
              })),
              {
                type: "line",
                time: null,
                level: "error",
                message: `native review failed ${password} ${credential} ${Buffer.from(credential).toString("base64")}`,
              },
              withheld,
            ],
          };
        },
        recordRuntimeLogs: (record) => {
          cleanup.push("record");
          if (mode === "write-unavailable") {
            throw new Error(credential);
          }
          records.push(record);
        },
      });
      const run = () =>
        fixture.normalGatewayTurn({
          agent,
          prompt: "fixture prompt",
          expectedPatterns: ["expected reply"],
          secrets: [credential],
        });
      if (mode === "success") {
        assert.equal(await run(), "expected reply");
        assert.deepEqual(reads, []);
        assert.deepEqual(records, []);
      } else {
        await assert.rejects(run, (error) => {
          assert.ok(error instanceof assert.AssertionError);
          assert.equal(
            error.actual,
            500,
            "log collection failure must not replace the Gateway failure",
          );
          assert.equal(error.message.includes(credential), false);
          return true;
        });
        assert.deepEqual(
          reads,
          ["gateway", "agent"].map((source) => ({ ...target, source })),
        );
        if (mode === "write-unavailable") {
          assert.deepEqual(records, []);
        } else {
          assert.equal(records.length, 1);
          const [record] = records;
          assert.ok(record);
          const { sources, ...identity } = record;
          assert.deepEqual(identity, target);
          const text = JSON.stringify(records);
          for (const secret of [credential, password, Buffer.from(credential).toString("base64")]) {
            assert.equal(
              text.includes(secret),
              false,
              "public artifacts must omit raw and encoded credentials",
            );
          }
          assert.match(text, /native review failed/);
          assert.match(text, /unrecognised_structured/);
          assert.equal(
            text.includes('"raw"'),
            false,
            "withheld API fields must not be resurrected",
          );
          assert.ok(sources.every((source) => !("lines" in source) || source.lines.length === 80));
          assert.ok(text.length < 150_000);
          if (mode === "read-unavailable") {
            assert.deepEqual(sources[1], { source: "agent", unavailable: true });
          }
        }
      }
      assert.deepEqual(
        cleanup,
        mode === "success" ? ["close"] : ["record", "close"],
        "diagnostics must run before Gateway cleanup completes",
      );
    });
  }
});
