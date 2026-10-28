import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { waitFor } from "./qa-utils.mjs";
import { protectedText } from "./qa-secrets.mjs";

const execute = promisify(execFile);

// This lane uses an explicitly prepared disposable installation: App material
// stays in its worker, and the test authenticates only as the OCE operator.
export async function verifyQaOpenShellGitHub(t, artifacts, inputPath) {
  let stage = "inputs";
  let agent;
  let sourceBinding;
  let forward;
  let call;
  let kubectl;
  try {
    assert.equal(process.env.OCC_TEST_QA_REPOSITORY_AUTHORIZED, "1");
    const input = JSON.parse(await protectedText(inputPath, "OpenShell GitHub QA inputs"));
    assert.match(input.repository, /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/iu);
    const env = {
      ...process.env,
      OCC_URL: input.occUrl,
      OCC_NAMESPACE: input.namespaceId,
      OCC_SERVICE_KEY_FILE: input.serviceKeyFile,
    };
    call = async (...args) =>
      JSON.parse((await execute(input.occBinary, [...args, "-o", "json"], { env })).stdout);
    kubectl = async (...args) =>
      JSON.parse(
        (
          await execute("kubectl", [
            "--kubeconfig",
            input.kubeconfigPath,
            "--context",
            input.context,
            ...args,
            "-o",
            "json",
          ])
        ).stdout,
      );
    assert.match(input.context, /^k3d-/u, "Select a disposable k3d context");
    const nodes = await kubectl("get", "nodes");
    assert.ok(nodes.items.length > 0);
    const controller = await kubectl(
      "-n",
      input.controlNamespace,
      "get",
      "deployment",
      "openclaw-enterprise-worker",
    );
    assert.equal(controller.spec.template.spec.containers[0].image, input.controllerImage);
    const configuration = await call("configuration", "get", input.configurationId);
    const model = configuration.values.agents.defaults.model;
    const catalog = configuration.values.agents.defaults.models[model];
    assert.equal(catalog.agentRuntime.id, "openclaw");
    const source = await call("credential-source", "get", input.credentialSourceId);
    assert.equal(source.type, "openai");
    assert.equal(source.state, "ready");
    assert.equal(source.egress, undefined);
    const role = await call("iam", "role", "get", input.sourceRoleId);
    assert.deepEqual(role.permissions, [{ action: "operate", resourceKind: "credential_source" }]);
    const metadata = await fetch(`https://api.github.com/repos/${input.repository}`, {
      signal: AbortSignal.timeout(30000),
    });
    assert.equal(metadata.status, 200, "Select a public disposable test repository");
    assert.equal((await metadata.json()).private, false);
    const evidence = { harness: "openclaw", model, state: "creating" };
    const save = async () =>
      writeFile(join(artifacts, "openshell-native-github.json"), JSON.stringify(evidence), {
        mode: 0o600,
      });
    const create = async (command, body) => {
      const file = join(artifacts, "openshell-native-github-request.json");
      await writeFile(file, JSON.stringify(body), { mode: 0o600 });
      return call(...command, "create", "--file", file);
    };
    // Register cleanup before creating anything: an interrupted deploy may leave
    // an owned Agent even when no deployment response arrived.
    t.after(async () => {
      forward?.kill("SIGTERM");
      if (agent) {
        try {
          await call("agent", "stop", agent.id);
          await waitFor(
            "owned native Agent cleanup",
            async () => {
              const pods = await kubectl(
                "-n",
                input.workspace,
                "get",
                "pods",
                "-l",
                `openclaw.dev/agent=${agent.id}`,
              );
              return pods.items.length === 0;
            },
            180000,
            { interval: 1000 },
          );
          if (sourceBinding) {
            await call("iam", "access-binding", "delete", sourceBinding.id);
          }
        } catch {
          throw new Error("OpenShell native Git cleanup failed; inspect private evidence");
        }
      }
    });
    stage = "Agent admission";
    agent = await create(["agent"], {
      name: "native-github-qa-" + randomBytes(6).toString("hex"),
      configurationId: input.configurationId,
      executionMode: "dedicated",
      harnessAuth: { method: "credential_source", sourceId: source.id },
      credentialSources: [{ sourceId: source.id }],
      repositoryBindings: [{ repositoryRef: input.repositoryRef, profile: "github-installation" }],
    });
    evidence.agentId = agent.id;
    await save();
    sourceBinding = await create(["iam", "access-binding"], {
      subjectKind: "identity",
      subjectId: agent.servicePrincipalId,
      roleId: input.sourceRoleId,
      resourceKind: "credential_source",
      resourceId: source.id,
    });
    await call("agent", "runtime-credentials", "provision", agent.id);
    stage = "deployment";
    const revision = await call("agent", "deploy", agent.id);
    evidence.revisionId = revision.id;
    evidence.state = "deploying";
    await save();
    assert.equal(revision.agentId, agent.id);
    assert.equal(revision.harness.id, "openclaw");
    assert.equal(revision.harness.mode, "dedicated");
    await waitFor(
      "native Agent deployment",
      async () => {
        const status = await call("agent", "deployment-status", agent.id, revision.id);
        assert.notEqual(status.status, "failed", "Deployment failed; inspect private status");
        return status.status === "succeeded";
      },
      900000,
      { interval: 1000 },
    );
    const pods = await kubectl(
      "-n",
      input.workspace,
      "get",
      "pods",
      "-l",
      `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${revision.id},openclaw.dev/workload-role=gateway`,
    );
    assert.equal(pods.items.length, 1);
    const pod = pods.items[0];
    assert.equal(pod.spec.containers[0].image, input.runtimeImage);
    assert.ok(pod.status.conditions.some((c) => c.type === "Ready" && c.status === "True"));
    const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);
    const native = await kubectl(
      "-n",
      input.workspace,
      "get",
      "pods",
      "-l",
      `openclaw.dev/agent=${agent.id},openclaw.dev/revision=${revision.id},openclaw.dev/workload-role=agent`,
    );
    assert.equal(native.items.length, 1);
    assert.equal(native.items[0].metadata.labels["openshell.ai/boundary-role"], "workload");
    assert.equal(native.items[0].spec.containers[0].image, input.runtimeImage);
    assert.ok(
      native.items[0].status.containerStatuses.every((c) => c.ready && c.restartCount === 0),
    );
    evidence.nativePodUid = native.items[0].metadata.uid;
    evidence.gatewayPodUid = pod.metadata.uid;
    const passwordSecret = await kubectl(
      "-n",
      input.workspace,
      "get",
      "secret",
      "gateway-password-" + hash(agent.id),
    );
    const password = Buffer.from(passwordSecret.data["gateway-password"], "base64")
      .toString()
      .trim();
    assert.ok(password);
    stage = "Gateway transport";
    forward = spawn(
      "kubectl",
      [
        "--kubeconfig",
        input.kubeconfigPath,
        "--context",
        input.context,
        "-n",
        input.workspace,
        "port-forward",
        "--address",
        "127.0.0.1",
        "pod/" + pod.metadata.name,
        ":http",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let forwardError;
    forward.once("error", (error) => {
      forwardError = error;
    });
    let progress = "";
    forward.stdout.on("data", (chunk) => {
      progress += chunk;
    });
    const port = await waitFor(
      "Gateway forward",
      () => {
        assert.equal(forwardError, undefined);
        assert.equal(forward.exitCode, null);
        return /Forwarding from 127\.0\.0\.1:(\d+)/u.exec(progress)?.[1];
      },
      15000,
      { interval: 50 },
    );
    const endpoint = `http://127.0.0.1:${port}/v1/chat/completions`;
    // Both turns belong to one real conversation, rather than allocating an
    // unrelated native worker environment for each HTTP request.
    const conversation = "native-github-qa-" + randomBytes(12).toString("hex");
    const turn = async (prompt, authenticated = true) =>
      fetch(endpoint, {
        method: "POST",
        signal: AbortSignal.timeout(240000),
        headers: {
          "content-type": "application/json",
          ...(authenticated ? { authorization: "Bearer " + password } : {}),
        },
        body: JSON.stringify({
          model: "openclaw/default",
          user: conversation,
          stream: false,
          messages: [{ role: "user", content: prompt }],
        }),
      });
    const denied = await turn("do not execute", false);
    assert.ok([401, 403].includes(denied.status));
    await denied.arrayBuffer();
    stage = "model turn";
    const nonce = randomBytes(12).toString("hex");
    const modelResponse = await turn("Reply with exactly this nonce and no other text: " + nonce);
    assert.equal(modelResponse.status, 200);
    assert.ok((await modelResponse.json()).choices[0].message.content.includes(nonce));
    evidence.modelTurn = "verified";
    await save();
    stage = "Git push";
    const branch = "oce-native-github-proof-" + nonce;
    const publicGet = (path) =>
      fetch(`https://api.github.com/repos/${input.repository}/${path}`, {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(30000),
      });
    const absent = await publicGet("git/ref/heads/" + branch);
    assert.equal(absent.status, 404, "Use a fresh proof branch");
    await absent.arrayBuffer();
    evidence.branch = branch;
    evidence.state = "push-sent";
    await save();
    // Never repeat an uncertain push. Independent readback, rather than the model's
    // claimed result, is the authority for this mutation's success.
    stage = "Git tool turn";
    const pushed = await turn(
      `Run only these shell commands through OpenShell. Do not read credentials or repository instructions, install anything, run scanners or hooks, change main, or retry a failed or uncertain push. Stop on error. Report the commit SHA.\nset -eu\ngit -c core.hooksPath=/dev/null clone --quiet --depth=1 https://github.com/${input.repository}.git github-proof-${nonce}\ncd github-proof-${nonce}\ngit -c core.hooksPath=/dev/null fetch --quiet origin\ngit switch -c ${branch}\ngit config user.name 'OCE GitHub App Test'\ngit config user.email 'oce-github-app-test@example.invalid'\ngit -c core.hooksPath=/dev/null commit --allow-empty --signoff -m 'test: verify native OCE GitHub App ${nonce}'\ngit -c core.hooksPath=/dev/null push origin HEAD:refs/heads/${branch}\ngit rev-parse HEAD\n`,
    ).catch(async (error) => {
      evidence.gitRequestFailure = error.name;
      await save();
      throw error;
    });
    evidence.gitResponseStatus = pushed.status;
    await writeFile(join(artifacts, "openshell-native-git-response.json"), await pushed.text(), {
      mode: 0o600,
    });
    await save();
    assert.equal(pushed.status, 200);
    stage = "GitHub ref readback";
    const ref = await publicGet("git/ref/heads/" + branch);
    assert.equal(ref.status, 200);
    const sha = (await ref.json()).object.sha;
    const readback = await publicGet("git/commits/" + sha);
    assert.equal(readback.status, 200);
    const commit = await readback.json();
    assert.ok(commit.message.includes(nonce));
    assert.ok(
      commit.message.includes(
        "Signed-off-by: OCE GitHub App Test <oce-github-app-test@example.invalid>",
      ),
    );
    evidence.state = "verified";
    evidence.commit = sha;
    await save();
  } catch {
    throw new Error(`OpenShell native Git proof failed at ${stage}; inspect private evidence`);
  }
}
