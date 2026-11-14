import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type OutgoingHttpHeaders } from "node:http";
import test from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";

import { GATEWAY_RUNTIME_ENTRYPOINT } from "../../apps/controller/src/drivers/compute/kubernetes/runtime-entrypoints.ts";
import { isRecord } from "../../scripts/ci/reporter-diagnostics.ts";
import { listen } from "../helpers/listen.ts";
import {
  bodyShapes as helperBodyShapes,
  providerErrorCodes as helperErrorCodes,
  providerErrorTypes as helperErrorTypes,
} from "../helpers/local-first-agent-native.mjs";

const execute = promisify(execFile);

interface UpfrontOptions {
  env: { U: string; H: string; C: string; T: string };
  stdio: unknown[];
  encoding: string;
  maxBuffer: number;
}

interface ChildResult {
  status: number;
  stdout: string;
  stderr: string;
}

type ProviderCase = readonly [provider: string, fragment: unknown, key?: string];

function upfrontSource() {
  const begin = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("const UPFRONT_ENDPOINTS = {");
  const end = GATEWAY_RUNTIME_ENTRYPOINT.indexOf("\nfunction cpuCgroupFile(", begin);
  assert.ok(begin >= 0 && end > begin, "expected the generated upfront credential check");
  return GATEWAY_RUNTIME_ENTRYPOINT.slice(begin, end);
}

function readUpfrontOptions(value: unknown): UpfrontOptions {
  assert.ok(isRecord(value) && isRecord(value.env));
  const { U, H, C, T } = value.env;
  assert.ok(typeof U === "string" && typeof H === "string");
  assert.ok(typeof C === "string" && typeof T === "string");
  const { stdio, encoding, maxBuffer } = value;
  assert.ok(Array.isArray(stdio));
  assert.ok(typeof encoding === "string" && typeof maxBuffer === "number");
  return { env: { U, H, C, T }, stdio, encoding, maxBuffer };
}

// Run the generated parent with a recording spawnSync and deliberately malformed child results.
function upfrontCheck(
  provider: string,
  fragment: unknown,
  key = "fixture-key",
  status: unknown = 3,
) {
  const result = isRecord(status) ? status : { status };
  const calls: UpfrontOptions[] = [];
  const stages: string[] = [];
  const rejected: unknown = vm.runInNewContext(
    upfrontSource() + "\ncredentialRejectedUpfront(provider, fragment, key, stage)",
    {
      provider,
      fragment,
      key,
      stage: (name: unknown) => {
        assert.ok(typeof name === "string");
        stages.push(name);
      },
      JSON,
      process: { execPath: "/node", env: { NODE_EXTRA_CA_CERTS: "/ca.pem" } },
      require: (name: unknown) => {
        assert.equal(name, "node:child_process");
        return {
          spawnSync(command: unknown, args: unknown, options: unknown) {
            assert.equal(command, "/node");
            assert.ok(Array.isArray(args) && args.length === 2 && args[0] === "-e");
            assert.ok(typeof args[1] === "string");
            calls.push(readUpfrontOptions(options));
            return result;
          },
        };
      },
    },
  );
  assert.ok(rejected === false || isRecord(rejected));
  // Copy the VM result into this realm before comparing its exact fields.
  return { rejected: rejected === false ? (false as const) : { ...rejected }, calls, stages };
}

function firstCall(provider: string, fragment: unknown, key?: string) {
  const [call] = upfrontCheck(provider, fragment, key).calls;
  assert.ok(call, "expected the parent to start the upfront child");
  return call;
}

const UPFRONT_ERROR_CODES = [
  "invalid_api_key",
  "insufficient_permissions",
  "invalid_organization",
  "mismatched_organization",
  "no_organization",
  "invalid_project",
  "mismatched_project",
  "account_deactivated",
  "deactivated_workspace",
  "ip_not_authorized",
];
const UPFRONT_ERROR_TYPES = ["invalid_request_error", "authentication_error", "permission_error"];
const HOSTILE_KEY = "sk-proj-HostileFixtureKey0123456789abcdef";

export function registerModelProbeAuthenticationCases() {
  let source: string | undefined;
  const runChild = async (env: NodeJS.ProcessEnv): Promise<ChildResult> => {
    source ??= /\["-e",\s*'([^']+)',/.exec(upfrontSource())?.[1];
    assert.ok(source, "expected the generated node -e child");
    try {
      const { stdout, stderr } = await execute(process.execPath, ["-e", source], { env });
      return { status: 0, stdout, stderr };
    } catch (error: unknown) {
      if (
        !isRecord(error) ||
        typeof error.code !== "number" ||
        typeof error.stdout !== "string" ||
        typeof error.stderr !== "string"
      ) {
        throw error;
      }
      return { status: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };

  test("the upfront credential check runs only where OpenClaw would send the same request", () => {
    const openai = upfrontCheck("openai", undefined);
    // A rejection names the provider's 401, who answered it (from response header
    // names only) and, when the child classified it, a closed-vocabulary code; the
    // response body and header values never leave the child.
    assert.deepEqual(openai.rejected, { providerStatus: 401, responseHeaderMarker: "none" });
    assert.deepEqual(openai.stages, ["preflight"]);
    assert.equal(openai.calls.length, 1);
    const [request] = openai.calls;
    assert.ok(request);
    assert.equal(request.env.U, "https://api.openai.com/v1/responses");
    const headers: unknown = JSON.parse(request.env.H);
    assert.deepEqual(headers, {
      authorization: "Bearer fixture-key",
      "content-type": "application/json",
    });
    // The request goes to the configured API's own path: OpenAI answers 401 to a key
    // that lacks the scope of an endpoint OpenClaw would never call.
    assert.equal(
      firstCall("openai", { api: "openai-completions" }).env.U,
      "https://api.openai.com/v1/chat/completions",
    );
    assert.equal(
      firstCall("openai", {
        api: "openai-completions",
        models: [{ id: "gpt-5", api: "openai-completions" }],
      }).env.U,
      "https://api.openai.com/v1/chat/completions",
    );
    assert.equal(
      firstCall("openai", { api: "openai-responses" }).env.U,
      "https://api.openai.com/v1/responses",
    );
    assert.equal(
      firstCall("anthropic", undefined, "sk-ant-api03-fixture").env.U,
      "https://api.anthropic.com/v1/messages",
    );
    // Only a 401 (exit 3-6 plus a known header marker 0, 10, 20 or 30) is a rejection.
    for (const status of [0, 1, 2, 7, 9, 10, 12, 17, 27, 30, 37, 40, 43, -3, 3.5, "13", null]) {
      assert.equal(
        upfrontCheck("openai", undefined, "fixture-key", status).rejected,
        false,
        String(status),
      );
    }
    for (const [status, providerCode, responseHeaderMarker] of [
      [4, "invalid_api_key", "none"],
      [5, "missing_api_key", "none"],
      [6, "insufficient_permissions", "none"],
      [13, undefined, "provider-like"],
      [14, "invalid_api_key", "provider-like"],
      [15, "missing_api_key", "provider-like"],
      [16, "insufficient_permissions", "provider-like"],
      [23, undefined, "openshell-policy"],
      [25, "missing_api_key", "openshell-policy"],
      [33, undefined, "mixed"],
      [34, "invalid_api_key", "mixed"],
    ]) {
      assert.deepEqual(
        upfrontCheck("openai", undefined, "fixture-key", status).rejected,
        {
          providerStatus: 401,
          responseHeaderMarker,
          ...(providerCode === undefined ? {} : { providerCode }),
        },
        String(status),
      );
    }
    for (const [provider, fragment, key] of [
      ["openai", { baseUrl: "https://api.openai.com/v1/" }],
      ["openai", { api: "openai-completions", models: [{ id: "gpt-5" }] }],
      ["openai", { request: { allowPrivateNetwork: true } }],
      ["openai", null],
      ["anthropic", { baseUrl: "https://api.anthropic.com", api: "anthropic-messages" }],
      ["anthropic", undefined, "sk-ant-api03-fixture"],
    ] satisfies ProviderCase[]) {
      assert.equal(upfrontCheck(provider, fragment, key).calls.length, 1, JSON.stringify(fragment));
    }
    for (const [provider, fragment, key] of [
      ["openai", { baseUrl: "https://gateway.example/v1" }],
      ["openai", { api: "anthropic-messages" }],
      ["openai", { headers: { "OpenAI-Project": "proj_fixture" } }],
      ["openai", { authHeader: false }],
      ["openai", { request: { allowPrivateNetwork: true, proxy: { url: "http://proxy" } } }],
      ["openai", { models: [{ id: "gpt-5", headers: { "x-fixture": "1" } }] }],
      ["openai", { models: [{ id: "gpt-5", api: "openai-completions" }] }],
      ["openai", { models: [{ id: "gpt-5", baseUrl: "https://gateway.example/v1" }] }],
      ["openai", { api: "__proto__" }],
      ["anthropic", { baseUrl: "https://api.openai.com/v1" }],
      ["anthropic", undefined, "sk-ant-oat01-fixture"],
      ["codex", undefined],
      ["fixture", undefined],
    ] satisfies ProviderCase[]) {
      const skipped = upfrontCheck(provider, fragment, key);
      assert.deepEqual([skipped.rejected, skipped.calls, skipped.stages], [false, [], []]);
    }
  });

  test("the upfront check keeps only closed-set body tokens from its child", () => {
    const { stdio, encoding, maxBuffer, env } = firstCall("openai", undefined);
    // Only stdout is read, bounded; the child gets the closed sets, never "other".
    assert.deepEqual([...stdio], ["ignore", "pipe", "ignore"]);
    assert.equal(encoding, "utf8");
    assert.ok(maxBuffer <= 1024);
    const codes: unknown = JSON.parse(env.C);
    const types: unknown = JSON.parse(env.T);
    assert.deepEqual(codes, UPFRONT_ERROR_CODES);
    assert.deepEqual(types, UPFRONT_ERROR_TYPES);
    // The QA helper reads the same sets, plus "other".
    assert.deepEqual([...helperErrorCodes], [...UPFRONT_ERROR_CODES, "other"]);
    assert.deepEqual([...helperErrorTypes], [...UPFRONT_ERROR_TYPES, "other"]);
    assert.deepEqual(
      [...helperBodyShapes],
      ["json-error-code", "json-error-no-code", "json-no-error", "non-json", "empty"],
    );
    const rejected = (stdout: unknown, status: number | null = 13) =>
      upfrontCheck("openai", undefined, "fixture-key", { status, stdout }).rejected;
    const base = { providerStatus: 401, responseHeaderMarker: "provider-like" };
    for (const [bodyShape, providerErrorCode, providerErrorType] of [
      ["json-error-code", "no_organization", "invalid_request_error"],
      ["json-error-code", "other", "other"],
      ["json-error-code", "ip_not_authorized", "permission_error"],
      ["json-error-no-code", "", "authentication_error"],
      ["json-error-no-code", "", ""],
      ["json-no-error", "", ""],
      ["non-json", "", ""],
      ["empty", "", ""],
    ] as const) {
      assert.deepEqual(
        rejected(JSON.stringify([bodyShape, providerErrorCode, providerErrorType])),
        {
          ...base,
          bodyShape,
          ...(providerErrorCode && { providerErrorCode }),
          ...(providerErrorType && { providerErrorType }),
        },
        bodyShape,
      );
    }
    for (const code of UPFRONT_ERROR_CODES) {
      const result = rejected(JSON.stringify(["json-error-code", code, ""]));
      assert.ok(isRecord(result));
      assert.equal(result.providerErrorCode, code);
    }
    for (const type of UPFRONT_ERROR_TYPES) {
      const result = rejected(JSON.stringify(["json-error-code", "", type]));
      assert.ok(isRecord(result));
      assert.equal(result.providerErrorType, type);
    }
    // Each token is checked on its own: exact, case-sensitive set members only.
    assert.deepEqual(
      rejected(JSON.stringify(["json-error-code", "Invalid_API_Key", "authentication_error "])),
      { ...base, bodyShape: "json-error-code" },
    );
    assert.deepEqual(rejected(JSON.stringify(["html", "other", "permission_error"])), {
      ...base,
      providerErrorCode: "other",
      providerErrorType: "permission_error",
    });
    // Anything off-set, misplaced or malformed is dropped, never passed on.
    for (const stdout of [
      JSON.stringify(["html", "", ""]),
      JSON.stringify(["other", "invalid_request_error", "invalid_api_key"]),
      JSON.stringify([HOSTILE_KEY, HOSTILE_KEY, "Bearer " + HOSTILE_KEY]),
      JSON.stringify([["empty"], { code: "invalid_api_key" }, 401]),
      JSON.stringify({ bodyShape: "empty", providerErrorCode: "invalid_api_key" }),
      '"empty"',
      "empty",
      "",
      HOSTILE_KEY,
      undefined,
      null,
    ]) {
      const result = rejected(stdout);
      assert.deepEqual(result, base, String(stdout));
    }
    // Tokens never turn a non-401 into a rejection.
    for (const status of [0, 1, 7, null]) {
      assert.equal(rejected(JSON.stringify(["empty", "", ""]), status), false, String(status));
    }
  });

  test("the upfront request exits 3 only when the provider answers 401", async (t) => {
    const received: {
      method: string | undefined;
      url: string | undefined;
      auth: IncomingHttpHeaders["authorization"];
      body: string;
    }[] = [];
    let answer = 401;
    let answerBody = "{}";
    let answerHeaders: OutgoingHttpHeaders = {};
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({
          method: request.method,
          url: request.url,
          auth: request.headers.authorization,
          body,
        });
        response
          .writeHead(answer, { "content-type": "application/json", ...answerHeaders })
          .end(answerBody);
      });
    });
    const url = `http://127.0.0.1:${await listen(t, server)}/v1/responses`;
    const run = async (U: string) => {
      const { status } = await runChild({
        U,
        H: JSON.stringify({ authorization: "Bearer fixture-key" }),
      });
      return status;
    };
    assert.equal(await run(url), 3);
    assert.deepEqual(received, [
      { method: "POST", url: "/v1/responses", auth: "Bearer fixture-key", body: "{}" },
    ]);
    // The 401 is classified from the provider's error code or a few fixed phrases
    // (finding 1643: a request that reached the provider without its credential is
    // told apart from a rejected key); anything else stays 3. OpenAI's actual
    // answer to an absent, empty, schemeless or duplicated Authorization header on
    // /v1/responses is "Missing bearer or basic authentication in header" with a
    // null code.
    for (const [body, code] of [
      ['{"error":{"code":"invalid_api_key","message":"Incorrect API key provided: sk-x"}}', 4],
      ['{"error":{"code":null,"message":"You didn\'t provide an API key."}}', 5],
      ['{"error":{"message":"No API key provided."}}', 5],
      ['{"error":{"code":null,"message":"Missing bearer or basic authentication in header"}}', 5],
      ['{"error":{"code":"insufficient_permissions","message":"x"}}', 6],
      ['{"error":{"message":"Missing scopes: api.responses.write"}}', 6],
      ['{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 4],
      ['{"error":{"type":"authentication_error","message":"x-api-key header is required"}}', 5],
      ['{"error":{"code":"other","message":"Unauthorized"}}', 3],
      ["not json", 3],
      ['{"error":"string"}', 3],
    ] as const) {
      answerBody = body;
      assert.equal(await run(url), code, body);
    }
    // The response header names seen are added as 10 (provider-like: OpenAI's
    // x-request-id plus an openai-* or x-openai-* header, or Anthropic's request-id
    // plus x-should-retry), 20 (X-OpenShell-Policy) or 30 (both: an upstream 401
    // forwarded with the relay's stamp); header values never matter.
    for (const [headers, marker] of [
      [{ "x-request-id": "req_fixture", "openai-version": "2020-10-01" }, 10],
      [{ "x-request-id": "req_fixture", "x-openai-authorization-error": "1" }, 10],
      [{ "X-Request-Id": "req_fixture", "OpenAI-Processing-Ms": "3" }, 10],
      [{ "request-id": "req_fixture", "x-should-retry": "false" }, 10],
      [{ "x-request-id": "req_fixture" }, 0],
      [{ "request-id": "req_fixture" }, 0],
      [{ "x-should-retry": "false" }, 0],
      [{ "openai-version": "2020-10-01" }, 0],
      [{ "x-request-id": "req_fixture", "x-not-openai-marker": "1" }, 0],
      [{ "x-openshell-policy": "fixture-policy" }, 20],
      [{ "X-OpenShell-Policy": "fixture-policy", "x-request-id": "r", "openai-version": "1" }, 30],
      [
        { "x-openshell-policy": "fixture-policy", "request-id": "r", "x-should-retry": "false" },
        30,
      ],
      [{ "x-openshell-policy": "fixture-policy", "x-request-id": "r" }, 20],
      [{ "x-openshell": "no-dash-suffix" }, 0],
      [{ "x-openshell-other": "1" }, 0],
    ] satisfies [OutgoingHttpHeaders, number][]) {
      answerHeaders = headers;
      answerBody =
        '{"error":{"code":null,"message":"Missing bearer or basic authentication in header"}}';
      assert.equal(await run(url), marker + 5, JSON.stringify(headers));
      answerBody = "{}";
      assert.equal(await run(url), marker + 3, JSON.stringify(headers));
    }
    answerHeaders = {};
    answerBody = "{}";
    for (const status of [400, 403, 429, 500]) {
      answer = status;
      assert.equal(await run(url), 0, `HTTP ${status}`);
    }
    // The relay's own denial (403 stamped with X-OpenShell-Policy) is never a 401 rejection.
    answer = 403;
    answerHeaders = { "x-openshell-policy": "fixture-policy" };
    assert.equal(await run(url), 0, "a relay denial");
    answerHeaders = {
      "x-openshell-policy": "fixture-policy",
      "x-request-id": "r",
      "openai-version": "1",
    };
    assert.equal(await run(url), 0, "a forwarded 403");
    answerHeaders = {};
    assert.equal(await run("http://127.0.0.1:1/v1/responses"), 0, "an unreachable endpoint");
  });

  test("the upfront child names a 401 body's shape and closed-set code and type, never its text", async (t) => {
    // The child runs with the environment the parent gives it.
    const { env } = firstCall("openai", undefined);
    let answer = 401;
    let answerBody = "";
    let breakOff = false;
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(answer, {
          "content-type": "application/json",
          "x-request-id": "req_" + HOSTILE_KEY,
          "openai-organization": HOSTILE_KEY,
          ...(breakOff && { "content-length": String(answerBody.length + 100) }),
        });
        if (breakOff) {
          const socket = response.socket;
          assert.ok(socket);
          response.write(answerBody, () => socket.destroy());
        } else {
          response.end(answerBody);
        }
      });
    });
    const url = `http://127.0.0.1:${await listen(t, server)}/v1/responses`;
    const run = (body: string) => {
      answerBody = body;
      return runChild({
        U: url,
        H: JSON.stringify({ authorization: "Bearer fixture-key" }),
        C: env.C,
        T: env.T,
      });
    };
    const quoted = JSON.stringify(HOSTILE_KEY);
    const providerCodeByStatus = new Map([
      [14, "invalid_api_key"],
      [15, "missing_api_key"],
    ]);
    for (const [body, status, bodyShape, providerErrorCode, providerErrorType] of [
      [
        `{"error":{"message":"Incorrect API key provided: ${HOSTILE_KEY}","type":"invalid_request_error","param":null,"code":"invalid_api_key"}}`,
        14,
        "json-error-code",
        "invalid_api_key",
        "invalid_request_error",
      ],
      [
        '{"error":{"message":"Missing bearer or basic authentication in header","type":"invalid_request_error","param":null,"code":null}}',
        15,
        "json-error-no-code",
        undefined,
        "invalid_request_error",
      ],
      [
        '{"error":{"message":"You must be a member of an organization to use the API.","type":"invalid_request_error","param":null,"code":"no_organization"}}',
        13,
        "json-error-code",
        "no_organization",
        "invalid_request_error",
      ],
      [
        '{"error":{"code":"mismatched_project","message":"x"}}',
        13,
        "json-error-code",
        "mismatched_project",
        undefined,
      ],
      [
        '{"error":{"code":"ip_not_authorized","type":"permission_error"}}',
        13,
        "json-error-code",
        "ip_not_authorized",
        "permission_error",
      ],
      [
        '{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}',
        14,
        "json-error-no-code",
        undefined,
        "authentication_error",
      ],
      // Off-set codes and types, however key-shaped, become "other".
      [
        `{"error":{"code":${quoted},"type":${quoted},"message":${quoted},"param":${quoted}}}`,
        13,
        "json-error-code",
        "other",
        "other",
      ],
      [
        '{"error":{"code":"INVALID_API_KEY","type":"Authentication_Error"}}',
        13,
        "json-error-code",
        "other",
        "other",
      ],
      [
        '{"error":{"code":401,"type":["authentication_error"]}}',
        13,
        "json-error-code",
        "other",
        "other",
      ],
      ['{"error":{"code":"","type":{"name":"x"}}}', 13, "json-error-code", "other", "other"],
      ['{"error":{"code":false}}', 13, "json-error-code", "other", undefined],
      // Prototype-shaped names are plain off-set values or own keys, never lookups.
      [
        '{"error":{"code":"__proto__","type":"constructor"}}',
        13,
        "json-error-code",
        "other",
        "other",
      ],
      [
        '{"error":{"code":"toString","type":"hasOwnProperty"}}',
        13,
        "json-error-code",
        "other",
        "other",
      ],
      [
        '{"error":{"__proto__":{"code":"invalid_api_key"}}}',
        13,
        "json-error-no-code",
        undefined,
        undefined,
      ],
      [
        '{"__proto__":{"error":{"code":"invalid_api_key"}}}',
        13,
        "json-no-error",
        undefined,
        undefined,
      ],
      ['{"error":{}}', 13, "json-error-no-code", undefined, undefined],
      // JSON without an error object, including a bare error string or array.
      [`{"error":${quoted}}`, 13, "json-no-error", undefined, undefined],
      ['{"error":["invalid_api_key"]}', 13, "json-no-error", undefined, undefined],
      ['{"error":null,"code":"invalid_api_key"}', 13, "json-no-error", undefined, undefined],
      [`{"message":${quoted}}`, 13, "json-no-error", undefined, undefined],
      ["null", 13, "json-no-error", undefined, undefined],
      [quoted, 13, "json-no-error", undefined, undefined],
      [`Unauthorized: ${HOSTILE_KEY}`, 13, "non-json", undefined, undefined],
      [`<html><body>401 ${HOSTILE_KEY}</body></html>`, 13, "non-json", undefined, undefined],
      ["", 13, "empty", undefined, undefined],
      [" \n\t", 13, "empty", undefined, undefined],
    ] as const) {
      const child = await run(body);
      assert.equal(child.status, status, body);
      const tokens: unknown = JSON.parse(child.stdout);
      assert.deepEqual(tokens, [bodyShape, providerErrorCode ?? "", providerErrorType ?? ""], body);
      // The parent turns the child's result into the probe's fields.
      const { rejected } = upfrontCheck("openai", undefined, "fixture-key", child);
      const providerCode = providerCodeByStatus.get(status);
      assert.deepEqual(
        rejected,
        {
          providerStatus: 401,
          responseHeaderMarker: "provider-like",
          ...(providerCode === undefined ? {} : { providerCode }),
          bodyShape,
          ...(providerErrorCode && { providerErrorCode }),
          ...(providerErrorType && { providerErrorType }),
        },
        body,
      );
      // Neither the body, a header value, the request's key nor any part of a
      // hostile key leaves the child.
      for (const text of [child.stdout, child.stderr, JSON.stringify(rejected)]) {
        assert.ok(
          !/Hostile|sk-proj|fixture-key|Incorrect|Unauthorized|member|html/i.test(text),
          text,
        );
      }
    }
    // A body that breaks off mid-read names no shape: it was neither empty nor parsed.
    breakOff = true;
    const broken = await run(`{"error":{"code":"invalid_api_key","message":${quoted}`);
    breakOff = false;
    assert.equal(broken.status, 13);
    const brokenTokens: unknown = JSON.parse(broken.stdout);
    assert.deepEqual(brokenTokens, ["", "", ""]);
    assert.deepEqual(upfrontCheck("openai", undefined, "fixture-key", broken).rejected, {
      providerStatus: 401,
      responseHeaderMarker: "provider-like",
    });
    // A non-401 answer writes nothing, whatever its body.
    for (const status of [400, 403, 500]) {
      answer = status;
      const child = await run(`{"error":{"code":"invalid_api_key","message":${quoted}}}`);
      assert.deepEqual([child.status, child.stdout], [0, ""], String(status));
    }
  });
}
