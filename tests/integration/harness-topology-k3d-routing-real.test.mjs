import assert from "node:assert/strict";
import test from "node:test";
import {
  arrangeProductionTopology,
  assertActualModelTurn,
  assertRoutedWorkspaceFileReads,
  assertRoutedWorkspaceFilesThroughOcc,
  assertRoutedWorkspaceModelTurn,
  kubectl,
  requiresGatewayRouting,
  resource,
  waitFor,
  waitForReadyGatewayPod,
} from "../helpers/harness-topology-k3d-real.mjs";

test(
  "production dedicated Codex consumes Envoy-routed workspace files through OCC",
  { ...requiresGatewayRouting, timeout: 900_000 },
  async (context) => {
    try {
      const topology = await arrangeProductionTopology(context, "dedicated", undefined, {
        gatewayPassword: true,
        workspaceGateway: true,
        sandboxPreview: true,
      });
      const connection = await topology.workspaceGateway.connect(topology);
      // Trusted-proxy routing must retain password-authenticated direct loopback access.
      await assertActualModelTurn(topology);
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

      // Replace only the Pod: the stable route and Service must preserve the same workspace.
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
      const routeAfter = await resource(
        "httproute",
        topology.gatewayServiceName,
        topology.gatewayPlacement,
      );
      assert.equal(routeAfter.metadata.uid, routeBefore.metadata.uid);
      assert.deepEqual(routeAfter.spec, routeBefore.spec);
      await assertRoutedWorkspaceFileReads(topology, proof.files);
      await assertRoutedWorkspaceModelTurn(topology, connection, proof.marker);
      await connection.assertNodeAuthentication();
      await connection.assertSandboxPreview();
      context.diagnostic(
        "Gateway Pod UID changed; unchanged route served four persisted files and a second fresh model session.",
      );
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
