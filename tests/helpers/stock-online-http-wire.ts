import assert from "node:assert/strict";
import { KeyObject } from "node:crypto";
import type { TestContext } from "node:test";
import type { OpenShellOnlineHttpAuthorityOptions } from "../../apps/controller/src/drivers/egress-proxy/openshell-online-authority.ts";
import { isArray, isRecord } from "./egress-observation-values.ts";
import { grpc, type Grpc } from "./openshell-grpc-sdk.ts";
import { openShellOnlineWire, token } from "./openshell-online-wire.mjs";

// These fixtures use the stock unary HTTP service with keepCase and numeric enums.
interface BindingConfig {
  fields: Record<
    string,
    { stringValue?: string; numberValue?: number; kind?: "stringValue" | "numberValue" }
  >;
}

export interface HttpEvaluation {
  phase: number;
  middleware_name: string;
  context: { request_id: string; sandbox_id: string; sandbox?: string; workspace?: string };
  config: BindingConfig;
  target: {
    scheme: string;
    host: string;
    port: number;
    method: string;
    path: string;
    query?: string;
  };
  headers?: readonly { name: string; value: string }[];
  body?: Uint8Array;
}

interface UnaryRequests {
  Describe: {
    gateway: {
      protocol_version: { major: number; minor: number };
      supported_capabilities: readonly string[];
      required_capabilities: readonly string[];
    };
  };
  ValidateConfig: { middleware_name: string; config: BindingConfig };
  EvaluateHttpRequest: HttpEvaluation;
}

interface Manifest {
  expected_audience: string;
  bindings: { operation: number; phase: number }[];
  extension: { required_capabilities: string[] };
}

function isManifest(reply: unknown): reply is Manifest {
  return (
    isRecord(reply) &&
    typeof reply.expected_audience === "string" &&
    isArray(reply.bindings) &&
    reply.bindings.every(
      (binding) =>
        isRecord(binding) &&
        typeof binding.operation === "number" &&
        typeof binding.phase === "number",
    ) &&
    isRecord(reply.extension) &&
    isArray(reply.extension.required_capabilities) &&
    reply.extension.required_capabilities.every((capability) => typeof capability === "string")
  );
}

interface HttpDecision {
  decision: number;
  reason_code?: string;
}

function isHttpDecision(reply: unknown): reply is HttpDecision {
  return (
    isRecord(reply) &&
    typeof reply.decision === "number" &&
    (!("reason_code" in reply) || typeof reply.reason_code === "string")
  );
}

export function authorizationMetadata(bearer: string): Grpc.Metadata {
  const metadata = new grpc.Metadata();
  metadata.set("authorization", bearer);
  return metadata;
}

export async function openStockOnlineHttpWire(
  t: TestContext,
  registrationName: string,
  options: Pick<OpenShellOnlineHttpAuthorityOptions, "authorize" | "budgetMs">,
) {
  const wire: unknown = await openShellOnlineWire(t, registrationName, options);
  assert.ok(isRecord(wire));
  const { server, keys } = wire;
  assert.ok(wire.client instanceof grpc.Client && server instanceof grpc.Server);
  const client = wire.client;
  assert.ok(isRecord(keys) && keys.privateKey instanceof KeyObject);

  function start<Method extends keyof UnaryRequests>(
    method: Method,
    request: NoInfer<UnaryRequests[Method]>,
    bearer: string,
  ) {
    const unary: unknown = Reflect.get(client, method);
    assert.ok(typeof unary === "function", `Missing stock unary RPC ${method}`);
    const {
      promise,
      resolve,
      reject,
    }: {
      promise: Promise<unknown>;
      resolve: (reply: unknown) => void;
      reject: (failure: Grpc.ServiceError) => void;
    } = Promise.withResolvers<unknown>();
    const receive: Grpc.requestCallback<unknown> = (error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const call: unknown = Reflect.apply(unary, client, [
      request,
      authorizationMetadata(bearer),
      { deadline: Date.now() + 5000 },
      receive,
    ]);
    assert.ok(isRecord(call) && typeof call.cancel === "function", "Expected a gRPC unary call");
    const cancel = call.cancel;
    return {
      result: promise,
      cancel(): void {
        Reflect.apply(cancel, call, []);
      },
    };
  }

  return {
    server,
    bearer(
      ...[kind, sandboxId, audience]:
        | [kind: "gateway", sandboxId?: undefined, audience?: string]
        | [kind: "supervisor", sandboxId: string, audience?: string]
    ): string {
      const signed: unknown = token(keys, kind, sandboxId, audience);
      assert.ok(typeof signed === "string", "Expected a signed stock bearer");
      return signed;
    },
    async describe(request: UnaryRequests["Describe"], bearer: string) {
      const reply = await start("Describe", request, bearer).result;
      assert.ok(isManifest(reply), "Invalid stock Describe reply");
      return reply;
    },
    async validateConfig(request: UnaryRequests["ValidateConfig"], bearer: string) {
      const reply = await start("ValidateConfig", request, bearer).result;
      assert.ok(
        isRecord(reply) && typeof reply.valid === "boolean",
        "Invalid ValidateConfig reply",
      );
      return reply.valid;
    },
    async evaluate(request: HttpEvaluation, bearer: string) {
      const reply = await start("EvaluateHttpRequest", request, bearer).result;
      assert.ok(isHttpDecision(reply), "Invalid stock HTTP decision envelope");
      return reply;
    },
    startEvaluation(request: HttpEvaluation, bearer: string) {
      return start("EvaluateHttpRequest", request, bearer);
    },
  };
}
