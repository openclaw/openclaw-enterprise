import test from "node:test";
import { assertSameAnswer, refusedAnswer } from "./credential-source-occ-refusals.ts";
import { administrator, fixture, zeroGrant } from "./credential-source-occ-fixture.ts";

export function registerSourceDisclosureCase(): void {
  test("named source refusals follow the source grant: a missing and an unreadable ID answer alike", async () => {
    // Finding 2536 names the catalog field in a 400, a protected source's update or rotation in a
    // 409 and the deletion fence's wait in a 503. Each reads the stored source, so it must wait for
    // the caller's grant: a caller without it gets the same denial for a source that exists and for
    // one that does not, with each request's own ID hidden.
    const { controller, makeReady, modelSecret, namespace } = await fixture();
    await makeReady();
    const secret = await modelSecret();
    const source = await controller.createCredentialSource(administrator, {
      namespaceId: namespace.id,
      name: "existing-openai",
      type: "openai",
      secrets: { api_key: secret.ref },
    });
    const missingSource = "cs_00000000-0000-4000-8000-00000000aaaa";
    const missingNamespace = "ns_00000000-0000-4000-8000-00000000aaaa";
    const secrets = { api_key: secret.ref, extra: secret.ref };
    // The zero-grant caller's own denial names the ID its request sent.
    const answer = (call: (id: string) => () => Promise<unknown>) => (id: string) =>
      refusedAnswer(call(id), { requested: (value) => value === id, actorId: zeroGrant });
    const update = (id: string) => () =>
      controller.updateCredentialSource(zeroGrant, {
        namespaceId: namespace.id,
        credentialSourceId: id,
        secrets,
      });
    const rotate = (id: string) => () =>
      controller.rotateCredentialSource(zeroGrant, {
        namespaceId: namespace.id,
        credentialSourceId: id,
      });
    const remove = (id: string) => () =>
      controller.deleteCredentialSource(zeroGrant, namespace.id, id);
    for (const [label, call] of Object.entries({ update, rotate, remove })) {
      await assertSameAnswer(answer(call), [source.id, missingSource], { label });
    }
    const create = (namespaceId: string) => () =>
      controller.createCredentialSource(zeroGrant, {
        namespaceId,
        name: "refused-openai",
        type: "openai",
        secrets,
      });
    await assertSameAnswer(answer(create), [namespace.id, missingNamespace], { label: "create" });
  });
}
