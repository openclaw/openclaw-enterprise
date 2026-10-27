import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

/** Additional real workflows on the same admitted revision-Pod installation. */
export async function verifyStrandsWorkspaceWorkflows(f) {
  const {
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
  } = f;
  const namespace = `/namespaces/${fixture.namespaceId}`;
  const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const invoke = (name, args, agentId = fixture.agentId) =>
    gateway(
      "tools.invoke",
      {
        name,
        args,
        agentId: "main",
        sessionKey,
        confirm: true,
        conversationReadOrigin: "direct-operator",
      },
      agentId,
    );
  const workspaceNode = async (agentId = fixture.agentId) => {
    const nodes = (await gateway("node.list", {}, agentId)).nodes.filter(
      (node) => node.connected && node.paired && node.commands.includes("file.write"),
    );
    assert.equal(nodes.length, 1);
    return nodes[0].nodeId;
  };
  const podState = async () =>
    (await objects("pods")).map((pod) => ({
      uid: pod.metadata.uid,
      agentId: pod.metadata.labels?.["openclaw.dev/agent"],
      restarts: pod.status.containerStatuses?.map(({ name, restartCount }) => ({
        name,
        restartCount,
      })),
    }));
  const memory = () =>
    gateway("memory.search", {
      agentId: "main",
      query: nonce,
      minScore: 0,
      maxResults: 5,
    });

  await check("native OCC live workspace read and write", async () => {
    const path = `${base}/workspace/files/AGENTS.md`;
    const previous = await api("GET", path);
    try {
      const content = `${previous.content}\nSynthetic workspace fixture ${nonce}\n中文 文件\n`;
      const written = await api("PUT", path, { content });
      assert.equal(written.size, Buffer.byteLength(content));
      assert.equal((await api("GET", path)).content, content);
      assert.equal(
        (await gateway("agents.files.get", { agentId: "main", name: "AGENTS.md" })).file.content,
        content,
      );
      result.nativeWorkspace = { size: written.size, gatewayReadback: true };
    } finally {
      await api("PUT", path, { content: previous.content });
    }
  });

  await check("remote Unicode binary empty file transfer and overwrite refusal", async () => {
    const node = await workspaceNode();
    const root = `/home/node/workspace/skills/qa-${nonce.toLowerCase()}/files`;
    const receipts = [];
    for (const [name, bytes] of [
      ["中文 空格.txt", Buffer.from(`远端文件 ${nonce}\n`)],
      ["binary.bin", Buffer.from(Array.from({ length: 1024 }, (_, i) => i % 256))],
      ["empty.txt", Buffer.alloc(0)],
    ]) {
      const path = `${root}/${name}`;
      const written = await invoke("file_write", {
        node,
        path,
        contentBase64: bytes.toString("base64"),
        createParents: true,
      });
      assert.equal(written.ok, true, JSON.stringify(written));
      const fetched = await invoke("file_fetch", { node, path });
      assert.equal(fetched.ok, true, JSON.stringify(fetched));
      assert.equal(fetched.output.details.sha256, sha(bytes));
      assert.equal(fetched.output.details.size, bytes.length);
      receipts.push({ name, size: bytes.length, sha256: sha(bytes) });
    }
    const path = `${root}/中文 空格.txt`;
    const refused = await invoke("file_write", { node, path, contentBase64: "eA==" });
    assert.ok(!refused.ok || refused.output?.isError, "overwrite needs explicit consent");
    assert.equal(
      (await invoke("file_write", { node, path, contentBase64: "eA==", overwrite: true })).ok,
      true,
    );
    assert.equal((await invoke("file_fetch", { node, path })).output.details.sha256, sha("x"));
    const listing = await invoke("dir_list", { node, path: root });
    assert.equal(listing.ok, true);
    assert.ok(JSON.stringify(listing).includes("binary.bin"));
    const outside = await invoke("file_write", {
      node,
      path: `/etc/${nonce}`,
      contentBase64: "eA==",
    });
    assert.ok(!outside.ok || outside.output?.isError);
    result.fileTransfer = { receipts, refused, outside };
  });

  await check("Harness Pod replacement recovers the same revision automatically", async () => {
    const before = await api("GET", base);
    const pod = owned(await objects("pods")).find((item) =>
      item.metadata.name.startsWith("strands-"),
    );
    assert.ok(pod);
    await kube("-n", fixture.namespaceName, "delete", "pod", pod.metadata.name, "--wait=false");
    const replacement = await wait("replacement provider Pod Ready", async () => {
      const next = owned(await objects("pods")).find(
        (item) => item.metadata.name.startsWith("strands-") && !item.metadata.deletionTimestamp,
      );
      return next &&
        next.metadata.uid !== pod.metadata.uid &&
        next.status.containerStatuses?.every((container) => container.ready)
        ? next
        : undefined;
    });
    await wait("replacement workspace enrolled", async () => {
      const nodes = await gateway("node.list");
      return nodes.nodes.some(
        (node) => node.connected && node.commands.includes("workspace.memory"),
      );
    });
    assert.equal((await api("GET", base)).activeRevisionId, before.activeRevisionId);
    const found = await memory();
    assert.ok(
      found.results.some((hit) => hit.path === memoryPath && hit.snippet.includes(memoryFact)),
    );
    result.podReplacement = {
      oldUid: pod.metadata.uid,
      newUid: replacement.metadata.uid,
      revision: before.activeRevisionId,
      memoryRetained: true,
    };
  });

  await check("live revision activation retains workspace and retires old resources", async () => {
    const old = (await api("GET", base)).activeRevisionId;
    const revision = await deploy();
    assert.notEqual(revision.id, old);
    assert.equal((await api("GET", base)).activeRevisionId, revision.id);
    await wait("old revision resources retired", async () =>
      owned(await objects("pods,deployments,services,configmaps,networkpolicies")).every(
        (resource) => resource.metadata.labels?.["openclaw.dev/revision"] !== old,
      ),
    );
    assert.ok(
      (await memory()).results.some(
        (hit) => hit.path === memoryPath && hit.snippet.includes(memoryFact),
      ),
    );
    result.liveRevision = { old, next: revision.id, memoryRetained: true };
  });

  let second;
  let role;
  let binding;
  try {
    await check("second Agent initial workspace and independent storage", async () => {
      const first = await api("GET", base);
      second = await api("POST", `${namespace}/agents`, {
        name: `strands-isolation-${randomUUID().slice(0, 8)}`,
        configurationId: first.configurationId,
        executionMode: "dedicated",
        harnessAuth: first.harnessAuth,
        initialWorkspaceFiles: {
          "AGENTS.md": `Synthetic test Agent ${nonce}. Follow the user's test instructions.\n`,
          "USER.md": `SECOND_${nonce}\n`,
        },
      });
      result.secondAgent = { id: second.id };
      role = await api("POST", `${namespace}/iam/roles`, {
        name: `strands-test-${randomUUID()}`,
        permissions: [{ action: "operate", resourceKind: "secret" }],
      });
      binding = await api("POST", `${namespace}/iam/access-bindings`, {
        subjectKind: "identity",
        subjectId: second.servicePrincipalId,
        roleId: role.id,
        resourceKind: "secret",
        resourceId: fixture.modelSecretId,
      });
      result.secondAgent.iam = {
        servicePrincipalId: second.servicePrincipalId,
        roleId: role.id,
        bindingId: binding.id,
      };
      await api("POST", `${namespace}/agents/${second.id}/runtime-credentials`, {});
      const revision = await api("POST", `${namespace}/agents/${second.id}/deploy`);
      await wait("second Agent deployment", async () => {
        const status = await api(
          "GET",
          `${namespace}/agents/${second.id}/deployments/${revision.id}`,
        );
        assert.notEqual(status.status, "failed", JSON.stringify(status));
        return status.status === "succeeded";
      });
      assert.equal(
        (await api("GET", `${namespace}/agents/${second.id}/workspace/files/USER.md`)).content,
        `SECOND_${nonce}\n`,
      );
      assert.ok(
        !(await api("GET", `${base}/workspace/files/AGENTS.md`)).content.includes(
          `SECOND_${nonce}`,
        ),
      );
      const pods = await objects("pods");
      const claims = (id) =>
        owned(pods, id).flatMap((pod) =>
          pod.spec.volumes
            .filter((volume) => volume.persistentVolumeClaim)
            .map((volume) => volume.persistentVolumeClaim.claimName),
        );
      assert.equal(claims(second.id).length, 2);
      assert.ok(claims(second.id).every((name) => !claims(fixture.agentId).includes(name)));
      result.secondAgent.claims = claims(second.id);
      const otherNode = await workspaceNode(second.id);
      const firstNode = await workspaceNode();
      assert.notEqual(firstNode, otherNode);
      const foreign = await invoke("file_fetch", {
        node: otherNode,
        path: "/home/node/workspace/USER.md",
      });
      assert.ok(
        !foreign.ok || foreign.output?.isError,
        "Agent A cannot use Agent B's node identity",
      );
      const search = await gateway(
        "memory.search",
        { agentId: "main", query: nonce, minScore: 0 },
        second.id,
      );
      assert.ok(
        !JSON.stringify(search.results).includes(memoryFact),
        "Agent B cannot see Agent A's memory index",
      );
      result.secondAgent.foreignNodeRefusal = foreign;
    });
    await check("two Agents execute overlapping real model turns without restarts", async () => {
      const before = await podState();
      const sessions = [randomUUID(), randomUUID()].map((id) => `agent:main:parallel-${id}`);
      const replies = await Promise.all(
        [fixture.agentId, second.id].map((id, index) => {
          // Qualify the native process-session protocol through code mode.
          // Shell session IDs belong to write_stdin, never code-mode wait.
          const command = `sleep 5; printf '%s\\n' '${nonce}_AGENT_${index}' > parallel-receipt.txt; cat parallel-receipt.txt`;
          const source = `let r = await tools.exec_command({cmd: ${JSON.stringify(command)}, yield_time_ms: 1000, max_output_tokens: 300}); if (r.session_id !== undefined) r = await tools.write_stdin({session_id: r.session_id, chars: "", yield_time_ms: 10000, max_output_tokens: 300}); if (r.exit_code !== 0) throw new Error("command did not complete: " + JSON.stringify(r)); text("Process exited with code 0\\n" + r.output);`;
          return turn(
            `Use native exec_command to run this command once: ${command}. Set yield_time_ms to 1000; if it returns a process session ID, use write_stdin with that session_id to wait for completion. Do not pass a process session ID to code-mode wait. If using code mode, the equivalent JavaScript is: ${source} Then reply ${nonce}. Do not delegate, repeat the command or retry errors.`,
            [`${nonce}_AGENT_${index}`, "Process exited with code 0"],
            sessions[index],
            id,
          );
        }),
      );
      const traces = result.turns.filter((entry) => sessions.includes(entry.sessionKey));
      assert.equal(traces.length, 2);
      assert.ok(
        traces.every(
          (entry) =>
            !entry.messages.some((message) => message.role === "toolResult" && message.isError),
        ),
        "concurrency must complete without a failed tool or a recovery retry",
      );
      const starts = traces.map((entry) =>
        Math.min(...entry.messages.map((message) => message.timestamp).filter(Number.isFinite)),
      );
      const ends = traces.map((entry) =>
        Math.max(
          ...entry.messages
            .filter((message) => message.role === "assistant" && message.stopReason === "stop")
            .map((message) => message.timestamp),
        ),
      );
      assert.ok(Math.max(...starts) < Math.min(...ends), "real conversations overlap");
      const after = await podState();
      for (const pod of before.filter((entry) =>
        [fixture.agentId, second.id].includes(entry.agentId),
      )) {
        assert.deepEqual(
          after.find((entry) => entry.uid === pod.uid),
          pod,
          "no Pod replacement or container restart during concurrency",
        );
      }
      result.concurrentAgents = {
        agentIds: [fixture.agentId, second.id],
        sessions,
        starts,
        ends,
        replies,
        unchangedPods: true,
      };
    });
  } finally {
    if (second) {
      await check(
        "deleting second Agent removes its resources and preserves first Agent",
        async () => {
          await api("DELETE", `${namespace}/agents/${second.id}`);
          await wait(
            "second Agent deletion",
            async () =>
              !(await api("GET", `${namespace}/agents`)).some((agent) => agent.id === second.id),
            420000,
          );
          assert.equal(
            owned(
              await objects("pods,deployments,services,configmaps,networkpolicies,pvc"),
              second.id,
            ).length,
            0,
          );
          assert.equal((await api("GET", base)).desiredRuntimeState, "running");
          assert.ok((await memory()).results.some((hit) => hit.snippet.includes(memoryFact)));
          // Agent deletion owns removal of its exact IAM grants. Keep these
          // assertions inside the recorded check; do not delete grants twice.
          if (binding) {
            const bindings = await api("GET", `${namespace}/iam/access-bindings`);
            result.secondAgent.iam.remainingBinding = bindings.find(
              (item) => item.id === binding.id,
            );
            assert.equal(result.secondAgent.iam.remainingBinding, undefined);
          }
          if (role) {
            await api("DELETE", `${namespace}/iam/roles/${role.id}`);
            result.secondAgent.iam.roleRemoved = true;
          }
        },
      );
    }
  }
}
