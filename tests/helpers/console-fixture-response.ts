import assert from "node:assert/strict";
import type { TSchema } from "typebox";
import { IsSchema } from "typebox/schema";
import { Check } from "typebox/value";

export function createFixtureResponse(context: Record<string, unknown>) {
  const schemas = Object.fromEntries(
    Object.entries(context).map(([id, schema]): [string, TSchema] => {
      assert.ok(IsSchema(schema), "Controller registry entry must be a schema");
      return [id, schema];
    }),
  );

  return function fixtureResponse<T extends TSchema>(
    result: { status: number; body: unknown },
    status: number,
    schema: T,
    operation: string,
  ) {
    assert.equal(result.status, status, `${operation}: unexpected HTTP status`);
    const body = result.body;
    if (!Check(schemas, schema, body)) {
      throw new Error(`${operation}: invalid response envelope`);
    }
    return body;
  };
}
