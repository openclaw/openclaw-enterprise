import assert from "node:assert/strict";
import test from "node:test";
import {
  GIT_STEPS,
  gitAnswerFor,
  gitCommand,
  gitOutcome,
  gitPlan,
  gitPromptFor,
} from "../../deploy/examples/strands-box/git/controlled-git-model.ts";

const nonce = "a1".repeat(24);
const plan = gitPlan({
  repository: "example/review",
  otherRepository: "example/other",
  branch: "review/agent",
  otherRef: "not-assigned",
  base: "main",
});

test("the scripted dry-run model asks only for stock git and gh against GitHub's canonical URLs", () => {
  for (const step of GIT_STEPS) {
    const command = gitCommand(plan, nonce, step);
    assert.doesNotMatch(
      command,
      /insteadOf|credential\.|helper|askpass|auth login|token=|\/draft-pull/i,
    );
    for (const url of command.match(/https:\/\/[^\s]+/g) ?? []) {
      assert.match(url, /^https:\/\/github\.com\/example\/(?:review|other)\.git$/);
    }
    assert.ok(
      gitPromptFor(nonce, step).endsWith(`${step}: run the operator-scripted repository step.`),
    );
  }
  assert.match(
    gitCommand(plan, nonce, "push"),
    /git -C \/home\/node\/workspace\/x5-[0-9a-f]{12} push https:\/\/github\.com\/example\/review\.git HEAD:refs\/heads\/review\/agent/,
  );
  // Finding 3318: in Box a host binary does not start where the shell's `cd` went, so every git
  // call names its repository and no step relies on `cd` for git or gh.
  for (const step of GIT_STEPS) {
    const command = gitCommand(plan, nonce, step);
    assert.doesNotMatch(command, /(?:^|&& |; )cd /, step);
    for (const call of command.match(/(?:^|&& |; |\| )git [^|&;]*/g) ?? []) {
      assert.match(
        call,
        /git (?:-C \/home\/node\/workspace\/x5-[0-9a-f]{12} |clone |ls-remote |config --list)/,
        `${step}: ${call}`,
      );
    }
  }
  assert.match(
    gitCommand(plan, nonce, "draft"),
    /gh pr create --draft --repo example\/review --head review\/agent --base main/,
  );
  // The placeholder step prints digests and lengths, never a variable's value.
  const placeholders = gitCommand(plan, nonce, "placeholders");
  assert.match(placeholders, /printf %s "\$v" \| sha256sum \| cut -c1-16/);
  assert.equal(placeholders.split('"$v"').length, 3, "the value is only tested and hashed");
  assert.doesNotMatch(placeholders, /echo "?\$v|\$GITHUB_TOKEN/);
  assert.throws(() => gitPlan({ ...plan, repository: "example/review; curl x" }), {
    message: "Use plain repository names and branch names.",
  });
  assert.throws(() => gitPlan({ ...plan, branch: "a/../b" }), {
    message: "Use plain repository names and branch names.",
  });
  assert.throws(() => gitPlan({ ...plan, otherRepository: plan.repository }), {
    message: "Use plain repository names and branch names.",
  });
});

test("the dry-run result line carries the exit code and Box's refusal code only", () => {
  const output = [
    "Wall time: 0.4100 seconds",
    "Process exited with code 128",
    "Output:",
    "remote: credential refused by its source: request_not_allowed",
  ].join("\n");
  assert.deepEqual(gitOutcome(output), { exit: 128, refusal: "request_not_allowed" });
  assert.equal(
    gitAnswerFor(nonce, "other-repository", gitOutcome(output)),
    `BOX_GIT_REPRO_RESULT ${nonce} other-repository exit=128 refusal=request_not_allowed`,
  );
  assert.equal(gitOutcome("no header"), undefined);
  assert.equal(
    gitAnswerFor(nonce, "push", undefined),
    `BOX_GIT_REPRO_RESULT ${nonce} push unparsed`,
  );
});

test("only the latest user prompt picks a step; an ordinary follow-up gets a plain reply", async () => {
  const { controlledGitModelRequests, gitPromptFor: promptFor } =
    await import("../../deploy/examples/strands-box/git/controlled-git-model.ts");
  const rows: Record<string, unknown>[] = [];
  const handler = controlledGitModelRequests(nonce, plan, (row) => rows.push(row), {
    address: "10.0.0.9",
    authorization: "Bearer marker",
  });
  const call = async (input: unknown[]) => {
    const body = Buffer.from(
      JSON.stringify({ model: "gpt-5", input, tools: [{ name: "exec_command" }] }),
    );
    const req = Object.assign(
      (async function* () {
        yield body;
      })(),
      {
        socket: { remoteAddress: "10.0.0.9" },
        method: "POST",
        url: "/v1/responses",
        headers: { authorization: "Bearer marker" },
      },
    );
    let text = "";
    let status = 200;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        return { end() {} };
      },
      setHeader() {},
      write(chunk: string) {
        text += chunk;
        return true;
      },
      end(chunk?: string) {
        if (chunk) {
          text += chunk;
        }
      },
      destroy() {},
    };
    await handler(req as never, res as never);
    return { status, text };
  };
  const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });
  const first = await call([
    user("<environment_context>x</environment_context>"),
    user(promptFor(nonce, "push")),
  ]);
  assert.equal(first.status, 200);
  assert.match(first.text, /exec_command/);
  assert.deepEqual(
    rows.map((row) => [row.stage, row.step]),
    [["tool_intent", "push"]],
  );
  const later = await call([
    user(promptFor(nonce, "push")),
    user("ordinary message after withdrawal"),
  ]);
  assert.equal(later.status, 200);
  assert.doesNotMatch(later.text, /exec_command/);
  assert.match(later.text, /READY/);
  assert.equal(rows.length, 1);
});

test("the admission checks: one permitted program and tamper lists decided command by command", () => {
  assert.equal(gitCommand(plan, nonce, "verifier"), "/opt/demo/verifier/oce-workspace-verifier");
  for (const step of [
    "tamper-config",
    "tamper-credential",
    "tamper-interpreter",
    "tamper-forge",
  ] as const) {
    const parts = gitCommand(plan, nonce, step).split("; ");
    assert.ok(parts.length >= 3, step);
    assert.equal(parts.at(-1), `echo ${step}-a1a1a1a1a1a1`);
  }
  assert.match(
    gitCommand(plan, nonce, "tamper-credential"),
    /rm \/home\/node\/\.oce-native-hooks\/\*\.json; /,
  );
  assert.match(gitCommand(plan, nonce, "tamper-credential"), /ln -s /);
  assert.match(
    gitCommand(plan, nonce, "tamper-forge"),
    /--event permission_request --timeout 5000 <<< /,
  );
});

test("the hook checks: a marker write and one no-progress call the dry-run model repeats", () => {
  assert.match(
    gitCommand(plan, nonce, "touch"),
    /^printf '%s\\n' (?:a1)+ > \/home\/node\/workspace\/x5-touch-a1a1a1a1a1a1\.txt && echo wrote$/,
  );
  assert.equal(gitCommand(plan, nonce, "gateway-loop"), "printf x5-loop-a1a1a1a1a1a1");
});

test("the outside-write step uses Codex's own patch tool to add one file under the Harness home", async () => {
  const { controlledGitModelRequests, OUTSIDE_WRITE_PATH, outsideWritePatch } =
    await import("../../deploy/examples/strands-box/git/controlled-git-model.ts");
  assert.equal(OUTSIDE_WRITE_PATH, "/home/node/outside-workspace-check.txt");
  const patch = outsideWritePatch(nonce);
  assert.equal(
    patch,
    `*** Begin Patch\n*** Add File: /home/node/outside-workspace-check.txt\n+x5 outside-workspace check a1a1a1a1a1a1\n*** End Patch\n`,
  );
  assert.doesNotMatch(patch, /\.codex|\.oce-native-hooks|\/workspace\//);
  // Without an apply_patch tool, the shell's apply_patch (which Codex intercepts) is the fallback.
  assert.equal(gitCommand(plan, nonce, "outside-write"), `apply_patch <<'EOF'\n${patch}EOF`);
  const rows: Record<string, unknown>[] = [];
  const handler = controlledGitModelRequests(nonce, plan, (row) => rows.push(row), {
    address: "10.0.0.9",
  });
  const call = async (tools: unknown[]) => {
    const body = Buffer.from(
      JSON.stringify({
        model: "gpt-5",
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: gitPromptFor(nonce, "outside-write") }],
          },
        ],
        tools,
      }),
    );
    const req = Object.assign(
      (async function* () {
        yield body;
      })(),
      { socket: { remoteAddress: "10.0.0.9" }, method: "POST", url: "/v1/responses", headers: {} },
    );
    let text = "";
    const res = {
      headersSent: false,
      writeHead: () => ({ end() {} }),
      setHeader() {},
      write: (chunk: string) => ((text += chunk), true),
      end: (chunk?: string) => void (chunk && (text += chunk)),
      destroy() {},
    };
    await handler(req as never, res as never);
    return text;
  };
  const custom = await call([{ name: "exec_command" }, { type: "custom", name: "apply_patch" }]);
  assert.match(custom, /custom_tool_call/);
  assert.match(custom, /apply_patch/);
  const fn = await call([{ name: "exec_command" }, { type: "function", name: "apply_patch" }]);
  assert.match(fn, /"name\\?":\\?"apply_patch\\?"/);
  const shell = await call([{ name: "exec_command" }]);
  assert.match(shell, /exec_command/);
  assert.deepEqual(
    rows.map((row) => row.via),
    ["apply_patch:custom", "apply_patch:function", "exec_command"],
  );
});

test("with key digests the dry-run model accepts only those bearers and records each digest, never a key", async () => {
  const { createHash } = await import("node:crypto");
  const { bearerDigest, controlledGitModelRequests } =
    await import("../../deploy/examples/strands-box/git/controlled-git-model.ts");
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  const key = `sk-test-${"k".repeat(40)}`;
  const rotated = `sk-test-${"r".repeat(40)}`;
  assert.equal(bearerDigest(`Bearer ${key}`), sha(key));
  assert.equal(bearerDigest(`token ${key}`), null);
  assert.equal(bearerDigest(undefined), null);
  const requests: Record<string, unknown>[] = [];
  const handler = controlledGitModelRequests(nonce, plan, () => {}, {
    address: "10.0.0.9",
    bearerSha256: [sha(key), sha(rotated)],
    requests: (row) => requests.push(row),
  });
  const call = async (authorization: string | undefined, url = "/v1/responses") => {
    const body = Buffer.from(
      JSON.stringify({
        model: "gpt-5",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        tools: [{ name: "exec_command" }],
      }),
    );
    const req = Object.assign(
      (async function* () {
        yield body;
      })(),
      {
        socket: { remoteAddress: "10.0.0.9" },
        method: "POST",
        url,
        headers: authorization === undefined ? {} : { authorization },
      },
    );
    let status = 200;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        return { end() {} };
      },
      setHeader() {},
      write: () => true,
      end() {},
      destroy() {},
    };
    await handler(req as never, res as never);
    return status;
  };
  assert.equal(await call(`Bearer ${key}`), 200);
  assert.equal(await call(`Bearer ${rotated}`), 200);
  assert.equal(await call("Bearer marker"), 404, "the public marker is not a key");
  assert.equal(await call(`Bearer ${key}x`), 404);
  assert.equal(await call(undefined), 404);
  assert.equal(await call(`Bearer ${key}`, "/v1/chat/completions"), 404, "only the Responses path");
  assert.deepEqual(
    requests.map((row) => [row.path, row.bearerSha256, row.authorized]),
    [
      ["/v1/responses", sha(key), true],
      ["/v1/responses", sha(rotated), true],
      ["/v1/responses", sha("marker"), false],
      ["/v1/responses", sha(`${key}x`), false],
      ["/v1/responses", null, false],
      ["/v1/chat/completions", sha(key), true],
    ],
  );
  const recorded = JSON.stringify(requests);
  assert.ok(!recorded.includes(key) && !recorded.includes(rotated), "only digests are recorded");
});

test("the model-sibling step posts only to the planned URLs, with the placeholder by reference", () => {
  assert.match(gitCommand(plan, nonce, "model-sibling"), /^echo model-sibling-unplanned-/);
  assert.match(
    gitCommand(plan, nonce, "delayed-git"),
    /^sleep 25; git ls-remote https:\/\/github\.com\/example\/review\.git 2>&1 \| tail -2; echo delayed-git-a1a1a1a1a1a1$/,
  );
  const siblings = [
    "https://model.example.test:8444/v1/responses",
    "https://model.example.test:8444/route/v1/responses/x",
  ];
  const command = gitCommand(gitPlan({ ...plan, modelSiblings: siblings }), nonce, "model-sibling");
  for (const url of siblings) {
    assert.equal(command.split(` ${url}`).length, 3, "printed and posted once");
  }
  assert.deepEqual([...new Set(command.match(/https:\/\/[^\s"]+/g))].sort(), [...siblings].sort());
  assert.match(command, /-H "Authorization: Bearer \$k"/);
  assert.match(command, /-o \/dev\/null/);
  // The placeholder appears only in the case test and the Authorization headers.
  assert.equal(command.match(/\$k\b/g)?.length, 1 + siblings.length);
  assert.equal(command.split('"$k"').length, 2);
  assert.equal(command.split('Bearer $k"').length, 1 + siblings.length);
  for (const bad of [
    ["http://model.example.test:8444/v1/responses"],
    ["https://model.example.test/v1/responses"],
    ["https://model.example.test:8444/v1/responses?x=1"],
    ["https://model.example.test:8444/v1/$(id)"],
    ["https://model.example.test:8444/a/../v1"],
    [],
    Array(9).fill(siblings[0]),
  ]) {
    assert.throws(() => gitPlan({ ...plan, modelSiblings: bad }), {
      message: "modelSiblings must list one to eight plain https URLs.",
    });
  }
});

test("with a path prefix the dry-run model also serves the Responses path below it, and nothing next to it", async () => {
  const { createHash } = await import("node:crypto");
  const { controlledGitModelRequests } =
    await import("../../deploy/examples/strands-box/git/controlled-git-model.ts");
  const key = `sk-test-${"p".repeat(40)}`;
  const sha = createHash("sha256").update(key).digest("hex");
  const rows: Record<string, unknown>[] = [];
  const peer = {
    address: "10.0.0.9",
    bearerSha256: [sha],
    requests: (row: Record<string, unknown>) => rows.push(row),
  };
  for (const bad of ["route", "/route/", "/a//b", "/../v1", "/%2e", "/a/b/c/d/e"]) {
    assert.throws(
      () => controlledGitModelRequests(nonce, plan, () => {}, { ...peer, pathPrefix: bad }),
      { message: "pathPrefix must be plain path segments." },
    );
  }
  const handler = controlledGitModelRequests(nonce, plan, () => {}, {
    ...peer,
    pathPrefix: "/route",
  });
  const call = async (url: string) => {
    const body = Buffer.from(
      JSON.stringify({ model: "gpt-5", input: [{ role: "user", content: "hello" }] }),
    );
    const req = Object.assign(
      (async function* () {
        yield body;
      })(),
      {
        socket: { remoteAddress: "10.0.0.9" },
        method: "POST",
        url,
        headers: { authorization: `Bearer ${key}` },
      },
    );
    let status = 200;
    const res = {
      headersSent: false,
      writeHead(code: number) {
        status = code;
        return { end() {} };
      },
      setHeader() {},
      write: () => true,
      end() {},
      destroy() {},
    };
    await handler(req as never, res as never);
    return status;
  };
  assert.equal(await call("/route/v1/responses"), 200);
  assert.equal(await call("/v1/responses"), 200);
  for (const sibling of [
    "/route/v1/responses/x",
    "/routex/v1/responses",
    "/route/v2/responses",
    "/other/v1/responses",
    "/route/v1/responses?x=1",
  ]) {
    assert.equal(await call(sibling), 404, sibling);
  }
  assert.deepEqual(
    rows.map((row) => [row.path, row.bearerSha256 === sha]),
    [
      ["/route/v1/responses", true],
      ["/v1/responses", true],
      ["/route/v1/responses/x", true],
      ["/routex/v1/responses", true],
      ["/route/v2/responses", true],
      ["/other/v1/responses", true],
      ["/route/v1/responses?x=1", true],
    ],
  );
  assert.ok(!JSON.stringify(rows).includes(key));
});
