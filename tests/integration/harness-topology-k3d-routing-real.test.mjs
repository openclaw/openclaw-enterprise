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
      });
      const connection = await topology.workspaceGateway.connect(topology);
      // Trusted-proxy routing must retain password-authenticated direct loopback access.
      await assertActualModelTurn(topology);
      const routeBefore = await resource(
        "httproute",
        topology.gatewayServiceName,
        topology.placement,
      );
      for (const verb of ["get", "create", "patch", "delete"]) {
        const denied = await kubectl(
          "auth",
          "can-i",
          verb,
          "httproutes.gateway.networking.k8s.io",
          "--namespace",
          topology.placement,
          `--as=system:serviceaccount:${topology.platformNamespace}:${topology.apiAccount}`,
        ).catch(({ stdout }) => stdout);
        assert.equal(denied.trim(), "no", "the OCC API must not manage tenant HTTPRoutes");
      }
      const proof = await assertRoutedWorkspaceFilesThroughOcc(topology, connection);
      context.diagnostic(
        "Real Envoy and Compute-created HTTPRoute passed four OCC file writes/reads and fresh native model consumption without API restart.",
      );
      await connection.assertSecurity();
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
        topology.placement,
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
        topology.placement,
      );
      assert.equal(routeAfter.metadata.uid, routeBefore.metadata.uid);
      assert.deepEqual(routeAfter.spec, routeBefore.spec);
      await assertRoutedWorkspaceFileReads(topology, proof.files);
      await assertRoutedWorkspaceModelTurn(topology, connection, proof.marker);
      context.diagnostic(
        "Gateway Pod UID changed; unchanged route served four persisted files and a second fresh model session.",
      );
    } catch (error) {
      // Emit the failure before Kubernetes teardown so the live run can be diagnosed promptly.
      process.stderr.write(`Private routing proof failed: ${error.message}\n`);
      throw error;
    }
  },
);
