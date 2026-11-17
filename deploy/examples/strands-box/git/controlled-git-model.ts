// Test fixture, not a model: a scripted Responses endpoint for the installed protected dry run.
// Each prompt names one operator-scripted repository step; the fixture answers it with exactly one
// stock-shell tool call (`git` or `gh` against GitHub's canonical URLs, nothing custom) and then a
// fixed result line built from the tool's exit code and Box's refusal code. Values never pass
// through it: the placeholder step prints only digests and lengths of the workload's variables.
//
//   node controlled-git-model.ts <config.json>
//   config: { address, port, boxAddress, certificate, key, runDirectory, nonce, plan, bearerSha256?, pathPrefix? }
//   plan:   { repository, otherRepository, branch, otherRef, base, modelSiblings? }
//   pathPrefix: also serve the Responses path below this prefix (`<prefix>/v1/responses`), for a model
//   route whose base URL has a path prefix. `/v1/responses` stays served.
//   modelSiblings: URLs next to the model route that the model-sibling step posts to from the
//   workload with Box's placeholder; each one must be refused before it reaches a provider.
//   bearerSha256: the SHA-256 (hex) of each model key the fixture accepts (a protected Agent's key, which
//   Box injects). Without it the fixture accepts only the controlled route's public marker. Every
//   request's bearer digest (never the bearer) goes to `model-requests.jsonl` in the run directory.
import { appendFileSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:https";
import { createHash, randomUUID } from "node:crypto";
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
  // One Git request DELAYED_GIT_SECONDS after the model's answer, so that a lifecycle change (a model
  // withdrawal, the Worker going down) lands between the model's answer and the Git request.
  "delayed-git",
  // Hook admission checks: one marker-file write (did the tool run?) and the same no-progress
  // call repeated until the Gateway's loop policy blocks it through PreToolUse.
  "touch",
  "gateway-loop",
  // One permitted program (the workspace verifier): an ordinary tool call that runs to completion.
  "verifier",
  // Tamper attempts from the workload's own shell against Gateway tool admission: Codex's hook
  // configuration, the hook credential directory, the hook's interpreter, and forged hook calls.
  "tamper-config",
  "tamper-credential",
  "tamper-interpreter",
  "tamper-forge",
  // Codex's own patch tool (not the shell): add one new harmless file under the Harness home,
  // outside the workspace. Records whether Codex or Box refuses the write.
  "outside-write",
  // Requests from the workload's shell to paths next to the model route (plan.modelSiblings),
  // with Box's placeholder as the bearer: HTTP status codes only.
  "model-sibling",
  // The form a real model writes: clone, `cd` into the clone, bare git and gh (no `-C`, no
  // `--repo`): the launch directory must follow the shell's `cd`.
  "stock-form",
  // In that clone: one harmless pre-commit hook that writes a marker file in the workspace
  // (whether the hook ran), and one git read of a Harness file outside the workspace.
  "hook",
  "outside-read",
  // One git write into the workspace's Harness directory (`.codex`), which the git tool must refuse.
  "codex-write",
] as const;
/** Steps that rely on the shell's `cd` for git and gh, as a real model's commands do. */
export const STOCK_FORM_STEPS: ReadonlySet<GitStep> = new Set<GitStep>([
  "stock-form",
  "hook",
  "outside-read",
  "codex-write",
]);
/** Steps whose tool output the receipt keeps (bounded): none of them prints a credential. */
const RECORDED_OUTPUT: ReadonlySet<GitStep> = new Set<GitStep>([
  "placeholders",
  "touch",
  "verifier",
  "tamper-config",
  "tamper-credential",
  "tamper-interpreter",
  "tamper-forge",
  "outside-write",
  "model-sibling",
  "stock-form",
  "hook",
  "outside-read",
  "codex-write",
]);
/**
 * How long the delayed-git step waits before its one Git request: inside stock Codex's exec yield
 * (installed, Codex asked the model again 30 s into a longer command, before the Git request).
 */
export const DELAYED_GIT_SECONDS = 25;
/** Bound on repeated calls for the gateway-loop step (the stock critical threshold is 20). */
export const LOOP_CALLS = 30;
export type GitStep = (typeof GIT_STEPS)[number];
export interface GitPlan {
  readonly repository: string;
  readonly otherRepository: string;
  readonly branch: string;
  readonly otherRef: string;
  readonly base: string;
  readonly modelSiblings?: readonly string[];
}
const model = "gpt-5";
const WORKSPACE = "/home/node/workspace";
const HOOKS = "/home/node/.oce-native-hooks";
const CODEX_CONFIG = "/home/node/.codex/config.toml";
/** The outside-write step's target: under the Harness home, outside the workspace and hook dir. */
export const OUTSIDE_WRITE_PATH = "/home/node/outside-workspace-check.txt";
/** The patch Codex's own apply_patch tool receives for the outside-write step. */
export function outsideWritePatch(nonce: string): string {
  return `*** Begin Patch\n*** Add File: ${OUTSIDE_WRITE_PATH}\n+x5 outside-workspace check ${nonce.slice(0, 12)}\n*** End Patch\n`;
}
const REPOSITORY = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
/** A model-sibling URL: https, an explicit port and plain path segments; nothing a shell expands. */
const SIBLING = /^https:\/\/[a-z0-9.-]{1,100}:[0-9]{2,5}(?:\/[A-Za-z0-9._-]{1,40}){1,8}$/;
/** A model route's path prefix: one to four plain segments. */
const PATH_PREFIX = /^(?:\/[A-Za-z0-9_-]{1,40}){1,4}$/;

export function gitPlan(value: unknown): GitPlan {
  const data = object(value);
  fields(data, ["repository", "otherRepository", "branch", "otherRef", "base", "modelSiblings"]);
  const siblings = data.modelSiblings;
  if (
    siblings !== undefined &&
    (!Array.isArray(siblings) ||
      siblings.length === 0 ||
      siblings.length > 8 ||
      !siblings.every((url) => typeof url === "string" && SIBLING.test(url) && !url.includes("..")))
  )
    throw new Error("modelSiblings must list one to eight plain https URLs.");
  const plan = {
    repository: string(data.repository),
    otherRepository: string(data.otherRepository),
    branch: string(data.branch),
    otherRef: string(data.otherRef),
    base: string(data.base),
    ...(siblings === undefined ? {} : { modelSiblings: siblings as string[] }),
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
  const stock = `${WORKSPACE}/x5-stock-${tag}`;
  const url = (repository: string) => `https://github.com/${repository}.git`;
  // These steps name their repository (`git -C`), so they hold wherever Box starts a program: an
  // agent-spec spawn starts in `[agent] workspace`, not the shell's `cd` (finding 3318); the named
  // git and gh tools start in the shell's directory, which the stock-form steps check.
  const commit = [
    `git clone -q ${url(plan.repository)} ${dir}`,
    `git -C ${dir} switch -q -c ${plan.branch}`,
    `printf '%s\\n' ${nonce} > ${dir}/x5-${tag}.txt`,
    `git -C ${dir} add x5-${tag}.txt`,
    `git -C ${dir} -c user.name=oce-dogfood-agent -c user.email=agent@example.invalid commit -q -m 'x5 dry run ${tag}'`,
  ].join(" && ");
  switch (step) {
    case "push":
      return `${commit} && git -C ${dir} push ${url(plan.repository)} HEAD:refs/heads/${plan.branch} 2>&1 | tail -4`;
    case "draft":
      // `--repo` and `--head` name the pull request without a local checkout.
      return `gh pr create --draft --repo ${plan.repository} --head ${plan.branch} --base ${plan.base} --title 'x5 dry run ${tag}' --body 'Synthetic Stage B dry run' 2>&1 | tail -3`;
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
      return `git -C ${dir} push ${url(plan.repository)} HEAD:refs/heads/${plan.otherRef} 2>&1 | tail -4`;
    case "after-withdrawal":
    case "worker-down":
      return `git ls-remote ${url(plan.repository)} 2>&1 | tail -2`;
    case "delayed-git":
      return `sleep ${DELAYED_GIT_SECONDS}; git ls-remote ${url(plan.repository)} 2>&1 | tail -2; echo delayed-git-${tag}`;
    case "touch":
      return `printf '%s\\n' ${nonce} > ${WORKSPACE}/x5-touch-${tag}.txt && echo wrote`;
    case "gateway-loop":
      return `printf x5-loop-${tag}`;
    case "verifier":
      return "/opt/demo/verifier/oce-workspace-verifier";
    // Each tamper command is a `;` list so that every operation is decided on its own.
    case "tamper-config":
      return [
        `printf '[features]\\nhooks = false\\n' >> /home/node/.codex/config.toml`,
        "rm /home/node/.codex/config.toml",
        "mkdir /home/node/workspace/.codex",
        `printf '[features]\\nhooks = false\\n' > /home/node/workspace/.codex/config.toml`,
        `echo tamper-config-${tag}`,
      ].join("; ");
    case "tamper-credential":
      return [
        `ls -la ${HOOKS}`,
        `cat ${HOOKS}/*.json | wc -c`,
        `rm ${HOOKS}/*.json`,
        `printf '{}' > ${HOOKS}/codex-${tag}.json`,
        `ln -s ${WORKSPACE}/x5-${tag}.json ${HOOKS}/codex-${tag}.link.json`,
        `echo tamper-credential-${tag}`,
      ].join("; ");
    case "tamper-interpreter":
      return [
        `mkdir ${WORKSPACE}/bin-${tag}`,
        `cp /usr/local/bin/node ${WORKSPACE}/bin-${tag}/node`,
        `export PATH=${WORKSPACE}/bin-${tag}:$PATH`,
        "node --version",
        `echo tamper-interpreter-${tag}`,
      ].join("; ");
    case "outside-write":
      // Fallback when the request offers no apply_patch tool: Codex intercepts a shell
      // `apply_patch` invocation and applies the patch itself.
      return `apply_patch <<'EOF'\n${outsideWritePatch(nonce)}EOF`;
    case "model-sibling":
      // Requests from the workload's shell to paths next to the model route. A protected run's
      // shell may spawn only stock git and gh (finding 3314), so git makes them (a GET of
      // <url>/info/refs), with Box's placeholder by reference when the tool shell has it (Codex's
      // shell drops *KEY* variables; the workload may not read auth.json). Only the last line of
      // git's answer is printed.
      return plan.modelSiblings === undefined
        ? `echo model-sibling-unplanned-${tag}`
        : [
            `k=\${OPENAI_API_KEY:-}`,
            `case "$k" in strands_box_*) echo placeholder=1 len=\${#k};; *) echo placeholder=0 len=\${#k};; esac`,
            ...plan.modelSiblings.map(
              (url) =>
                `printf '%s ' ${url}; git -c http.extraHeader="Authorization: Bearer $k" ls-remote ${url} 2>&1 | tail -1 | cut -c1-200`,
            ),
            `echo model-sibling-${tag}`,
          ].join("; ");
    case "tamper-forge":
      // The readable relay credential, then a forged permission request through the hook route:
      // with the Shell's own client, and with the permitted relay command itself.
      return [
        `curl -sS -X POST -H "authorization: Bearer $(jq -r .token ${HOOKS}/*.json)" -d '{"event":"permission_request"}' "$(jq -r .url ${HOOKS}/*.json)"`,
        `python3 -c 'print(1)'`,
        `/usr/local/bin/node /app/node_modules/openclaw/dist/native-hook-relay/entry.js hooks relay --provider codex --relay-id codex-${"0".repeat(40)} --remote-credential ${HOOKS}/codex-${"0".repeat(40)}.00000000-0000-4000-8000-000000000000.json --generation 00000000-0000-4000-8000-000000000000 --event permission_request --timeout 5000 <<< '{"tool_name":"Bash","tool_input":{"command":"true"}}'`,
        `echo tamper-forge-${tag}`,
      ].join("; ");
    case "stock-form":
      // Joins the branch when it exists (after the push step), so the push fast-forwards.
      return [
        `git clone -q ${url(plan.repository)} ${stock}`,
        `cd ${stock}`,
        `(git switch -q ${plan.branch} 2>/dev/null || git switch -q -c ${plan.branch})`,
        // Repo-local identity: no global git configuration is visible to the git tool.
        "git config user.name oce-dogfood-agent",
        "git config user.email agent@example.invalid",
        `printf '%s\\n' ${nonce} > x5-stock-${tag}.txt`,
        `git add x5-stock-${tag}.txt`,
        `git commit -q -m 'x5 stock form ${tag}'`,
        `git push -q -u origin ${plan.branch} 2>&1 | tail -4`,
        `gh pr create --draft --base ${plan.base} --title 'x5 stock form ${tag}' --body 'Synthetic Stage B dry run' 2>&1 | tail -3`,
      ].join(" && ");
    case "hook":
      // git itself writes the hook with its executable bit (checkout-index of a 100755 entry),
      // so no other program is needed; the hook only writes a marker file in the clone.
      return [
        `cd ${stock}`,
        `printf '#!/bin/sh\\necho hook-ran > hook-marker-${tag}.txt\\n' > hook-${tag}.sh`,
        `git update-index --add --cacheinfo 100755,$(git hash-object -w hook-${tag}.sh),.x5-hooks/pre-commit`,
        `git checkout-index -f .x5-hooks/pre-commit`,
        `git rm -q --cached .x5-hooks/pre-commit`,
        `printf '%s\\n' ${tag} > x5-hook-${tag}.txt`,
        `git add x5-hook-${tag}.txt`,
        `git -c core.hooksPath=.x5-hooks commit -q -m 'x5 hook check ${tag}' 2>&1 | tail -2`,
        `echo hook-commit=$(git log -1 --format=%s)`,
        `(cat hook-marker-${tag}.txt 2>/dev/null || echo hook-marker=absent)`,
        `echo hook-${tag}`,
      ].join("; ");
    case "outside-read":
      // Names and a blob id only, never a value: can git read the Harness's own config file?
      return [
        `cd ${stock}`,
        `git hash-object ${CODEX_CONFIG} 2>&1 | tail -1 | cut -c1-160`,
        `git config --file ${CODEX_CONFIG} --name-only --list 2>&1 | head -3 | cut -c1-160`,
        // Visibility of the hook credential directory only (a git error names no file in it).
        `git -C ${HOOKS} rev-parse --is-inside-work-tree 2>&1 | tail -1 | cut -c1-160`,
        `echo outside-read-${tag}`,
      ].join("; ");
    case "codex-write":
      return [
        `cd ${stock}`,
        `git --work-tree=${WORKSPACE}/.codex checkout HEAD -- x5-stock-${tag}.txt 2>&1 | tail -1 | cut -c1-160`,
        `([ -e ${WORKSPACE}/.codex/x5-stock-${tag}.txt ] && echo codex-write=present || echo codex-write=absent)`,
        `echo codex-write-${tag}`,
      ].join("; ");
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
function execCall(callId: string, cmd: string): Obj {
  return {
    id: `fc_${randomUUID()}`,
    type: "function_call",
    call_id: callId,
    name: "exec_command",
    arguments: JSON.stringify({
      cmd,
      workdir: WORKSPACE,
      login: false,
      yield_time_ms: 60000,
      max_output_tokens: 2000,
    }),
  };
}
/** Codex's own patch tool call: freeform (custom) or function form, as the request offers it. */
function patchCall(callId: string, tool: Obj, patch: string): Obj {
  return tool.type === "custom"
    ? { id: `ctc_${randomUUID()}`, type: "custom_tool_call", call_id: callId, name: "apply_patch", input: patch }
    : {
        id: `fc_${randomUUID()}`,
        type: "function_call",
        call_id: callId,
        name: "apply_patch",
        arguments: JSON.stringify({ input: patch }),
      };
}
const obj = (x: unknown): Obj =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Obj) : {};

const SHA256 = /^[0-9a-f]{64}$/;

/** The SHA-256 of the bearer an `Authorization` header carries, or `null`; never the bearer. */
export function bearerDigest(header: unknown): string | null {
  if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 4_103) return null;
  return createHash("sha256").update(header.slice("Bearer ".length)).digest("hex");
}

export interface GitModelPeer {
  readonly address: string;
  /** The exact `Authorization` header to accept when no key digests are configured. */
  readonly authorization?: string;
  /** Accept a request only when its bearer's SHA-256 is one of these (a protected model key). */
  readonly bearerSha256?: readonly string[];
  /** One row per request that reached the fixture: its bearer's digest and whether it was accepted. */
  readonly requests?: (row: Obj) => void;
  /** Also serve `<pathPrefix>/v1/responses` (a model route below a path prefix). */
  readonly pathPrefix?: string;
}

/** One request handler for the whole run; each step's tool call is answered once. */
export function controlledGitModelRequests(
  nonce: string,
  plan: GitPlan,
  receipt: (row: Obj) => void,
  peer: GitModelPeer,
) {
  const calls = new Map<string, GitStep>();
  const answered = new Set<string>();
  if (peer.pathPrefix !== undefined && !PATH_PREFIX.test(peer.pathPrefix))
    throw new Error("pathPrefix must be plain path segments.");
  const served = new Set(["/v1/responses", ...(peer.pathPrefix === undefined ? [] : [`${peer.pathPrefix}/v1/responses`])]);
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const presented = bearerDigest(req.headers.authorization);
      const authorized =
        peer.bearerSha256 === undefined
          ? req.headers.authorization === peer.authorization
          : presented !== null && peer.bearerSha256.includes(presented);
      peer.requests?.({
        at: new Date().toISOString(),
        method: String(req.method).slice(0, 16),
        path: String(req.url).slice(0, 200),
        fromBox: req.socket.remoteAddress === peer.address,
        bearerSha256: presented,
        authorized,
      });
      if (
        req.socket.remoteAddress !== peer.address ||
        req.method !== "POST" ||
        !served.has(String(req.url)) ||
        !authorized
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
        (item) =>
          (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
          calls.get(String(item.call_id)) === step,
      );
      const result = results.at(-1);
      if (result !== undefined && step === "gateway-loop") {
        const text = typeof result.output === "string" ? result.output : JSON.stringify(result.output);
        const blocked = gitOutcome(text) === undefined;
        if (!blocked && results.length < LOOP_CALLS) {
          // Same call again: no progress, so the Gateway's loop policy decides the next one.
          const again = `call_${randomUUID()}`;
          calls.set(again, step);
          reply(res, execCall(again, gitCommand(plan, nonce, step)));
          return;
        }
        const answer = `${GIT_RESULT} ${nonce} ${step} calls=${results.length} blocked=${blocked ? 1 : 0}`;
        const callId = String(result.call_id);
        if (!answered.has(callId)) {
          answered.add(callId);
          receipt({ stage: "tool_result", nonce, step, callId, answer, output: text.slice(0, 600) });
        }
        reply(res, answer);
        return;
      }
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
            // The placeholder step's output is digests, lengths and names only; the admission and
            // tamper steps print exit codes, refusals, file names and byte counts, never a token.
            ...(RECORDED_OUTPUT.has(step) && result.output !== undefined
              ? {
                  output: (typeof result.output === "string"
                    ? result.output
                    : JSON.stringify(result.output)
                  ).slice(0, 4096),
                }
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
      const patchTool =
        step === "outside-write"
          ? body.tools.map(obj).find((tool) => tool.name === "apply_patch")
          : undefined;
      receipt({
        stage: "tool_intent",
        nonce,
        step,
        callId,
        ...(step === "outside-write" ? { via: patchTool ? `apply_patch:${String(patchTool.type)}` : "exec_command" } : {}),
      });
      reply(
        res,
        patchTool
          ? patchCall(callId, patchTool, outsideWritePatch(nonce))
          : execCall(callId, gitCommand(plan, nonce, step)),
      );
    } catch {
      if (!res.headersSent) res.writeHead(422).end();
      else res.destroy();
    }
  };
}

function start(path: string) {
  const data = object(readConfig(path));
  fields(data, [
    "address",
    "port",
    "boxAddress",
    "certificate",
    "key",
    "runDirectory",
    "nonce",
    "plan",
    "bearerSha256",
    "pathPrefix",
  ]);
  const nonce = data.nonce;
  const port = data.port;
  if (!isNonce(nonce) || typeof port !== "number" || !Number.isInteger(port) || port < 1024)
    throw new Error("Use an unprivileged TLS port and an exact probe nonce.");
  const plan = gitPlan(data.plan);
  const runDirectory = privateDirectory(data.runDirectory);
  const receipt = join(runDirectory, "controlled-git.jsonl");
  appendFileSync(receipt, "", { flag: "wx", mode: 0o600 });
  const keys = data.bearerSha256;
  if (
    keys !== undefined &&
    (!Array.isArray(keys) ||
      keys.length === 0 ||
      keys.length > 4 ||
      !keys.every((key) => typeof key === "string" && SHA256.test(key)))
  )
    throw new Error("bearerSha256 must list one to four SHA-256 hex digests.");
  const requests = join(runDirectory, "model-requests.jsonl");
  appendFileSync(requests, "", { flag: "wx", mode: 0o600 });
  const log = (row: Obj) => appendFileSync(requests, JSON.stringify(row) + "\n");
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
      {
        address: string(data.boxAddress),
        ...(keys === undefined
          ? { authorization: `Bearer ${CONTROLLED_INFERENCE_MARKER}` }
          : { bearerSha256: keys as string[] }),
        ...(data.pathPrefix === undefined ? {} : { pathPrefix: string(data.pathPrefix) }),
        requests: log,
      },
    ),
  );
  // TCP connections too: a refused model request must open none.
  server.on("connection", (socket) =>
    log({ at: new Date().toISOString(), stage: "connection", fromBox: socket.remoteAddress === data.boxAddress }),
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
