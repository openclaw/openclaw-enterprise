import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { protectedText, redactQaError } from "./qa-secrets.mjs";
import { runQaCheck } from "./qa-check.mjs";

const execute = promisify(execFile);
const text = (message) =>
  typeof message.content === "string"
    ? message.content
    : (message.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");

/** Exercise an explicitly owned, stopped Agent on a prepared local Helm installation. */
export async function verifyQaStrandsSandbox(artifacts) {
  const fixture = JSON.parse(await readFile(process.env.OCC_TEST_QA_STRANDS_FIXTURE, "utf8"));
  assert.equal(fixture.allowAgentLifecycleMutation, true);
  const url = new URL(fixture.apiBaseUrl);
  assert.equal(url.protocol, "http:");
  assert.ok(["127.0.0.1", "[::1]"].includes(url.hostname), "use a loopback API forward");
  assert.equal(url.username + url.password + url.search + url.hash, "");
  assert.match(fixture.namespaceId, /^ns_[a-f0-9-]+$/u);
  assert.match(fixture.agentId, /^agt_[a-f0-9-]+$/u);
  assert.match(fixture.modelSecretId, /^sec_[a-f0-9-]+$/u);
  assert.match(fixture.runtimeImage, /@sha256:[a-f0-9]{64}$/u);
  const operatorKey = await protectedText(fixture.apiKeyFile, "local OCE operator key");
  const modelKey = await protectedText(process.env.OCC_TEST_QA_OPENAI_KEY_FILE, "model API key");
  const base = `/namespaces/${fixture.namespaceId}/agents/${fixture.agentId}`;
  const secretPath = `/namespaces/${fixture.namespaceId}/secrets/${fixture.modelSecretId}`;
  const result = { startedAt: new Date().toISOString(), checks: [], revisions: [] };
  const evidence = join(artifacts, "strands-sandbox.json");
  async function save() {
    await writeFile(evidence, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  }
  const check = (name, action) => runQaCheck({ result, save, name, action });
  async function api(method, path, body) {
    const response = await fetch(new URL(path, url), {
      method,
      redirect: "error",
      headers: {
        "x-api-key": operatorKey,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(path.endsWith("/stop") ? 420000 : 90000),
    }).catch((error) => {
      throw redactQaError(
        new Error(
          `${method} ${path}: ${error.message}; cause=${JSON.stringify({
            name: error.cause?.name,
            code: error.cause?.code,
            message: error.cause?.message,
          })}`,
        ),
      );
    });
    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))).error;
      throw redactQaError(
        new Error(`${method} ${path}: HTTP ${response.status} ${JSON.stringify(error)}`),
      );
    }
    return response.status === 204 ? undefined : (await response.json()).data;
  }
  async function kube(...args) {
    try {
      const output = await execute("kubectl", ["--kubeconfig", fixture.kubeconfig, ...args], {
        timeout: 210000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return output.stdout;
    } catch (error) {
      throw redactQaError(
        new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`),
      );
    }
  }
  const objects = async (kind) =>
    JSON.parse(await kube("-n", fixture.namespaceName, "get", kind, "-o", "json")).items;
  const owned = (items, agentId = fixture.agentId) =>
    items.filter((item) => item.metadata.labels?.["openclaw.dev/agent"] === agentId);
  async function wait(name, action, timeout = 180000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await action();
      if (value) {
        return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw new Error(`Timed out: ${name}`);
  }
  async function gateway(method, params = {}, agentId = fixture.agentId) {
    const pods = owned(await objects("pods"), agentId).filter(
      (pod) =>
        !pod.metadata.deletionTimestamp &&
        pod.metadata.labels["openclaw.dev/workload-role"] === "gateway",
    );
    assert.equal(pods.length, 1, "one exact Agent Gateway");
    return JSON.parse(
      await kube(
        "-n",
        fixture.namespaceName,
        "exec",
        pods[0].metadata.name,
        "-c",
        "gateway",
        "--",
        "node",
        "/app/openclaw.mjs",
        "gateway",
        "call",
        method,
        "--params",
        JSON.stringify(params),
        "--json",
        "--timeout",
        method === "memory.index" ? "180000" : "30000",
      ),
    );
  }
  async function gatewayReadOnlyMaintenance() {
    const pods = owned(await objects("pods")).filter(
      (pod) =>
        !pod.metadata.deletionTimestamp &&
        pod.metadata.labels["openclaw.dev/workload-role"] === "gateway",
    );
    assert.equal(pods.length, 1);
    const source = `
      const {callGatewayFromCli} = await import("openclaw/plugin-sdk/gateway-runtime");
      const options = {json: true, timeout: "30000"};
      const authority = {scopes: ["operator.read"], progress: false};
      await callGatewayFromCli("memory.status", options, {agentId: "main"}, authority);
      try {
        await callGatewayFromCli("memory.index", options, {agentId: "main"}, authority);
        throw new Error("Read-only caller unexpectedly indexed memory");
      } catch (error) {
        if (!String(error).includes("operator.admin")) throw error;
        process.stdout.write(JSON.stringify({readAllowed: true, writeDenied: true, reason: error.message}));
      }
    `;
    return JSON.parse(
      await kube(
        "-n",
        fixture.namespaceName,
        "exec",
        pods[0].metadata.name,
        "-c",
        "gateway",
        "--",
        "node",
        "--input-type=module",
        "-e",
        source,
      ),
    );
  }
  async function deploy() {
    const revision = await api("POST", `${base}/deploy`);
    result.revisions.push(revision.id);
    // A revision replacement includes the native Gateway's 330-second stop
    // budget. Use the same bounded lifecycle allowance as explicit teardown.
    await wait(
      "normal Agent deployment",
      async () => {
        const deployment = await api("GET", `${base}/deployments/${revision.id}`);
        assert.notEqual(deployment.status, "failed", "Agent deployment failed");
        return deployment.status === "succeeded";
      },
      420000,
    );
    const pods = owned(await objects("pods"));
    assert.equal(pods.length, 2, "dedicated Gateway and Box workloads");
    for (const pod of pods) {
      for (const container of pod.spec.containers) {
        assert.equal(container.image, fixture.runtimeImage, "test the selected immutable runtime");
      }
    }
    (result.runtimeObservations ??= []).push({
      revisionId: revision.id,
      pods: pods.map((pod) => ({
        name: pod.metadata.name,
        uid: pod.metadata.uid,
        role: pod.metadata.labels["openclaw.dev/workload-role"],
        securityContext: pod.spec.securityContext,
        containers: pod.spec.containers.map((container) => ({
          name: container.name,
          image: container.image,
          imageId: pod.status.containerStatuses?.find((item) => item.name === container.name)
            ?.imageID,
          resources: container.resources,
          securityContext: container.securityContext,
        })),
      })),
    });
    const configuration = await gateway("config.get");
    assert.equal(
      configuration.config.plugins.entries.codex.config.appServer.sandbox,
      "danger-full-access",
    );
    return revision;
  }
  const resources = () => objects("deployments,services,configmaps,networkpolicies");
  const pvcIdentities = async () =>
    (await objects("pvc"))
      .map((pvc) => ({ name: pvc.metadata.name, uid: pvc.metadata.uid }))
      .sort((a, b) => a.name.localeCompare(b.name));
  async function stop() {
    await api("POST", `${base}/stop`);
    await wait(
      "Agent workload teardown",
      async () => owned(await objects("pods,deployments")).length === 0,
      420000,
    );
    assert.equal(
      owned(await resources()).filter((item) => item.metadata.name.startsWith("strands-")).length,
      0,
    );
  }
  const nonce = `STRANDS_E2E_${randomUUID().replaceAll("-", "")}`;
  const sessionKey = `agent:main:strands-${randomUUID()}`;
  const memoryFact = `violet-${randomUUID()}`;
  const memoryPath = `memory/strands-${nonce}.md`;
  const skillName = `strands-check-${nonce.toLowerCase().replaceAll("_", "-")}`;
  const skillReceipt = `SKILL_${randomUUID()}`;
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  const skillText = `---\nname: ${skillName}\ndescription: Execute the Strands acceptance check.\n---\nRun a shell command that prints exactly ${skillReceipt}. Do not read credentials.\n`;

  async function turn(
    prompt,
    requiredText,
    turnSessionKey = sessionKey,
    agentId = fixture.agentId,
  ) {
    await gateway(
      "chat.send",
      {
        sessionKey: turnSessionKey,
        idempotencyKey: randomUUID(),
        message: prompt,
      },
      agentId,
    );
    return wait("real model tool completion", async () => {
      const history = await gateway(
        "chat.history",
        { sessionKey: turnSessionKey, limit: 80 },
        agentId,
      );
      const index = history.messages.findLastIndex(
        (message) => message.role === "user" && text(message) === prompt,
      );
      if (index < 0) {
        return undefined;
      }
      const messages = history.messages.slice(index + 1);
      const failed = messages.some(
        (message) =>
          message.errorMessage ||
          message.stopReason === "error" ||
          message.customType === "run-failed-before-reply",
      );
      const final = messages.find(
        (message) =>
          message.role === "assistant" &&
          message.stopReason === "stop" &&
          !message.__openclaw?.mirrorIdentity?.includes(":commentary:"),
      );
      if (!final && !failed) {
        return undefined;
      }
      // Preserve the actual conversation before asserting tool completion. A
      // final model answer can arrive while its shell process is still running.
      result.turns ??= [];
      result.turns.push({
        sessionKey: turnSessionKey,
        messages: JSON.parse(
          JSON.stringify(messages)
            .replaceAll(modelKey, "[redacted]")
            .replaceAll(operatorKey, "[redacted]"),
        ),
      });
      await save();
      assert.ok(!failed, "model turn failed; see the preserved native conversation");
      assert.ok(
        !messages.some((message) => message.role === "toolResult" && message.isError),
        "a tool failed; a later successful result must not hide that failure",
      );
      // The real tool receipt and subsequent API readback establish execution.
      // Repeating a nonce in the final prose is not a product requirement.
      const tool = messages.find(
        (message) =>
          message.role === "toolResult" &&
          !message.isError &&
          requiredText.every((part) => text(message).includes(part)),
      );
      assert.ok(tool, "assistant reply is insufficient without the real tool result");
      assert.ok(!text(tool).includes("UNEXPECTEDLY_ALLOWED"));
      return {
        toolName: tool.toolName,
        output: text(tool),
        tools: messages
          .filter((message) => message.role === "toolResult" && !message.isError)
          .map((message) => ({ name: message.toolName, output: text(message) })),
        usage: final.usage,
      };
    });
  }

  // Refuse a running/shared target before any key mutation or cleanup registration.
  await check("owned stopped Agent and selected model", async () => {
    const namespace = JSON.parse(
      await kube("get", "namespace", fixture.namespaceName, "-o", "json"),
    );
    assert.equal(namespace.metadata.labels["openclaw.dev/namespace"], fixture.namespaceId);
    const agent = await api("GET", base);
    assert.equal(agent.id, fixture.agentId);
    assert.equal(agent.namespaceId, fixture.namespaceId);
    assert.equal(agent.desiredRuntimeState, "stopped");
    assert.equal(owned(await objects("pods,deployments")).length, 0);
    const configuration = await api(
      "GET",
      `/namespaces/${fixture.namespaceId}/configurations/${agent.configurationId}`,
    );
    assert.equal(configuration.values.agents.defaults.model, `codex/${fixture.model}`);
    assert.ok(
      configuration.values.plugins?.allow?.includes("memory-core"),
      "Explicitly allow memory-core through the normal Agent configuration; a memory slot alone does not grant its tools",
    );
    assert.equal(
      configuration.values.memory?.search?.provider,
      "none",
      "The scenario starts with keyword memory, then qualifies native local embeddings",
    );
  });
  const pvcs = await pvcIdentities();
  const failures = [];
  try {
    // The normal OCE Secret API and deployment project the key into the owned Harness.
    await api("PATCH", secretPath, { value: modelKey });
    await check("normal deployment and native readiness", deploy);
    const { verifyStrandsTransport } = await import("./qa-strands-transport.mjs");
    await verifyStrandsTransport({ fixture, gateway, kube, objects, owned, check, result });
    await check("split storage and remote workspace capabilities", async () => {
      const pods = owned(await objects("pods"));
      const gatewayPod = pods.find(
        (pod) => pod.metadata.labels["openclaw.dev/workload-role"] === "gateway",
      );
      const harnessPod = pods.find(
        (pod) => pod.metadata.labels["openclaw.dev/workload-role"] === "agent",
      );
      const claims = (pod) =>
        pod.spec.volumes
          .filter((volume) => volume.persistentVolumeClaim)
          .map((volume) => volume.persistentVolumeClaim.claimName);
      const gatewayClaims = claims(gatewayPod);
      const harnessClaims = claims(harnessPod);
      assert.ok(gatewayClaims.length && harnessClaims.length);
      assert.ok(
        gatewayClaims.every((claim) => !harnessClaims.includes(claim)),
        "Gateway must not mount Harness workspace storage",
      );
      const nodes = await gateway("node.list");
      assert.ok(
        nodes.nodes.some(
          (node) =>
            node.connected &&
            node.paired &&
            ["workspace.memory", "workspace.skills", "file.fetch"].every((command) =>
              node.commands.includes(command),
            ),
        ),
      );
      result.storage = { gatewayClaims, harnessClaims };
    });
    await check("native remote skill installation preserves exact fixture bytes", async () => {
      // Install valid test data through the supported workspace interface. The
      // later model turn must still discover, read and execute this real skill.
      const nodes = (await gateway("node.list")).nodes.filter(
        (node) => node.connected && node.paired && node.commands.includes("file.write"),
      );
      assert.equal(nodes.length, 1);
      const path = `/home/node/workspace/skills/${skillName}/SKILL.md`;
      const invoke = (name, args) =>
        gateway("tools.invoke", {
          name,
          args,
          agentId: "main",
          sessionKey,
          confirm: true,
          conversationReadOrigin: "direct-operator",
        });
      const written = await invoke("file_write", {
        node: nodes[0].nodeId,
        path,
        contentBase64: Buffer.from(skillText).toString("base64"),
        createParents: true,
      });
      assert.equal(written.ok, true, JSON.stringify(written));
      const fetched = await invoke("file_fetch", { node: nodes[0].nodeId, path });
      assert.equal(fetched.ok, true, JSON.stringify(fetched));
      assert.equal(fetched.output.details.size, Buffer.byteLength(skillText));
      assert.equal(
        fetched.output.details.sha256,
        createHash("sha256").update(skillText).digest("hex"),
      );
      result.skillFixture = { path, sha256: fetched.output.details.sha256 };
    });
    await check("model tool write, file denial, and Gateway readback", async () => {
      const command = `mkdir -p memory; printf %s ${quote(`Strands project ${nonce} has synthetic color ${memoryFact}.\n`)} > ${memoryPath}; printf '\\n<!-- ${nonce} -->\\n' >> AGENTS.md; tail -n 1 AGENTS.md; if cat /etc/shadow >/dev/null; then printf 'OUTSIDE_UNEXPECTEDLY_ALLOWED\\n'; else printf 'OUTSIDE_DENIED\\n'; fi; if curl --max-time 5 -fsS https://example.com/ >/dev/null; then printf 'NETWORK_UNEXPECTEDLY_ALLOWED\\n'; else printf 'NETWORK_DENIED\\n'; fi`;
      result.write = await turn(
        `Run this script once with your shell tool in the workspace: ${command}\nWait for completion, then reply with ${nonce}. Do not read credentials or environment variables. Do not retry errors.`,
        [
          nonce,
          "OUTSIDE_DENIED",
          "NETWORK_DENIED",
          "policy denied this operation on '/etc/shadow'",
          "Process exited with code 0",
        ],
      );
      const file = await gateway("agents.files.get", { agentId: "main", name: "AGENTS.md" });
      assert.ok(JSON.stringify(file).includes(nonce), "Gateway must read the tool's write");
    });
    await check("native asynchronous memory indexing sees the new file", async () => {
      const startedAt = Date.now();
      await wait("new remote memory file indexed", async () => {
        // Exercise the normal tool owner, which starts the native watcher and
        // schedules background maintenance. The management memory.search RPC
        // uses a transient CLI manager and cannot establish this lifecycle.
        const response = await gateway("tools.invoke", {
          name: "memory_search",
          args: { query: nonce, corpus: "memory", minScore: 0, maxResults: 5 },
          agentId: "main",
          sessionKey,
          conversationReadOrigin: "direct-operator",
        });
        assert.equal(response.ok, true, "The normal memory tool must be available");
        return (
          JSON.stringify(response.output).includes(memoryPath) &&
          JSON.stringify(response.output).includes(memoryFact)
        );
      });
      const search = await gateway("memory.search", {
        agentId: "main",
        query: nonce,
        minScore: 0,
        maxResults: 5,
      });
      assert.ok(
        search.results.some((hit) => hit.path === memoryPath && hit.snippet.includes(memoryFact)),
      );
      result.indexing = { elapsedMs: Date.now() - startedAt, search };
    });
    async function recall(label) {
      const recallSession = `agent:main:strands-recall-${randomUUID()}`;
      // Use the invocation advertised by the native Codex tool declaration.
      // Keep the actual dynamic-tool receipt mandatory; prose is not evidence.
      const code = `text(await tools.memory_search(${JSON.stringify({ query: nonce, corpus: "memory", minScore: 0, maxResults: 5 })}));`;
      const proof = await turn(
        `Use the native exec JavaScript tool to call the declared memory_search tool with this code: ${code} Retrieve the synthetic color for Strands project ${nonce} from the tool result and cite its memory file. Do not delegate, spawn an agent, use shell or direct file tools, or retry an error.`,
        [memoryFact, memoryPath],
        recallSession,
      );
      assert.ok(
        proof.tools.some(
          (tool) =>
            tool.name === "memory_search" &&
            tool.output.includes(memoryFact) &&
            tool.output.includes(memoryPath),
        ),
        "Require a real memory_search result; cached conversation text or an assistant answer is insufficient",
      );
      result[label] = { sessionKey: recallSession, ...proof };
    }
    await check("new conversation recalls remote memory", () => recall("memoryBeforeRedeploy"));
    await check("Harness authentication and explicit egress policy refusal", async () => {
      const pods = owned(await objects("pods"));
      const box = pods.find((pod) => pod.metadata.name.startsWith("strands-"));
      assert.ok(box);
      // Exercise the deployed kubelet probe against the real Harness. A valid
      // token must initialize Codex; an unrelated token must fail readiness.
      const readiness = box.spec.containers.find((container) => container.name === "agent")
        .readinessProbe.exec.command;
      await kube(
        "-n",
        fixture.namespaceName,
        "exec",
        box.metadata.name,
        "-c",
        "agent",
        "--",
        ...readiness,
      );
      const wrongTokenPath = `/tmp/qa-readiness-${randomUUID()}`;
      const wrongTokenCommand = readiness.map((argument) =>
        argument === "/run/strands-box-probe/token" ? wrongTokenPath : argument,
      );
      assert.ok(wrongTokenCommand.includes(wrongTokenPath));
      const rejectWrongToken = `const fs=require('node:fs');const {spawnSync}=require('node:child_process');const path=${JSON.stringify(wrongTokenPath)};try{fs.writeFileSync(path,'synthetic-unrelated-readiness-token',{mode:0o600});const command=${JSON.stringify(wrongTokenCommand)};const result=spawnSync(command[0],command.slice(1),{timeout:7000,stdio:'ignore'});if(result.status!==1)process.exitCode=1;}finally{fs.rmSync(path,{force:true});}`;
      await kube(
        "-n",
        fixture.namespaceName,
        "exec",
        box.metadata.name,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        rejectWrongToken,
      );
      result.readinessAuthentication = { validToken: "initialized", unrelatedToken: "refused" };
      const service = owned(await objects("services")).find((item) =>
        item.metadata.name.startsWith("strands-"),
      );
      assert.ok(service);
      const gatewayPod = pods.find(
        (pod) => pod.metadata.labels["openclaw.dev/workload-role"] === "gateway",
      );
      const unauthenticated = `fetch('http://${service.metadata.name}:18790/',{signal:AbortSignal.timeout(5000)}).then(r=>console.log(r.status))`;
      assert.equal(
        (
          await kube(
            "-n",
            fixture.namespaceName,
            "exec",
            gatewayPod.metadata.name,
            "-c",
            "gateway",
            "--",
            "node",
            "-e",
            unauthenticated,
          )
        ).trim(),
        "401",
      );
      // Inspect only the proxy's public port, and send no model or operator credentials.
      const probe = `const {readFileSync}=require('node:fs');const {connect}=require('node:net');const port=JSON.parse(readFileSync('/run/strands-box/state/private/live.json')).proxy_port;const s=connect(port,'127.0.0.1',()=>s.write('CONNECT example.com:443 HTTP/1.1\\r\\nHost: example.com:443\\r\\n\\r\\n'));let data='';s.setTimeout(5000,()=>{s.destroy();process.exitCode=1});s.on('data',b=>data+=b);s.on('end',()=>console.log(data));`;
      const response = await kube(
        "-n",
        fixture.namespaceName,
        "exec",
        box.metadata.name,
        "-c",
        "agent",
        "--",
        "node",
        "-e",
        probe,
      );
      assert.match(response, /^HTTP\/1\.1 403/u);
      assert.match(response, /policy denied.*example\.com:443.*default-deny/u);
      result.networkDenial = response;
    });
    await check("unexpected Sandbox loss is observable", async () => {
      const deployments = owned(await objects("deployments")).filter((item) =>
        item.metadata.name.startsWith("strands-"),
      );
      assert.equal(deployments.length, 1);
      // Delete only the exact test Agent's provider workload to simulate loss.
      await kube(
        "-n",
        fixture.namespaceName,
        "delete",
        "deployment",
        deployments[0].metadata.name,
        "--cascade=foreground",
        "--wait=true",
        "--timeout=90s",
      );
      await wait(
        "Sandbox loss observation",
        async () => {
          const status = await api("GET", `${base}/harness-status`);
          return status.harness?.state === "lost" && status.harness?.code === "SANDBOX_MISSING";
        },
        30000,
      );
    });
    await check("normal stop removes remaining provider resources", stop);
    await check("normal redeployment and persistent workspace", async () => {
      await deploy();
      assert.deepEqual(await pvcIdentities(), pvcs);
      assert.ok(
        JSON.stringify(
          await gateway("agents.files.get", { agentId: "main", name: "AGENTS.md" }),
        ).includes(nonce),
      );
      result.read = await turn(
        `After redeployment: (1) call skills_read for ${skillName}; (2) use your shell tool to execute the command instructed by that skill, and in the same shell invocation run tail -n 1 AGENTS.md. Both the skill receipt and the marker must appear in actual shell output before you finish. Quoting the skill instructions is not execution. Return those two outputs. Do not read credentials or retry errors.`,
        [nonce, "Process exited with code 0"],
      );
      assert.ok(
        result.read.tools.some(
          (tool) => tool.name === "skills_read" && tool.output.includes(skillReceipt),
        ),
      );
      assert.ok(
        result.read.tools.some(
          (tool) =>
            ["bash", "exec"].includes(tool.name) &&
            tool.output.includes(skillReceipt) &&
            tool.output.includes("Process exited with code 0"),
        ),
      );
    });
    await check("new conversation recalls memory after redeploy", () =>
      recall("memoryAfterRedeploy"),
    );
    await check("native code-mode executes JavaScript inside Box", async () => {
      const receipt = `CODE_MODE_${nonce}`;
      result.codeMode = await turn(
        `Use the native exec JavaScript tool to run this code exactly: const values = [19, 23]; text({receipt: ${JSON.stringify(receipt)}, sum: values.reduce((a, b) => a + b, 0), processType: typeof process, requireType: typeof require}); Do not use bash, shell commands, or another JavaScript interpreter. Report the returned object and end with ${nonce}. Do not retry failed tools.`,
        [receipt, "42", "undefined"],
        `agent:main:code-mode-${nonce.toLowerCase()}`,
      );
      assert.equal(result.codeMode.toolName, "exec");
    });
    const { verifyStrandsWorkspaceWorkflows } = await import("./qa-strands-workspace.mjs");
    await verifyStrandsWorkspaceWorkflows({
      fixture,
      api,
      kube,
      objects,
      owned,
      wait,
      gateway,
      turn,
      check,
      result,
      nonce,
      base,
      sessionKey,
      memoryPath,
      memoryFact,
      deploy,
    });
    const { verifyStrandsSemanticMemory } = await import("./qa-strands-semantic-memory.mjs");
    await verifyStrandsSemanticMemory({
      gatewayReadOnlyMaintenance,
      kube,
      objects,
      owned,
      fixture,
      api,
      gateway,
      wait,
      turn,
      check,
      result,
      nonce,
      base,
      sessionKey,
      deploy,
    });
  } catch (error) {
    failures.push(redactQaError(error));
  } finally {
    // Withdrawal is attempted even if stop fails; cleanup failures fail the run.
    for (const [name, action] of [
      ["final Agent stop", stop],
      [
        "model key withdrawal",
        async () => {
          // This exact replacement is idempotent. A failed transport must not
          // leave the personal key installed after the Agent has been stopped.
          for (let attempt = 1; ; attempt++) {
            result.keyWithdrawalAttempts = attempt;
            try {
              await api("PATCH", secretPath, {
                value: "synthetic-invalid-key-for-credential-free-startup",
              });
              return;
            } catch (error) {
              if (attempt === 3) {
                throw error;
              }
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        },
      ],
      [
        "no model key remains in tenant Secrets",
        async () => {
          const secrets = await objects("secrets");
          assert.ok(
            secrets.every((secret) =>
              Object.values(secret.data ?? {}).every(
                (value) => !Buffer.from(value, "base64").toString().includes(modelKey),
              ),
            ),
          );
          assert.deepEqual(await pvcIdentities(), pvcs);
        },
      ],
    ]) {
      try {
        await check(name, action);
      } catch (error) {
        failures.push(redactQaError(error));
      }
    }
    result.finishedAt = new Date().toISOString();
    result.passed = failures.length === 0;
    result.errors = failures.map((error) => String(redactQaError(error)));
    await save().catch((error) => failures.push(redactQaError(error)));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Strands sandbox acceptance failed");
  }
  return {
    evidence,
    outcome: "real model tools, policy denials, loss detection, redeploy and cleanup",
  };
}
