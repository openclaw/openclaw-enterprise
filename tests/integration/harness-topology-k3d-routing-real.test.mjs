import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  arrangeProductionTopology,
  assertActualModelTurn,
  assertActualPublicGithubRead,
  assertGatewayWorkspaceReconnect,
  assertRoutedWorkspaceFileReads,
  assertRoutedWorkspaceFilesThroughOcc,
  assertRoutedWorkspaceModelTurn,
  gatewayCall,
  kubectl,
  messageText,
  requiresGatewayRouting,
  resource,
  waitFor,
  waitForGatewayHistory,
  waitForReadyGatewayPod,
} from "../helpers/harness-topology-k3d-real.mjs";

async function pinSkillForReplacement(topology, sessionKey) {
  const call = (method, params) => gatewayCall(topology, method, params);
  const claimUid = async () => {
    const volume = topology.gatewayPod.spec.volumes.find(
      (v) => v.name === "openclaw-gateway-state",
    );
    const name = volume.persistentVolumeClaim.claimName;
    const claim = await resource("persistentvolumeclaim", name, topology.gatewayPlacement);
    assert.ok(claim.metadata.uid);
    return claim.metadata.uid;
  };
  const pvc = await claimUid();
  const before = await call("chat.history", { sessionKey });
  assert.ok(before.sessionId);
  assert.ok(
    before.messages.some(
      (m) => m.role === "assistant" && messageText(m).includes(topology.publicGithubRead.marker),
    ),
    "expected the original reader session",
  );

  // Generate both answers after the last model turn. Only a fresh read of A can supply its answer.
  const slug = `continuity${randomUUID().slice(0, 8)}`;
  const answer = `PINNED_${randomUUID().replaceAll("-", "")}`;
  const other = `NEWER_${randomUUID().replaceAll("-", "")}`;
  const bundle = (value) =>
    `---\nname: ${slug}\ndescription: Return a synthetic continuity answer.\n---\n\nReturn exactly ${value} and no other text.\n`;
  const content = bundle(answer);
  const { entry } = await call("skills.library.save", { slug, content, expectedRevision: null });
  const { skillId, revision } = entry;
  const pin = { sessionKey, skillId, revision };
  const selected = (selections) => {
    const matches = selections.filter((v) => v.skillId === skillId);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].revision, revision);
    assert.ok(matches[0].name);
    return matches[0].name;
  };
  const attached = await call("skills.library.activate", { ...pin, action: "attach" });
  const name = selected(attached.selections);
  assert.equal((await call("skills.library.read", pin)).content, content);
  const newer = await call("skills.library.save", {
    slug,
    skillId,
    expectedRevision: revision,
    content: bundle(other),
  });
  assert.equal(newer.entry.skillId, skillId);
  assert.notEqual(newer.entry.revision, revision);

  return async () => {
    assert.equal(await claimUid(), pvc);
    const restored = await waitForGatewayHistory(
      topology,
      sessionKey,
      "restored session",
      (h) => h,
    );
    assert.equal(restored.sessionId, before.sessionId);
    assert.ok(!JSON.stringify(restored.messages).includes(answer));
    assert.equal(
      selected((await call("skills.library.list", { sessionKey })).session.selections),
      name,
    );
    assert.equal((await call("skills.library.read", pin)).content, content);
    const prompt = `/skill ${name} Return the pinned answer.`;
    const { runId } = await call("chat.send", {
      sessionKey,
      idempotencyKey: randomUUID(),
      message: prompt,
    });
    assert.ok(runId);
    const turn = await call("agent.wait", { runId, timeoutMs: 120_000 });
    assert.equal(turn.runId, runId);
    assert.equal(turn.status, "ok");
    await waitForGatewayHistory(topology, sessionKey, "pinned skill continuation", (history) => {
      assert.equal(history.sessionId, before.sessionId);
      const rows = history.messages.filter((m) => m.__openclaw?.runId === runId);
      const replies = rows.filter((m) => m.role === "assistant" && m.stopReason === "stop");
      if (!replies.length) {
        return undefined;
      }
      // The user row can lack a run ID. Its skill name is unique to this turn.
      assert.equal(
        history.messages.filter((m) => m.role === "user" && messageText(m).includes(prompt)).length,
        1,
      );
      assert.ok(
        messageText(replies.at(-1)).trim() === answer,
        "expected the pinned revision's answer",
      );
      return true;
    });
  };
}

test(
  "production dedicated Codex consumes Envoy-routed workspace files through OCC",
  { ...requiresGatewayRouting, timeout: 900_000 },
  async (context) => {
    try {
      const topology = await arrangeProductionTopology(context, "dedicated", undefined, {
        gatewayPassword: true,
        workspaceGateway: true,
        sandboxPreview: true,
        publicGithubRead: true,
      });
      const connection = await topology.workspaceGateway.connect(topology);
      // Trusted-proxy routing must retain password-authenticated direct loopback access.
      await assertActualModelTurn(topology);
      const sessionKey = await assertActualPublicGithubRead(topology);
      const routeBefore = await resource(
        "httproute",
        topology.gatewayServiceName,
        topology.gatewayPlacement,
      );
      for (const verb of ["get", "create", "patch", "delete"]) {
        for (const resourceName of [
          "httproutes.gateway.networking.k8s.io",
          "securitypolicies.gateway.envoyproxy.io",
        ]) {
          const denied = await kubectl(
            "auth",
            "can-i",
            verb,
            resourceName,
            "--namespace",
            topology.gatewayPlacement,
            `--as=system:serviceaccount:${topology.platformNamespace}:${topology.apiAccount}`,
          ).catch(({ stdout }) => stdout);
          assert.equal(
            denied.trim(),
            "no",
            "the OCC API must not manage tenant routes or policies",
          );
        }
      }
      const proof = await assertRoutedWorkspaceFilesThroughOcc(topology, connection);
      context.diagnostic(
        "Real Envoy and Compute-created HTTPRoute passed four OCC file writes/reads and fresh native model consumption without API restart.",
      );
      await connection.assertSecurity();
      await connection.assertNodeAuthentication();
      await connection.assertSandboxPreview();
      context.diagnostic(
        "Compute enrollment observed native pairing and reconnect; missing attachment upload support failed readiness. Forged proxy identity and operator escalation were denied.",
      );
      await connection.rotateApiKey(() => assertRoutedWorkspaceFileReads(topology, proof.files));
      await assertRoutedWorkspaceFileReads(topology, proof.files);
      const certificates = await connection.renewCertificate();
      assert.notEqual(certificates.previous.serialNumber, certificates.next.serialNumber);
      await assertRoutedWorkspaceFileReads(topology, proof.files);
      context.diagnostic(
        "Real Envoy rejected missing/invalid credentials and direct peers; key rotation and served certificate renewal preserved OCC access without restart.",
      );

      const verifyPinnedSkill = await pinSkillForReplacement(topology, sessionKey);

      // Replace only the Pod: the stable route and Service must preserve the same workspace.
      const recoveryStartedAt = Date.now();
      const previousUid = topology.gatewayPod.metadata.uid;
      await kubectl(
        "delete",
        "pod",
        topology.gatewayPod.metadata.name,
        "--namespace",
        topology.gatewayPlacement,
        "--wait=true",
        "--timeout=120s",
      );
      topology.gatewayPod = await waitForReadyGatewayPod(
        topology,
        topology.revision.id,
        previousUid,
      );
      assert.notEqual(topology.gatewayPod.metadata.uid, previousUid);
      context.diagnostic(
        "Replacement Gateway Pod is Ready; waiting for its native workspace connection.",
      );
      await assertGatewayWorkspaceReconnect(topology, proof.files.get("AGENTS.md"));
      context.diagnostic(
        `Replacement Gateway read the retained workspace through native RPC after ${Date.now() - recoveryStartedAt} ms; checking OCC routing.`,
      );
      const routeAfter = await resource(
        "httproute",
        topology.gatewayServiceName,
        topology.gatewayPlacement,
      );
      assert.equal(routeAfter.metadata.uid, routeBefore.metadata.uid);
      assert.deepEqual(routeAfter.spec, routeBefore.spec);
      // Pod readiness does not prove route propagation or workspace-node reconnection.
      // Require the real OCC read path to recover before the strict continuity checks.
      await waitFor(
        "OCC workspace access after Gateway Pod replacement",
        async () => {
          const observed = await topology.workspaceRequest(
            "GET",
            `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/workspace/files/AGENTS.md`,
          );
          if (observed.status === 503 && observed.error?.code === "DEPENDENCY_UNAVAILABLE") {
            return undefined;
          }
          assert.equal(observed.status, 200, "the replacement must restore OCC workspace access");
          assert.deepEqual(observed.data, {
            name: "AGENTS.md",
            content: proof.files.get("AGENTS.md"),
          });
          return true;
        },
        60_000,
      );
      await assertRoutedWorkspaceFileReads(topology, proof.files);
      await assertRoutedWorkspaceModelTurn(topology, connection, proof.marker);
      await connection.assertNodeAuthentication();
      await connection.assertSandboxPreview();
      context.diagnostic(
        "Gateway Pod UID changed; unchanged route served four persisted files and a second fresh model session.",
      );
      await verifyPinnedSkill();
      context.diagnostic("The original session answered from its pinned Skill Library revision.");
      // Stop through OCC so the normal worker must remove both serving routes
      // and the node policy, rather than relying on namespace teardown.
      const stopped = await topology.request(
        "POST",
        `/namespaces/${topology.agent.namespaceId}/agents/${topology.agent.id}/stop`,
      );
      assert.equal(stopped.status, 202, JSON.stringify(stopped.error));
      await waitFor("worker to remove stopped Agent routing", async () => {
        for (const [kind, name] of [
          ["httproute", topology.gatewayServiceName],
          ["httproute", `${topology.gatewayServiceName}-node`],
          ["securitypolicy", `${topology.gatewayServiceName}-node`],
          ["httproute", `${topology.gatewayServiceName}-sandbox`],
          ["securitypolicy", `${topology.gatewayServiceName}-sandbox`],
          ["networkpolicy", `${topology.gatewayServiceName}-sandbox`],
        ]) {
          const remaining = await kubectl(
            "get",
            kind,
            name,
            "--namespace",
            topology.gatewayPlacement,
            "--ignore-not-found=true",
            "-o",
            "name",
          );
          if (remaining.trim()) {
            return undefined;
          }
        }
        return true;
      });
    } catch (error) {
      // Emit the failure before Kubernetes teardown so the live run can be diagnosed promptly.
      process.stderr.write(`Private routing proof failed: ${error.message}\n`);
      throw error;
    }
  },
);
