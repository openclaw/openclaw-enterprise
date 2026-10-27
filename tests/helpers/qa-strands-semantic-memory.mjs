import assert from "node:assert/strict";

export const localMemoryModelPath =
  "/opt/oce/local-memory/models/embeddinggemma-300m-qat-Q8_0.gguf";

/** Configure OpenClaw's native managed provider with immutable offline assets. */
export function configureNativeLocalMemory(original) {
  const values = structuredClone(original);
  values.plugins.allow = [...new Set([...values.plugins.allow, "llama-cpp"])];
  values.plugins.entries["llama-cpp"] = { enabled: true };
  values.plugins.load = {
    ...values.plugins.load,
    paths: [
      ...new Set([
        ...(values.plugins.load?.paths ?? []),
        "/app/node_modules/openclaw/local-plugins/llama-cpp",
      ]),
    ],
  };
  values.models.providers["llama-cpp"] = {
    baseUrl: "http://127.0.0.1:19432/v1",
    api: "openai-completions",
    models: [],
    localService: {
      command: "/opt/oce/local-memory/bin/llama-server",
      args: [
        "--model",
        localMemoryModelPath,
        "--alias",
        "embeddinggemma-300m-qat-q8_0",
        "--host",
        "127.0.0.1",
        "--port",
        "19432",
        "--embedding",
        "--ctx-size",
        "2048",
        "--batch-size",
        "2048",
        "--ubatch-size",
        "2048",
        "--parallel",
        "1",
        "--threads",
        "2",
        "--no-ui",
        "--metrics",
      ],
      healthUrl: "http://127.0.0.1:19432/health",
      readyTimeoutMs: 60000,
      idleStopMs: 600000,
    },
  };
  values.memory.search = {
    ...values.memory.search,
    provider: "local",
    fallback: "none",
    local: { modelPath: localMemoryModelPath },
    store: { vector: { enabled: true } },
  };
  delete values.memory.search.remote;
  delete values.memory.search.model;
  return values;
}

/** Use the real native local provider; preserve Gateway default-deny egress. */
export async function verifyStrandsSemanticMemory(f) {
  const { fixture, api, gateway, wait, turn, check, result, nonce, base, sessionKey, deploy } = f;
  const agent = await api("GET", base);
  const configurationPath = `/namespaces/${fixture.namespaceId}/configurations/${agent.configurationId}`;
  const original = await api("GET", configurationPath);
  const path = `memory/semantic-${nonce}.md`;
  const content = "The expedition botanist stored a cobalt compass beneath the canvas hammock.\n";
  const query = "plant researcher blue navigation instrument under a hanging bed";
  const invoke = (name, args) =>
    gateway("tools.invoke", {
      name,
      args,
      agentId: "main",
      sessionKey,
      confirm: true,
      conversationReadOrigin: "direct-operator",
    });
  let changed = false;
  try {
    await check("semantic fixture has no keyword-only match", async () => {
      const node = (await gateway("node.list")).nodes.find(
        (item) => item.connected && item.commands.includes("file.write"),
      );
      assert.ok(node);
      const write = await invoke("file_write", {
        node: node.nodeId,
        path: `/home/node/workspace/${path}`,
        contentBase64: Buffer.from(content).toString("base64"),
        createParents: true,
      });
      assert.equal(write.ok, true, JSON.stringify(write));
      // Observe the ordinary asynchronous index; never inject index rows.
      await wait("keyword index contains semantic fixture", async () => {
        const search = await invoke("memory_search", {
          query: "expedition botanist cobalt compass canvas hammock",
          corpus: "memory",
          minScore: 0,
          maxResults: 20,
        });
        assert.equal(search.ok, true, JSON.stringify(search));
        return JSON.stringify(search.output).includes(path);
      });
      const keywords = await gateway("memory.search", {
        agentId: "main",
        query,
        minScore: 0,
        maxResults: 20,
      });
      assert.equal(keywords.searchMode, "fts-only");
      assert.ok(
        !keywords.results.some((hit) => hit.path === path),
        "synonyms must not already match via FTS",
      );
      result.semanticMemory = { path, query, keywordControl: keywords };
    });
    await check(
      "native local memory provider deploys without an embedding credential",
      async () => {
        const values = configureNativeLocalMemory(original.values);
        await api("PATCH", configurationPath, {
          values,
          secretBindings: original.secretBindings ?? {},
        });
        changed = true;
        const revision = await deploy();
        result.semanticMemory.revision = revision.id;
      },
    );
    await check("read-only Gateway authority cannot rebuild the memory index", async () => {
      result.semanticMemory.authorization = await f.gatewayReadOnlyMaintenance();
    });
    await check(
      "admin maintenance indexes remote workspace with the configured provider",
      async () => {
        const indexed = await gateway("memory.index", { agentId: "main" });
        assert.equal(indexed.status.custom?.workspaceHost, "remote");
        assert.equal(indexed.status.provider, "local");
        assert.equal(indexed.status.model, localMemoryModelPath);
        assert.ok(indexed.status.files > 0);
        assert.equal(indexed.status.vector?.index?.state, "complete");
        assert.equal(indexed.status.custom?.llamaCppRuntime?.state, "ready");
        assert.ok(indexed.status.vector?.dims > 0);
        result.semanticMemory.indexed = indexed;
      },
    );
    await check("local embeddings work while Gateway public HTTPS remains denied", async () => {
      const policies = await f.objects("networkpolicies");
      result.semanticMemory.networkPolicies = policies.map((policy) => ({
        name: policy.metadata.name,
        spec: policy.spec,
      }));
      const pod = f
        .owned(await f.objects("pods"))
        .find((item) => item.metadata.labels["openclaw.dev/workload-role"] === "gateway");
      assert.ok(pod);
      const probe = `
        import net from "node:net";
        const local = await fetch("http://127.0.0.1:19432/health", {signal: AbortSignal.timeout(5000)});
        if (!local.ok) throw new Error("Native local embedding server is unhealthy");
        const egress = await new Promise((resolve) => {
          const socket = net.connect({host: "api.openai.com", port: 443});
          socket.setTimeout(3000);
          socket.once("connect", () => {socket.destroy(); resolve({connected: true});});
          socket.once("timeout", () => {socket.destroy(); resolve({connected: false, reason: "timeout"});});
          socket.once("error", (error) => resolve({connected: false, reason: error.code}));
        });
        process.stdout.write(JSON.stringify({localStatus: local.status, egress}));
      `;
      const transport = JSON.parse(
        await f.kube(
          "-n",
          fixture.namespaceName,
          "exec",
          pod.metadata.name,
          "-c",
          "gateway",
          "--",
          "node",
          "--input-type=module",
          "-e",
          probe,
        ),
      );
      assert.equal(transport.localStatus, 200);
      assert.equal(transport.egress.connected, false);
      assert.notEqual(transport.egress.reason, "ENOTFOUND", "DNS failure is not an egress denial");
      assert.notEqual(transport.egress.reason, "EAI_AGAIN", "DNS failure is not an egress denial");
      result.semanticMemory.transport = transport;
    });
    await check("real embeddings retrieve a synonym-only remote memory fact", async () => {
      await wait("native semantic index ready", async () => {
        const search = await invoke("memory_search", {
          query,
          corpus: "memory",
          minScore: 0,
          maxResults: 20,
        });
        assert.equal(search.ok, true, JSON.stringify(search));
        assert.ok(!search.output?.isError, JSON.stringify(search));
        // Waiting for asynchronous indexing is separate from retrying a failed provider request.
        const output = JSON.stringify(search.output);
        assert.ok(
          !output.includes('"disabled":true') && !output.includes('"unavailable":true'),
          output,
        );
        return output.includes(path) && output.includes("cobalt compass") ? search : undefined;
      });
      const search = await gateway("memory.search", {
        agentId: "main",
        query,
        minScore: 0,
        maxResults: 5,
      });
      assert.equal(search.provider, "local");
      assert.equal(search.searchMode, "hybrid");
      assert.ok(
        search.results.some((hit) => hit.path === path && hit.snippet.includes("cobalt compass")),
      );
      result.semanticMemory.search = search;
      const code = `text(await tools.memory_search(${JSON.stringify({ query, corpus: "memory", minScore: 0, maxResults: 5 })}));`;
      const recall = await turn(
        `Use the native exec JavaScript tool to call the declared memory_search tool with this code: ${code} Report the item found and cite its memory file. Do not delegate, spawn an agent, use shell or direct file tools, or retry an error. End your answer with ${nonce}.`,
        ["cobalt compass", path],
        `agent:main:semantic-${nonce.toLowerCase()}`,
      );
      assert.ok(
        recall.tools.some((tool) => tool.name === "memory_search" && tool.output.includes(path)),
      );
      result.semanticMemory.modelRecall = recall;
    });
    await check(
      "sustained concurrent local embeddings preserve Gateway resource limits",
      async () => {
        const pod = f
          .owned(await f.objects("pods"))
          .find((item) => item.metadata.labels["openclaw.dev/workload-role"] === "gateway");
        assert.ok(pod);
        // One observer process sends concurrent native RPCs. Launching a full
        // OpenClaw CLI for each request would charge test-client heaps to the
        // Gateway cgroup and distort the service resource measurement.
        const resources = JSON.parse(
          await f.kube(
            "-n",
            fixture.namespaceName,
            "exec",
            pod.metadata.name,
            "-c",
            "gateway",
            "--",
            "node",
            "--input-type=module",
            "-e",
            `import {readFileSync as read} from "node:fs";
const {callGatewayFromCli}=await import("openclaw/plugin-sdk/gateway-runtime");
const counters=name=>Object.fromEntries(read('/sys/fs/cgroup/'+name,'utf8').trim().split('\\n').map(line=>{const [key,value]=line.split(' ');return [key,Number(value)];}));
const sample=()=>({current:Number(read('/sys/fs/cgroup/memory.current','utf8')),peak:Number(read('/sys/fs/cgroup/memory.peak','utf8')),max:read('/sys/fs/cgroup/memory.max','utf8').trim(),events:counters('memory.events'),stat:counters('memory.stat')});
const startedAt=Date.now();
const evidence={before:sample(),waves:[],observerProcesses:1};
try {
  for(let wave=0;wave<12;wave++) {
    if(wave>0) await new Promise(resolve=>setTimeout(resolve,5000));
    const started=Date.now();
    const searches=await Promise.all(Array.from({length:4},(_,slot)=>callGatewayFromCli("memory.search",{json:true,timeout:"30000"},{agentId:"main",query:${JSON.stringify(`${query} lookup ${nonce}`)}+" "+wave+" "+slot,minScore:0,maxResults:20},{scopes:["operator.read"],progress:false})));
    evidence.waves.push({elapsedMs:Date.now()-started,requests:searches.length,searches,memory:sample()});
  }
} catch(error) { evidence.error=String(error); evidence.afterFailure=sample(); }
evidence.elapsedMs=Date.now()-startedAt;
console.log(JSON.stringify(evidence));`,
          ),
        );
        result.semanticMemory.resources = { ...resources, podUid: pod.metadata.uid };
        assert.ok(!resources.error, resources.error);
        const { before, waves } = resources;
        assert.equal(waves.length, 12);
        assert.ok(resources.elapsedMs >= 55000);
        // Distinct queries exercise the real embedding service instead of its
        // query cache. This is bounded local qualification, not a capacity claim.
        for (const { searches } of waves) {
          assert.equal(searches.length, 4);
          for (const search of searches) {
            assert.equal(search.provider, "local");
            assert.equal(search.searchMode, "hybrid");
            assert.ok(search.results.some((hit) => hit.path === path));
          }
        }
        const current = (await f.objects("pods")).find(
          (item) => item.metadata.uid === pod.metadata.uid,
        );
        assert.ok(current, "Gateway was replaced during concurrent embedding work");
        assert.deepEqual(
          current.spec.containers.map((item) => item.resources),
          pod.spec.containers.map((item) => item.resources),
        );
        assert.deepEqual(
          current.status.containerStatuses.map((item) => item.restartCount),
          pod.status.containerStatuses.map((item) => item.restartCount),
        );
        for (const { memory } of waves) {
          assert.equal(memory.max, before.max);
          assert.equal(memory.events.oom, before.events.oom);
          assert.equal(memory.events.oom_kill, before.events.oom_kill);
        }
      },
    );
  } finally {
    if (changed) {
      await check("restore original keyword memory configuration and index", async () => {
        await api("PATCH", configurationPath, {
          values: original.values,
          secretBindings: original.secretBindings ?? {},
        });
        result.semanticMemory.configurationRestored = true;
        // Provider changes require explicit maintenance. Restore the derived
        // index too so a later ordinary deployment opens a matching index.
        await deploy();
        result.semanticMemory.restoredIndex = await gateway("memory.index", { agentId: "main" });
        assert.equal(result.semanticMemory.restoredIndex.status.provider, "none");
        // The enclosing scenario stops the current revision and withdraws its key.
      });
    }
  }
}
