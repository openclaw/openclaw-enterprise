import { immutableCopy } from "@openclaw-enterprise/utils";
import { Check } from "typebox/value";
import { HarnessAuthBindingSchema } from "./api/common.ts";
import type {
  HarnessAuthBinding,
  HarnessAuthSnapshot,
  SecretReference,
  ServiceAccountReference,
} from "./index.ts";

/** Source ownership, rather than the native login mode, selects credential resolution. */
export function isSecretHarnessAuth<T extends HarnessAuthBinding | null | undefined>(
  auth: T,
): auth is Extract<T, { readonly source: SecretReference }> {
  return (
    (auth?.method === "api_key" || auth?.method === "codex_pat") && auth.source.kind === "secret"
  );
}

export function isServiceAccountHarnessAuth<T extends HarnessAuthBinding | null | undefined>(
  auth: T,
): auth is Extract<T, { readonly source: ServiceAccountReference }> {
  return auth?.method === "codex_pat" && auth.source.kind === "service_account";
}

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
  if (isSecretHarnessAuth(snapshot)) {
    return snapshot.method === "api_key"
      ? { method: "api_key", source: snapshot.source }
      : { method: "codex_pat", source: snapshot.source };
  }
  if (isServiceAccountHarnessAuth(snapshot)) {
    return { method: snapshot.method, source: snapshot.source };
  }
  if (snapshot.method === "credential_source") {
    return { method: snapshot.method, sourceId: snapshot.sourceId };
  }
  return { method: snapshot.method };
}
