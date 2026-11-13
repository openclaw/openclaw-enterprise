import { randomUUID } from "node:crypto";

import type { PostgresPlatformState } from "../../packages/occ/src/index.ts";

export async function ensureInstallation(state: PostgresPlatformState, name: string) {
  const existing = await state.loadInstallation();
  if (existing !== undefined) {
    return existing;
  }
  return state.transact((unit) =>
    unit.installations.createInstallation({
      id: `ins_${randomUUID()}`,
      name,
      createdAt: new Date().toISOString(),
    }),
  );
}
