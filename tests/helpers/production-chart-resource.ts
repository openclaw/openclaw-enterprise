import assert from "node:assert/strict";
import Type from "typebox";
import { Check } from "typebox/value";
import { asRecord } from "../../packages/utils/src/index.ts";

export const namedChartResource = Type.Object({
  kind: Type.String(),
  metadata: Type.Object({ name: Type.String() }),
});

export function findResource<T extends { kind: string; metadata: { name: string } }>(
  objects: readonly T[],
  kind: string,
  name: string,
): T | undefined {
  return objects.find((object) => object.kind === kind && object.metadata.name === name);
}

export function findChartJob(documents: readonly unknown[], name?: string) {
  const job = documents.find((document) => {
    const resource = asRecord(document);
    return (
      resource?.kind === "Job" && (name === undefined || asRecord(resource.metadata)?.name === name)
    );
  });
  const jobShape = Type.Intersect([
    namedChartResource,
    Type.Object({
      metadata: Type.Record(Type.String(), Type.Unknown()),
      spec: Type.Record(Type.String(), Type.Unknown()),
    }),
  ]);
  assert.ok(
    Check(jobShape, job),
    `Expected Helm to render a named Job with a spec (${name ?? "first Job"})`,
  );
  return job;
}
