import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import {
  KubernetesObjectApi,
  RequestContext,
} from "../../apps/controller/node_modules/@kubernetes/client-node/dist/index.js";

export function interruptLifecycleResponses(t: TestContext, server: string, namespace: string) {
  const origin = new URL(server).origin;
  const batchPath =
    "/apis/sandbox.opensandbox.io/v1alpha1/namespaces/" + namespace + "/batchsandboxes";
  const podPath = "/api/v1/namespaces/" + namespace + "/pods/";
  const getDispatcher = RequestContext.prototype.getDispatcher;
  const seen = {
    creates: 0,
    createReplyLost: false,
    deleteReplyLost: false,
    predecessorReadbacks: 0,
    predecessorPodAbsent: false,
    prematureCreates: 0,
  };
  let predecessor: { sandbox: string; pod: string } | undefined;
  t.mock.method(RequestContext.prototype, "getDispatcher", function (this: RequestContext) {
    const dispatcher = getDispatcher.call(this);
    const url = new URL(this.getUrl());
    if (url.origin !== origin) {
      return dispatcher;
    }

    const method = this.getHttpMethod();
    const creating = method === "POST" && url.pathname === batchPath;
    const oldBatch =
      predecessor !== undefined && url.pathname === batchPath + "/" + predecessor.sandbox;
    const oldPod = predecessor !== undefined && url.pathname === podPath + predecessor.pod;
    if (!creating && !oldBatch && !oldPod) {
      return dispatcher;
    }
    assert.ok(dispatcher, "Kubernetes must use its authenticated TLS transport");
    if (creating) {
      seen.creates += 1;
      if (predecessor !== undefined && !seen.predecessorPodAbsent) {
        seen.prematureCreates += 1;
      }
    }
    return dispatcher.compose(
      (dispatch) => (options, handler) =>
        dispatch(
          options,
          new Proxy(handler, {
            get(target, key) {
              if (key === "onResponseStart") {
                const response: NonNullable<typeof handler.onResponseStart> = (
                  controller,
                  status,
                  headers,
                  message,
                ) => {
                  const lostCreate = creating && status === 201 && !seen.createReplyLost;
                  const lostDelete =
                    oldBatch &&
                    method === "DELETE" &&
                    [200, 202].includes(status) &&
                    !seen.deleteReplyLost;
                  if (lostCreate || lostDelete) {
                    seen.createReplyLost ||= lostCreate;
                    seen.deleteReplyLost ||= lostDelete;
                    // The real API applied the request. Suppress its reply at the HTTP boundary.
                    controller.abort(
                      Object.assign(new Error("The Kubernetes response was lost"), {
                        code: "ECONNRESET",
                      }),
                    );
                    return;
                  }
                  if (method === "GET" && seen.deleteReplyLost) {
                    if (oldBatch && status === 200) {
                      seen.predecessorReadbacks += 1;
                    }
                    if (oldPod && status === 404) {
                      seen.predecessorPodAbsent = true;
                    }
                  }
                  target.onResponseStart?.(controller, status, headers, message);
                };
                return response;
              }
              const value: unknown = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
    );
  });
  return {
    seen,
    observePredecessor(sandbox: string, pod: string) {
      predecessor = { sandbox, pod };
    },
  };
}

// Change the real cluster after a successful list. Return the original Kubernetes
// snapshot unchanged, as if another writer replaced the object during delivery.
export function replaceListedSandbox(
  t: TestContext,
  client: unknown,
  name: string,
  uid: string,
  replace: () => Promise<void>,
) {
  assert.ok(client instanceof KubernetesObjectApi);
  const list = client.list.bind(client);
  return t.mock.method(client, "list", async (...args: Parameters<typeof list>) => {
    const snapshot = await list(...args);
    if (args[1] === "BatchSandbox") {
      assert.ok(args[2]);
      assert.equal(snapshot.items.length, 1);
      const [batch] = snapshot.items;
      assert.equal(batch?.metadata?.name, name);
      assert.equal(batch?.metadata?.uid, uid);
      assert.equal(batch?.metadata?.namespace, args[2]);
      await client.delete(
        {
          apiVersion: args[0],
          kind: args[1],
          metadata: { name, namespace: args[2] },
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { preconditions: { uid } },
      );
      await replace();
    }
    return snapshot;
  });
}
