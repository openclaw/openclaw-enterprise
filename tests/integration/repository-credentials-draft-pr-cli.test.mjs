import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNativeClientMaterial } from "../fixtures/repository-credentials/clients.mjs";
import { refusingPort } from "../helpers/available-port.mjs";
import { signedLeaf } from "../helpers/certificates.mjs";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";
import { listen } from "../helpers/listen.mjs";

// `oce-github pr-create` in OpenShell mode: each failure class prints its own line, so an
// Agent or operator can tell a usage error, a local refusal, a route denial, a GitHub
// refusal and an unconfirmed outcome apart (finding 2134). A denied request cannot
// establish the outcome of an earlier attempt.
const helper = fileURLToPath(
  new URL(
    "../../apps/controller/src/drivers/repo/github/credentials/client/draft-pr.ts",
    import.meta.url,
  ),
);
const marker = "openshell:resolve:env:s" + "a".repeat(64) + "_GITHUB_TOKEN";
const unconfirmed =
  "Draft not confirmed. Check the pull requests at the repository; do not submit another create.";

// Runs the helper with only PATH and `env`; `secret` (its credential) must never be printed.
function runHelper(args, env, secret) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      assert.ok(!(stdout + stderr).includes(secret), "the credential is never printed");
      resolve({ code, stdout, stderr, lines: stderr.trim().split("\n") });
    });
  });
}

// A server leaf for api.github.com signed by the Harness fixture CA, so the helper's
// configured root trusts it.
async function githubLeaf(tls) {
  const { key, cert } = await signedLeaf(tls.directory, tls.authority, {
    name: "github",
    commonName: "api.github.com",
    subjectAltName: "DNS:api.github.com",
    days: 1,
  });
  return { cert, key };
}

test(
  "oce-github pr-create names each failure class without secrets",
  { timeout: 60_000 },
  async (t) => {
    const tls = await harnessTlsFixture(t);
    let reply;
    let requests = 0;
    // Stands in for OpenShell's mediation and GitHub: answers each create with `reply`.
    const server = createHttpsServer(await githubLeaf(tls), async (req, res) => {
      requests += 1;
      for await (const _ of req) {
        // Drain the request body.
      }
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body));
    });
    await listen(t, server);
    // A released port could be taken by a parallel listener; this one refuses until released.
    const refusing = await refusingPort();
    t.after(() => refusing.release());
    const closedPort = refusing.port;

    const run = (args, { port = server.address().port, env = {} } = {}) => {
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
      );
    };
    const create = (extra = [], options) =>
      run(
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
          ...extra,
        ],
        options,
      );
    const attempt = /^local draft attempt [0-9a-f-]{36}$/;

    // Usage errors send nothing and say how to call the helper.
    const help = await run(["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /^Usage: oce-github pr-create --draft /);
    for (const [args, expected] of [
      [
        ["pr-create", "--head", "review/task", "--base", "main", "--title", "x"],
        /^Missing --draft\.$/,
      ],
      [["pr-create", "--draft", "--repo", "dogfood/other"], /^Unknown option '--repo'/],
      [["pr-list"], /^The only command is pr-create\.$/],
    ]) {
      const result = await run(args);
      assert.equal(result.code, 2, result.stderr);
      assert.match(result.lines[0], expected);
      assert.match(result.lines[1], /^Usage: oce-github pr-create/);
      assert.doesNotMatch(result.stderr, /Draft not confirmed|local draft attempt/);
    }
    assert.equal(requests, 0);

    // A branch or base outside the binding is refused locally and names the admitted pair.
    const branch = await create([], { env: { OCE_OPENSHELL_GIT_BASE: "develop" } });
    assert.equal(branch.code, 1);
    assert.deepEqual(branch.lines, [
      "Draft not sent: this Sandbox's repository binding allows only --head review/task --base develop.",
    ]);
    assert.equal(requests, 0);

    // Nothing to connect to: nothing was sent.
    const refused = await create([], { port: closedPort });
    assert.equal(refused.code, 1);
    assert.match(refused.lines[0], attempt);
    assert.equal(
      refused.lines[1],
      "Draft not sent: could not connect to api.github.com (ECONNREFUSED).",
    );

    // The first attempt has an unknown outcome. A subsequent denial says only that
    // this request was not forwarded; it cannot confirm what happened to the first.
    reply = { status: 502, body: { message: "Server Error" } };
    const beforeUnknown = requests;
    const unknown = await create();
    assert.equal(unknown.code, 1);
    assert.match(unknown.lines[0], attempt);
    assert.deepEqual(unknown.lines.slice(1), [unconfirmed]);
    assert.equal(requests, beforeUnknown + 1, "unknown outcome must not trigger another request");

    reply = {
      status: 403,
      body: {
        error: "middleware_denied",
        middleware: "oce-prepared-git",
        reason_code: "draft_already_opened",
        layer: "l7",
      },
    };
    const beforeDenied = requests;
    const denied = await create();
    assert.equal(denied.code, 1);
    assert.match(denied.lines[0], attempt);
    assert.equal(denied.lines.length, 2);
    assert.match(denied.lines[1], /^Draft not created: .*draft-create allowance .*used/);
    assert.match(denied.lines[1], /GitHub did not receive this request/);
    assert.match(denied.lines[1], /whether the earlier attempt created a draft/);
    assert.match(denied.lines[1], /do not submit another create/);
    assert.equal(requests, beforeDenied + 1, "spent allowance must not trigger another request");

    const cases = [
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
      // Finding 2149: each worker refusal says what the Agent can do about it.
      ...[
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
      ].map(([code, advice]) => [
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
      reply = response;
      const before = requests;
      const result = await create();
      assert.equal(result.code, 1, label);
      assert.match(result.lines[0], attempt, label);
      assert.deepEqual(result.lines.slice(1), [expected], label);
      assert.equal(requests, before + 1, `${label}: exactly one request`);
    }

    reply = {
      status: 201,
      body: {
        number: 7,
        html_url: "https://github.com/example/project/pull/7",
        state: "open",
        draft: true,
        head: { ref: "review/task", repo: { full_name: "example/project" } },
        base: { ref: "main", repo: { full_name: "example/project" } },
      },
    };
    const created = await create();
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(JSON.parse(created.stdout), {
      url: "https://github.com/example/project/pull/7",
      number: 7,
      head: "review/task",
      base: "main",
      draft: true,
    });

    // The registry delivers a lowercased name; GitHub answers with the repository's own
    // spelling (finding 2232). That is the same draft; another repository is not.
    const own = "Example/Project";
    const canonical = (url, headName = own, baseName = own) => ({
      status: 201,
      body: {
        number: 8,
        html_url: url,
        state: "open",
        draft: true,
        head: { ref: "review/task", repo: { full_name: headName } },
        base: { ref: "main", repo: { full_name: baseName } },
      },
    });
    reply = canonical("https://github.com/Example/Project/pull/8");
    const spelled = await create();
    assert.equal(spelled.code, 0, spelled.stderr);
    assert.deepEqual(JSON.parse(spelled.stdout), {
      url: "https://github.com/Example/Project/pull/8",
      number: 8,
      head: "review/task",
      base: "main",
      draft: true,
    });
    for (const [label, response] of [
      ["url", canonical("https://github.com/Example/Other/pull/8")],
      ["url number", canonical("https://github.com/Example/Project/pull/9")],
      ["url host", canonical("https://github.org/Example/Project/pull/8")],
      ["head", canonical("https://github.com/Example/Project/pull/8", "Example/Other")],
      ["base", canonical("https://github.com/Example/Project/pull/8", own, "Example/Other")],
    ]) {
      reply = response;
      const other = await create();
      assert.equal(other.code, 1, `another repository in ${label}`);
      assert.deepEqual(other.lines.slice(1), [unconfirmed], `another repository in ${label}`);
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
    let reply;
    const received = [];
    // Stands in for the repository broker: answers each create with `reply`.
    const server = createHttpsServer({ cert: tls.cert, key: tls.key }, async (req, res) => {
      received.push({
        operationId: req.headers["x-oce-operation-id"],
        bearer: req.headers.authorization === "Bearer " + bearer,
      });
      for await (const _ of req) {
        // Drain the request body.
      }
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
    await listen(t, server);
    const origin = "https://localhost:" + server.address().port;
    const { root } = await createNativeClientMaterial(
      t,
      [
        {
          repositoryRef: "source",
          opened: {
            bearer,
            session: { sessionId: "draft-session", deadlineWallMs: Date.now() + 600_000 },
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
    // The broker shell's entry: the helper reads this manifest root instead of the Pod's.
    const entry =
      "import {createDraftPull,draftPullFailureMessage} from " +
      JSON.stringify(pathToFileURL(helper).href) +
      "; await createDraftPull(process.argv.slice(2),process.argv[1]).catch((e)=>" +
      "{const f=draftPullFailureMessage(e);process.stderr.write(f.message+'\\n');process.exitCode=f.exitCode;});";
    const create = () =>
      runHelper(
        [
          "--input-type=module",
          "-e",
          entry,
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
    reply = { status: 201, body: receipt };
    const created = await create();
    assert.equal(created.code, 0, created.stderr);
    assert.deepEqual(JSON.parse(created.stdout), receipt);
    assert.deepEqual(received, [{ operationId, bearer: true }]);

    const refused = (code, advice) =>
      `Draft not created: the repository broker refused it (${code}); GitHub did not receive it.${advice ? ` ${advice}` : ""}`;
    for (const [label, response, expected] of [
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
        { status: 201, body: { ...receipt, operationId: "x" } },
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
    ]) {
      reply = response;
      const before = received.length;
      const result = await create();
      assert.equal(result.code, 1, label);
      assert.deepEqual(result.lines, [attempt, ...expected], label);
      assert.equal(received.length, before + 1, `${label}: exactly one request`);
    }
  },
);
