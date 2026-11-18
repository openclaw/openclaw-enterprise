import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type * as Grpc from "../../apps/controller/node_modules/@grpc/grpc-js" with {
  "resolution-mode": "require",
};
import type * as ProtoLoader from "../../apps/controller/node_modules/@grpc/proto-loader" with {
  "resolution-mode": "require",
};

export type { Grpc };

const controllerRequire = createRequire(
  new URL("../../apps/controller/package.json", import.meta.url),
);
export const grpc = controllerRequire("@grpc/grpc-js") as typeof Grpc;
export const loader = controllerRequire("@grpc/proto-loader") as typeof ProtoLoader;

function packageNamespace(
  value: Grpc.GrpcObject[string] | undefined,
  name: string,
): Grpc.GrpcObject {
  assert.ok(
    value !== undefined && typeof value === "object" && !("format" in value),
    `Missing gRPC package ${name}`,
  );
  return value;
}

export function openShellService(packages: Grpc.GrpcObject): Grpc.ServiceDefinition {
  const openshell = packageNamespace(packages.openshell, "openshell");
  const v1 = packageNamespace(openshell.v1, "openshell.v1");
  const service = v1.OpenShell;
  assert.ok(typeof service === "function", "Missing gRPC service openshell.v1.OpenShell");
  return service.service;
}
