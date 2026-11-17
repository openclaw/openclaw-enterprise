// Test fixture, not a model: a scripted Responses endpoint for the installed protected dry run.
// Each prompt names one operator-scripted repository step; the fixture answers it with exactly one
// stock-shell tool call (`git` or `gh` against GitHub's canonical URLs, nothing custom) and then a
// fixed result line built from the tool's exit code and Box's refusal code. Values never pass
// through it: the placeholder step prints only digests and lengths of the workload's variables.
//
//   node controlled-git-model.ts <config.json>
//   config: { address, port, boxAddress, certificate, key, runDirectory, nonce, plan }
//   plan:   { repository, otherRepository, branch, otherRef, base }
import { appendFileSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROLLED_INFERENCE_MARKER } from "../host/egress.ts";
import { fields, object, privateDirectory, readConfig, string } from "../host/launch.ts";
import { isNonce, reply } from "../ordinary-chat/box-workload.ts";

export const GIT_ACTION = "BOX_GIT_REPRO_V1";
export const GIT_RESULT = "BOX_GIT_REPRO_RESULT";
export const GIT_STEPS = [
  "push",
  "draft",
  "placeholders",
  "other-repository",
  "other-repository-api",
  "other-ref",
  "after-withdrawal",
  "worker-down",
] as const;
export type GitStep = (typeof GIT_STEPS)[number];
export interface GitPlan {
  readonly repository: string;
  readonly otherRepository: string;
  readonly branch: string;
  readonly otherRef: string;
  readonly base: string;
}
const model = "gpt-5";
const WORKSPACE = "/home/node/workspace";
const REPOSITORY = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

export function gitPlan(value: unknown): GitPlan {
  const data = object(value);
  fields(data, ["repository", "otherRepository", "branch", "otherRef", "base"]);
  const plan = {
    repository: string(data.repository),
    otherRepository: string(data.otherRepository),
    branch: string(data.branch),
    otherRef: string(data.otherRef),
    base: string(data.base),
  };
  if (
    !REPOSITORY.test(plan.repository) ||
    !REPOSITORY.test(plan.otherRepository) ||
    plan.repository === plan.otherRepository ||
    ![plan.branch, plan.otherRef, plan.base].every((ref) => BRANCH.test(ref) && !ref.includes(".."))
  )
    throw new Error("Use plain repository names and branch names.");
  return plan;
}

export function gitPromptFor(nonce: string, step: GitStep): string {
  if (!isNonce(nonce) || !GIT_STEPS.includes(step)) throw Error("PROBE_REFUSED");
  return `${GIT_ACTION} ${nonce} ${step}: run the operator-scripted repository step.`;
}

/** The one shell command for a step. Stock git and gh only; no helper, remote rewrite or token. */
export function gitCommand(plan: GitPlan, nonce: string, step: GitStep): string {
  const tag = nonce.slice(0, 12);
  const dir = `${WORKSPACE}/x5-${tag}`;
  const url = (repository: string) => `https://github.com/${repository}.git`;
  const commit = [
    `git clone -q ${url(plan.repository)} ${dir}`,
    `cd ${dir}`,
    `git switch -q -c ${plan.branch}`,
    `printf '%s\\n' ${nonce} > x5-${tag}.txt`,
    `git add x5-${tag}.txt`,
    `git -c user.name=oce-dogfood-agent -c user.email=agent@example.invalid commit -q -m 'x5 dry run ${tag}'`,
  ].join(" && ");
  switch (step) {
    case "push":
      return `${commit} && git push ${url(plan.repository)} HEAD:refs/heads/${plan.branch} 2>&1 | tail -4`;
    case "draft":
      return `cd ${dir} && gh pr create --draft --repo ${plan.repository} --head ${plan.branch} --base ${plan.base} --title 'x5 dry run ${tag}' --body 'Synthetic Stage B dry run' 2>&1 | tail -3`;
    case "placeholders":
      // Digests and lengths only: the values must be Box placeholders, never a credential.
      return [
        `for n in GITHUB_TOKEN OCE_GITHUB_GIT_CREDENTIAL GH_TOKEN OCE_SOURCE_BEARER; do v=$(printenv $n); printf '%s set=%s len=%s sha=%s\\n' $n $([ -n "$v" ] && echo 1 || echo 0) \${#v} $(printf %s "$v" | sha256sum | cut -c1-16); done`,
        `tr '\\0' '\\n' < /proc/self/environ | cut -d= -f1 | sort | tr '\\n' ' '; echo`,
        `git config --list --show-origin | sed 's/=.*//' | sort -u | tr '\\n' ' '; echo`,
        `printenv | grep -c -E 'ghs_|ghu_|gho_|ghp_|github_pat_|x-access-token' || true`,
      ].join("; ");
    case "other-repository":
      return `git ls-remote ${url(plan.otherRepository)} 2>&1 | tail -2`;
    case "other-repository-api":
      return `gh api repos/${plan.otherRepository} 2>&1 | tail -2`;
    case "other-ref":
      return `cd ${dir} && git push ${url(plan.repository)} HEAD:refs/heads/${plan.otherRef} 2>&1 | tail -4`;
    case "after-withdrawal":
    case "worker-down":
      return `git ls-remote ${url(plan.repository)} 2>&1 | tail -2`;
  }
}

/** Exit code and Box's refusal code from Codex's exec_command output, or undefined. */
export function gitOutcome(raw: unknown): { exit: number; refusal?: string } | undefined {
  if (typeof raw !== "string" || raw.length > 65_536) return undefined;
  const exit = /^Process exited with code ([0-9]{1,3})$/m.exec(raw)?.[1];
  if (exit === undefined) return undefined;
  const refusal = /credential refused by its source: ([a-z_]{1,40})/.exec(raw)?.[1];
  return { exit: Number(exit), ...(refusal === undefined ? {} : { refusal }) };
}

export function gitAnswerFor(
  nonce: string,
  step: GitStep,
  outcome: { exit: number; refusal?: string } | undefined,
): string {
  return `${GIT_RESULT} ${nonce} ${step} ${
    outcome === undefined ? "unparsed" : `exit=${outcome.exit} refusal=${outcome.refusal ?? "none"}`
  }`;
}

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {};

/** One request handler for the whole run; each step's tool call is answered once. */
export function controlledGitModelRequests(
  nonce: string,
  plan: GitPlan,
  receipt: (row: Obj) => void,
  peer: { readonly address: string; readonly authorization?: string },
) {
  const calls = new Map<string, GitStep>();
  const answered = new Set<string>();
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (
        req.socket.remoteAddress !== peer.address ||
        req.method !== "POST" ||
        req.url !== "/v1/responses" ||
        req.headers.authorization !== peer.authorization
      ) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const bytes of req) {
        size += (bytes as Buffer).length;
        if (size > 1_048_576) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(bytes as Buffer));
      }
      const body = obj(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      if (body.model !== model || !Array.isArray(body.input)) {
        res.writeHead(422).end();
        return;
      }
      const input = body.input.map(obj);
      // The latest user message decides the step; one that names no step of this run (an
      // ordinary message in the same chat, for example after withdrawal) gets a plain reply.
      const latest = input
        .filter((item) => item.role === "user")
        .map(({ content }) =>
          (Array.isArray(content) ? content : [{ type: "input_text", text: content }])
            .map(obj)
            .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
            .join("\n"),
        )
        // Codex's own context items (environment, instructions) are tagged; they are not prompts.
        .filter((text) => !/^\s*(?:<|# AGENTS\.md)/.test(text))
        .at(-1)
        ?.split(/\r?\n/)
        .filter((line) => line.includes(`${GIT_ACTION} ${nonce} `))
        .at(-1);
      const step = GIT_STEPS.find((name) => latest?.endsWith(gitPromptFor(nonce, name)));
      if (step === undefined) {
        reply(res, "READY");
        return;
      }
      // A tool result for this step's call: classify it and end the step.
      const results = input.filter(
        (item) => item.type === "function_call_output" && calls.get(String(item.call_id)) === step,
      );
      const result = results.at(-1);
      if (result !== undefined) {
        const callId = String(result.call_id);
        const outcome = gitOutcome(result.output);
        const answer = gitAnswerFor(nonce, step, outcome);
        if (!answered.has(callId)) {
          answered.add(callId);
          receipt({
            stage: "tool_result",
            nonce,
            step,
            callId,
            answer,
            // The placeholder step's output is digests, lengths and names only.
            ...(step === "placeholders" && typeof result.output === "string"
              ? { output: result.output.slice(0, 4096) }
              : {}),
          });
        }
        reply(res, answer);
        return;
      }
      if (!Array.isArray(body.tools) || !body.tools.some((tool) => obj(tool).name === "exec_command")) {
        res.writeHead(409).end();
        return;
      }
      const callId = `call_${randomUUID()}`;
      calls.set(callId, step);
      receipt({ stage: "tool_intent", nonce, step, callId });
      reply(res, {
        id: `fc_${randomUUID()}`,
        type: "function_call",
        call_id: callId,
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: gitCommand(plan, nonce, step),
          workdir: WORKSPACE,
          login: false,
          yield_time_ms: 60000,
          max_output_tokens: 2000,
        }),
      });
    } catch {
      if (!res.headersSent) res.writeHead(422).end();
      else res.destroy();
    }
  };
}

function start(path: string) {
  const data = object(readConfig(path));
  fields(data, ["address", "port", "boxAddress", "certificate", "key", "runDirectory", "nonce", "plan"]);
  const nonce = data.nonce;
  const port = data.port;
  if (!isNonce(nonce) || typeof port !== "number" || !Number.isInteger(port) || port < 1024)
    throw new Error("Use an unprivileged TLS port and an exact probe nonce.");
  const plan = gitPlan(data.plan);
  const runDirectory = privateDirectory(data.runDirectory);
  const receipt = join(runDirectory, "controlled-git.jsonl");
  appendFileSync(receipt, "", { flag: "wx", mode: 0o600 });
  const server = createServer(
    {
      cert: readFileSync(string(data.certificate)),
      key: readFileSync(string(data.key)),
      minVersion: "TLSv1.2",
      requestTimeout: 30_000,
      headersTimeout: 5_000,
    },
    controlledGitModelRequests(
      nonce,
      plan,
      (row) => appendFileSync(receipt, JSON.stringify(row) + "\n"),
      { address: string(data.boxAddress), authorization: `Bearer ${CONTROLLED_INFERENCE_MARKER}` },
    ),
  );
  server.maxConnections = 8;
  server.listen(port, string(data.address), () =>
    process.stdout.write("Controlled git model fixture is listening.\n"),
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3 || process.argv[2] === undefined)
      throw new Error("Expected one private fixture configuration.");
    start(process.argv[2]);
  } catch {
    process.stderr.write("Controlled git model fixture refused its configuration.\n");
    process.exitCode = 1;
  }
}
