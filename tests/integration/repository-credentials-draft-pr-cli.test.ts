import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { createServer as createHttpsServer, type ServerOptions } from "node:https";
import { finished } from "node:stream/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { parseUnambiguousJson } from "../../apps/controller/src/drivers/json-members.ts";
import type { JsonObject } from "../../apps/controller/src/drivers/repo/access/json-value.ts";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.ts";
import { run } from "../fixtures/repository-credentials/process.ts";
import { refusingPort } from "../helpers/available-port.ts";
import { signedLeaf } from "../helpers/certificates.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { listen } from "../helpers/listen.ts";

const helper = fileURLToPath(
  new URL(
    "../../apps/controller/src/drivers/repo/github/access/client/draft-pr.ts",
    import.meta.url,
  ),
);
const nativeChild = fileURLToPath(
  new URL("../fixtures/repository-credentials/native-draft-child.ts", import.meta.url),
);
const marker = "openshell:resolve:env:s" + "a".repeat(64) + "_GITHUB_TOKEN";
const unconfirmed =
  "Draft not confirmed. Check the pull requests at the repository; do not submit another create.";

type Reply = { status: number; body: JsonObject | string };
type OpenShellRunOptions = { port?: number; env?: NodeJS.ProcessEnv };

// Check raw and serialized output before any assertion can include it in diagnostics.
async function runHelper(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  secret: string,
  signal: AbortSignal,
) {
  const result: unknown = await run(process.execPath, args, {
    env: { PATH: process.env.PATH, ...env },
    allowFailure: true,
    timeout: 60_000,
    signal,
  });
  if (
    result === null ||
    typeof result !== "object" ||
    !("stdout" in result) ||
    typeof result.stdout !== "string" ||
    !("stderr" in result) ||
    typeof result.stderr !== "string" ||
    !("code" in result) ||
    typeof result.code !== "number" ||
    !Number.isInteger(result.code)
  ) {
    throw new Error("Draft CLI child returned an invalid process result");
  }
  if ((result.stdout + result.stderr).includes(secret) || JSON.stringify(result).includes(secret)) {
    throw new Error("Draft CLI child output contains a fixture credential");
  }
  const { code, stdout, stderr } = result;
  return { code, stdout, stderr, lines: stderr.trim().split("\n") };
}

function assertReceipt(stdout: string, expected: JsonObject, secret: string) {
  let receipt: unknown;
  try {
    receipt = parseUnambiguousJson(stdout);
  } catch {
    throw new Error("Draft CLI stdout must contain one unambiguous JSON receipt");
  }
  // Parsing can reveal a marker that was JSON-escaped in raw stdout.
  if (JSON.stringify(receipt).includes(secret)) {
    throw new Error("Draft CLI receipt contains a fixture credential");
  }
  assert.deepEqual(receipt, expected);
}

async function draftEndpoint(
  t: TestContext,
  tls: ServerOptions,
  observe: (request: IncomingMessage) => void,
) {
  let reply: Reply | undefined;
  let requestsWithoutReply = 0;
  const server = createHttpsServer(tls, async (req, res) => {
    observe(req);
    // Reply only after the client finishes sending the request body.
    await finished(req.resume(), { cleanup: true });
    if (reply === undefined) {
      requestsWithoutReply += 1;
      res.writeHead(500).end();
      return;
    }
    res.writeHead(reply.status, { "content-type": "application/json" });
    res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
  });
  const port = await listen(t, server);
  t.after(() => {
    assert.equal(requestsWithoutReply, 0, "the CLI must not send before a reply is configured");
  });
  return {
    port,
    replyWith(response: Reply) {
      reply = response;
    },
  };
}

// The fixture CA signs a leaf for api.github.com so the redirected CLI still verifies TLS.
async function githubLeaf(tls: Awaited<ReturnType<typeof harnessTlsFixture>>) {
  const { key, cert } = await signedLeaf(tls.directory, tls.authority, {
    name: "github",
    commonName: "api.github.com",
    subjectAltName: "DNS:api.github.com",
    days: 1,
    keyPem: undefined,
  });
  return { cert, key };
}

test(
  "oce-github pr-create names each failure class without secrets",
  { timeout: 60_000 },
  async (t) => {
    const tls = await harnessTlsFixture(t);
    let requests = 0;
    // This controlled peer supplies the responses seen through OpenShell mediation.
    const endpoint = await draftEndpoint(t, await githubLeaf(tls), () => {
      requests += 1;
    });
    // A released port could be taken by a parallel listener; this one refuses until released.
    const refusing = await refusingPort();
    t.after(() => refusing.release());
    const closedPort = refusing.port;

    const invoke = (
      args: readonly string[],
      { port = endpoint.port, env = {} }: OpenShellRunOptions = {},
    ) => {
      const redirect = `import tls from "node:tls";
const connect = tls.connect;
tls.connect = (options, ...rest) => connect({ ...options, host: "127.0.0.1", port: ${port} }, ...rest);`;
      return runHelper(
        ["--import", "data:text/javascript," + encodeURIComponent(redirect), helper, ...args],
        {
          HOME: tls.directory,
          TMPDIR: tls.directory,
          NODE_EXTRA_CA_CERTS: tls.rootCertificatePath,
          GITHUB_TOKEN: marker,
          OCE_OPENSHELL_GIT_REPOSITORY: "example/project",
          OCE_OPENSHELL_GIT_PUSH_REF: "refs/heads/review/task",
          OCE_OPENSHELL_GIT_BASE: "main",
          OCE_OPENSHELL_GIT_API_ORIGIN: "https://api.github.com",
          ...env,
        },
        marker,
        t.signal,
      );
    };
    const create = (options?: OpenShellRunOptions) =>
      invoke(
        [
          "pr-create",
          "--draft",
          "--head",
          "review/task",
          "--base",
          "main",
          "--title",
          "Review",
          "--body",
          "Body.",
        ],
        options,
      );
    const attempt = /^local draft attempt [0-9a-f-]{36}$/;

    // Usage errors send nothing and say how to call the helper.
    const help = await invoke(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage: oce-github pr-create --draft /);
    const usageCases: [string[], RegExp][] = [
      [
        ["pr-create", "--head", "review/task", "--base", "main", "--title", "x"],
        /^Missing --draft\.$/,
      ],
      [["pr-create", "--draft", "--repo", "dogfood/other"], /^Unknown option '--repo'/],
      [["pr-list"], /^The only command is pr-create\.$/],
    ];
    for (const [args, expected] of usageCases) {
      const result = await invoke(args);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.lines[0] ?? "", expected);
      assert.match(result.lines[1] ?? "", /^Usage: oce-github pr-create/);
      assert.doesNotMatch(result.stderr, /Draft not confirmed|local draft attempt/);
    }
    assert.equal(requests, 0);

    // A branch or base outside the binding is refused locally and names the admitted pair.
    const branch = await create({ env: { OCE_OPENSHELL_GIT_BASE: "develop" } });
    assert.equal(branch.code, 1);
    assert.deepEqual(branch.lines, [
      "Draft not sent: this Sandbox's repository binding allows only --head review/task --base develop.",
    ]);
    assert.equal(requests, 0);

    // Nothing to connect to: nothing was sent.
    const refused = await create({ port: closedPort });
    assert.equal(refused.code, 1);
    assert.match(refused.lines[0] ?? "", attempt);
    assert.equal(
      refused.lines[1] ?? "",
      "Draft not sent: could not connect to api.github.com (ECONNREFUSED).",
    );
    assert.equal(requests, 0);

    // The first attempt has an unknown outcome. A subsequent denial says only that
    // this request was not forwarded; it cannot confirm what happened to the first.
    endpoint.replyWith({ status: 502, body: { message: "Server Error" } });
    const beforeUnknown = requests;
    const unknown = await create();
    assert.equal(unknown.code, 1);
    assert.match(unknown.lines[0] ?? "", attempt);
    assert.deepEqual(unknown.lines.slice(1), [unconfirmed]);
    assert.equal(requests, beforeUnknown + 1, "unknown outcome must not trigger another request");

    endpoint.replyWith({
      status: 403,
      body: {
        error: "middleware_denied",
        middleware: "oce-prepared-git",
        reason_code: "draft_already_opened",
        layer: "l7",
      },
    });
    const beforeDenied = requests;
    const denied = await create();
    assert.equal(denied.code, 1);
    assert.match(denied.lines[0] ?? "", attempt);
    assert.equal(denied.lines.length, 2);
    assert.match(denied.lines[1] ?? "", /^Draft not created: .*draft-create allowance .*used/);
    assert.match(denied.lines[1] ?? "", /GitHub did not receive this request/);
    assert.match(denied.lines[1] ?? "", /whether the earlier attempt created a draft/);
    assert.match(denied.lines[1] ?? "", /do not submit another create/);
    assert.equal(requests, beforeDenied + 1, "spent allowance must not trigger another request");

    // Finding 2149: each worker refusal says what the Agent can do about it.
    const routeRefusals: [string, string | undefined][] = [
      [
        "request_not_allowed",
        "This repository binding does not allow this create; do not retry it. Ask an operator if the branch or base should change.",
      ],
      [
        "access_withdrawn",
        "Repository access for this Agent version has ended; do not retry. Ask an operator to bind the repository and deploy.",
      ],
      [
        "credential_unavailable",
        "The repository credential is unavailable; ask an operator to check the worker log before retrying.",
      ],
      [
        "route_blocked",
        "The repository route is closed for this Agent version; ask an operator to deploy a new version.",
      ],
      ["route_not_ready", "The repository route is not ready yet; retry in a minute."],
      // A code the helper does not know, including an inherited property name, adds nothing.
      ["constructor", undefined],
    ];
    const cases: [string, Reply, string][] = [
      [
        "route denial",
        {
          status: 403,
          body: {
            error: "middleware_denied",
            middleware: "oce-prepared-git",
            reason_code: "online_authorization_denied",
            layer: "l7",
          },
        },
        "Draft not created: the repository route refused it (online_authorization_denied); GitHub did not receive it. Retry once; if it is refused again, ask an operator to check the worker log.",
      ],
      ...routeRefusals.map(([code, advice]): [string, Reply, string] => [
        `route refusal ${code}`,
        {
          status: 403,
          body: {
            error: "middleware_denied",
            middleware: "oce-prepared-git",
            reason_code: code,
            layer: "l7",
          },
        },
        `Draft not created: the repository route refused it (${code}); GitHub did not receive it.${advice ? ` ${advice}` : ""}`,
      ]),
      [
        "route failure",
        { status: 503, body: { error: "middleware_failed", detail: "unavailable", layer: "l7" } },
        "Draft not created: the repository route could not check it; GitHub did not receive it. Ask an operator to check the worker.",
      ],
      [
        "GitHub validation",
        {
          status: 422,
          body: {
            message: "Validation Failed",
            errors: [{ message: "A pull request already exists for example:review/task." }],
          },
        },
        "Draft not created: GitHub answered 422: Validation Failed; A pull request already exists for example:review/task.",
      ],
      [
        "GitHub authentication",
        { status: 401, body: { message: "Bad credentials" } },
        "Draft not created: GitHub answered 401: Bad credentials. The repository credential was not accepted; ask an operator.",
      ],
      [
        "control characters in GitHub text",
        { status: 422, body: { message: "Bad\nnews\u0007" } },
        "Draft not created: GitHub answered 422: Bad news.",
      ],
      [
        "non-JSON GitHub reply",
        { status: 404, body: "Not Found" },
        "Draft not created: GitHub answered 404.",
      ],
      [
        "OpenShell L7 policy denial",
        { status: 403, body: { error: "policy_denied", layer: "l7" } },
        "Draft not created: OpenShell refused it (policy_denied); GitHub did not receive it.",
      ],
      // A response-phase block may follow a create GitHub already ran.
      [
        "response-phase middleware block",
        {
          status: 403,
          body: { error: "middleware_denied", reason_code: "x", layer: "http_response_pre_return" },
        },
        unconfirmed,
      ],
      [
        "many GitHub errors",
        {
          status: 422,
          body: {
            message: "Validation Failed",
            errors: Array.from({ length: 50 }, (_, i) => ({ message: `e${i}` })),
          },
        },
        "Draft not created: GitHub answered 422: Validation Failed; e0; e1; e2; e3; e4.",
      ],
      ["unconfirmed success", { status: 201, body: { number: 7, draft: false } }, unconfirmed],
    ];
    for (const [label, response, expected] of cases) {
      endpoint.replyWith(response);
      const before: number = requests;
      const result = await create();
      assert.equal(result.code, 1, label);
      assert.match(result.lines[0] ?? "", attempt, label);
      assert.deepEqual(result.lines.slice(1), [expected], label);
      assert.equal(requests, before + 1, `${label}: exactly one request`);
    }

    const canonical = (url: string, number: number, headName: string, baseName: string): Reply => ({
      status: 201,
      body: {
        number,
        html_url: url,
        state: "open",
        draft: true,
        head: { ref: "review/task", repo: { full_name: headName } },
        base: { ref: "main", repo: { full_name: baseName } },
      },
    });

    // GitHub may use its own spelling for the registry's lowercased repository name.
    const own = "Example/Project";
    const canonicalUrl = "https://github.com/Example/Project/pull/8";
    const successes: [string, number, string][] = [
      ["https://github.com/example/project/pull/7", 7, "example/project"],
      [canonicalUrl, 8, own],
    ];
    for (const [url, number, name] of successes) {
      endpoint.replyWith(canonical(url, number, name, name));
      const before: number = requests;
      const created = await create();
      assert.equal(created.code, 0, created.stderr);
      assert.equal(requests, before + 1, "accepted receipt: exactly one request");
      assertReceipt(
        created.stdout,
        {
          url,
          number,
          head: "review/task",
          base: "main",
          draft: true,
        },
        marker,
      );
    }

    // A receipt still has to match the host, number, and both repositories.
    const mismatches: [string, Reply][] = [
      ["url", canonical("https://github.com/Example/Other/pull/8", 8, own, own)],
      ["url number", canonical("https://github.com/Example/Project/pull/9", 8, own, own)],
      ["url host", canonical("https://github.org/Example/Project/pull/8", 8, own, own)],
      ["head", canonical(canonicalUrl, 8, "Example/Other", own)],
      ["base", canonical(canonicalUrl, 8, own, "Example/Other")],
    ];
    for (const [label, response] of mismatches) {
      endpoint.replyWith(response);
      const before: number = requests;
      const other = await create();
      assert.equal(other.code, 1, label);
      assert.deepEqual(other.lines.slice(1), [unconfirmed], label);
      assert.equal(requests, before + 1, `${label}: exactly one request`);
    }
  },
);

// Native broker mode (finding 2410): a code the broker answers before any send to GitHub
// says "Draft not created"; an uncertain exchange, an unknown outcome receipt or a code
// the helper does not know may follow a create, so it says "Draft not confirmed".
test(
  "oce-github pr-create tells native broker refusals from unknown outcomes",
  { timeout: 60_000 },
  async (t) => {
    const tls = await harnessTlsFixture(t);
    const operationId = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";
    const bearer = "b".repeat(43);
    const received: { operationId: string | string[] | undefined; bearer: boolean }[] = [];
    // This controlled peer records the broker-bound credential and operation ID.
    const endpoint = await draftEndpoint(t, { cert: tls.cert, key: tls.key }, (req) => {
      received.push({
        operationId: req.headers["x-oce-operation-id"],
        bearer: req.headers.authorization === "Bearer " + bearer,
      });
    });
    const origin = "https://localhost:" + endpoint.port;
    const { root } = await createNativeClientMaterial(
      t,
      [
        {
          repositoryRef: "source",
          opened: {
            bearer,
            session: {
              sessionId: "draft-session",
              deadlineWallMs: Date.now() + 600_000,
              state: "OPEN",
              binding: {
                providerInstanceId: "fixture",
                repositoryId: "example/project",
                grantId: "draft-grant",
              },
              activeUses: 0,
              cleanup: {
                active: 0,
                pending: 0,
                revoked: 0,
                expired: 0,
                uncertain: 0,
                auxiliaryPending: false,
              },
            },
            client: {
              gatewayOrigin: origin,
              gitRemote: origin + "/example/project.git",
              gitUsername: "gateway-session",
              apiHost: "localhost",
              canonicalApiHost: "localhost",
              repository: "example/project",
            },
          },
        },
      ],
      { ca: Buffer.from(tls.caBundle) },
    );
    // Run the real CLI with a test-owned manifest root.
    const create = () =>
      runHelper(
        [
          nativeChild,
          root,
          "pr-create",
          "--operation-id",
          operationId,
          "--draft",
          "--head",
          "review/task",
          "--base",
          "main",
          "--title",
          "Review",
        ],
        { HOME: tls.directory, TMPDIR: tls.directory },
        bearer,
        t.signal,
      );
    const attempt = "draft pull operation " + operationId;
    const receipt = {
      operationId,
      state: "open",
      draft: true,
      number: 3,
      url: "https://github.com/example/project/pull/3",
      head: { ref: "review/task" },
      base: { ref: "main" },
    };
    endpoint.replyWith({ status: 201, body: receipt });
    const created = await create();
    assert.equal(created.code, 0, created.stderr);
    assertReceipt(created.stdout, receipt, bearer);
    assert.deepEqual(received, [{ operationId, bearer: true }]);

    const refused = (code: string, advice?: string) =>
      `Draft not created: the repository broker refused it (${code}); GitHub did not receive it.${advice ? ` ${advice}` : ""}`;
    const cases: [string, Reply, string[]][] = [
      [
        "not-submitted receipt",
        { status: 409, body: { operationId, error: "not-submitted" } },
        [
          "Draft not created: the repository broker recorded this operation as not sent (not-submitted); GitHub did not receive it.",
        ],
      ],
      [
        "outcome_unknown receipt",
        { status: 409, body: { operationId, error: "outcome_unknown" } },
        ["draft pull outcome_unknown", unconfirmed],
      ],
      [
        "uncertain exchange",
        { status: 502, body: { error: { code: "exchange-uncertain" } } },
        [unconfirmed],
      ],
      [
        "unknown broker code",
        { status: 403, body: { error: { code: "new-code" } } },
        [unconfirmed],
      ],
      [
        "receipt for another operation",
        { status: 201, body: { ...receipt, operationId: "2a416976-948c-45af-9127-20bf465a370c" } },
        [unconfirmed],
      ],
      [
        "closed session",
        { status: 401, body: { error: { code: "session-unavailable" } } },
        [
          refused(
            "session-unavailable",
            "The repository session for this Agent version is not open; if a retry is refused too, ask an operator to check the repository binding.",
          ),
        ],
      ],
      [
        "exchange capacity",
        { status: 503, body: { error: { code: "exchange-capacity" } } },
        [
          refused(
            "exchange-capacity",
            "Too many repository requests are running, for this Agent or across the broker; retry after a short wait.",
          ),
        ],
      ],
      [
        "route denial",
        { status: 403, body: { error: { code: "route-denied" } } },
        [refused("route-denied")],
      ],
    ];
    for (const [label, response, expected] of cases) {
      endpoint.replyWith(response);
      const before: number = received.length;
      const result = await create();
      assert.equal(result.code, 1, label);
      assert.deepEqual(result.lines, [attempt, ...expected], label);
      assert.equal(received.length, before + 1, `${label}: exactly one request`);
    }
  },
);
