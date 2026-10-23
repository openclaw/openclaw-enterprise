import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { harnessTlsFixture } from "../helpers/harness-tls.mjs";

// `oce-github pr-create` in OpenShell mode: each failure class prints its own line, so an
// Agent or operator can tell a usage error, a local refusal, a route denial, a GitHub
// refusal and an unconfirmed outcome apart (finding 2134). Only the last one may have
// created a draft, so only it says to check GitHub before anything else.
const helper = fileURLToPath(
  new URL(
    "../../apps/controller/src/drivers/repo/github/credentials/client/draft-pr.ts",
    import.meta.url,
  ),
);
const marker = "openshell:resolve:env:s" + "a".repeat(64) + "_GITHUB_TOKEN";
const unconfirmed =
  "Draft not confirmed. Check the pull requests at the repository; do not submit another create.";

async function githubLeaf(tls) {
  const openssl = (...args) => {
    const result = spawnSync("openssl", args, { cwd: tls.directory, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  };
  await writeFile(
    join(tls.directory, "github.ext"),
    "basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:api.github.com\n",
  );
  openssl(
    "req",
    "-new",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    "github.key",
    "-out",
    "github.csr",
    "-subj",
    "/CN=api.github.com",
  );
  openssl(
    "x509",
    "-req",
    "-in",
    "github.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-days",
    "1",
    "-out",
    "github.pem",
    "-extfile",
    "github.ext",
  );
  return {
    cert: await readFile(join(tls.directory, "github.pem")),
    key: await readFile(join(tls.directory, "github.key")),
  };
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
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => server.close());
    const closed = createServer().listen(0, "127.0.0.1");
    await once(closed, "listening");
    const closedPort = closed.address().port;
    closed.close();
    await once(closed, "close");

    const run = (args, { port = server.address().port, env = {} } = {}) =>
      new Promise((resolve, reject) => {
        const redirect = `import tls from "node:tls";
const connect = tls.connect;
tls.connect = (options, ...rest) => connect({ ...options, host: "127.0.0.1", port: ${port} }, ...rest);`;
        const child = spawn(
          process.execPath,
          ["--import", "data:text/javascript," + encodeURIComponent(redirect), helper, ...args],
          {
            env: {
              PATH: process.env.PATH,
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
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => {
          assert.ok(!(stdout + stderr).includes(marker), "the credential marker is never printed");
          resolve({ code, stdout, stderr, lines: stderr.trim().split("\n") });
        });
      });
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
      // Finding 2147: the grant's one draft create was already used, by any version or Agent.
      [
        "draft already opened",
        {
          status: 403,
          body: {
            error: "middleware_denied",
            middleware: "oce-prepared-git",
            reason_code: "draft_already_opened",
            layer: "l7",
          },
        },
        "Draft not created: this repository binding already opened its draft pull request (one per review branch and base); GitHub did not receive this one. Find the earlier draft at GitHub; for another draft, ask an operator for a new review branch.",
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
      ["GitHub server error", { status: 502, body: { message: "Server Error" } }, unconfirmed],
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
