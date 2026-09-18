import { immutableCopy } from "@openclaw-enterprise/utils";
import { Check } from "typebox/value";
import { HarnessAuthBindingSchema } from "./api/common.ts";
import type { HarnessAuthBinding, HarnessAuthSnapshot } from "./index.ts";

/** Use the public binding grammar for every intent entry point. */
export function normalizeHarnessAuthBinding(input: unknown): HarnessAuthBinding | null {
  if (input === null) {
    return null;
  }
  if (!Check(HarnessAuthBindingSchema, input)) {
    throw new Error("Harness authentication requires one supported exact source binding.");
  }
  return immutableCopy(input as HarnessAuthBinding);
}

/** Public intent excludes private admission and delivery metadata. */
export function harnessAuthBindingFromSnapshot(snapshot: HarnessAuthSnapshot): HarnessAuthBinding {
  if (snapshot.method === "api_key") {
    return { method: snapshot.method, source: snapshot.source };
  }
  if (snapshot.method === "chatgpt_service_account") {
    return { method: snapshot.method, serviceAccountId: snapshot.serviceAccountId };
  }
  return { method: snapshot.method };
}
