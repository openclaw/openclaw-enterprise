import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { TSchema } from "typebox";
import { IsSchema } from "typebox/schema";
import { Check } from "typebox/value";

import { ProvisionAgentBody } from "../../packages/contracts/src/api/common.ts";
import {
  AgentProvisioningResponse,
  type AgentProvisioningStatusWire,
} from "../../packages/contracts/src/api/resources.ts";
import type { createConsoleAppFixture } from "../helpers/console-app.mjs";
import { PROVISIONING_NOT_COMPLETED } from "../helpers/refusal-text.mjs";

const provisioningMeta = { requestId: "req_00000000-0000-4000-8000-000000000001" };

// One provisioning job, `workId`, in `namespaceId`. `job(status, extra)` is one status read of
// it; `failed(extra)` is the read that ends it after its retries (a dependency outage).
export function provisioningJob(namespaceId: string, workId: string) {
  const updatedAt = new Date().toISOString();
  const url = `/namespaces/${namespaceId}/agents/provision/${workId}`;
  // Raw overrides also represent malformed status replies.
  const job = (
    status: AgentProvisioningStatusWire["status"],
    extra: Readonly<Record<string, unknown>> = {},
  ): Record<string, unknown> => ({
    workId,
    status,
    phase: "configuration",
    attemptCount: 1,
    updatedAt,
    url,
    ...extra,
  });
  const failed = (extra: Readonly<Record<string, unknown>> = {}): Record<string, unknown> =>
    job("failed", {
      ...extra,
      error: { code: "PROVISIONING_DEPENDENCY_UNAVAILABLE", message: PROVISIONING_NOT_COMPLETED },
    });
  return { namespaceId, workId, url, updatedAt, job, failed };
}

// Accepts each Create Agent provisioning request in the job's Namespace as that one queued job,
// as the API does, and answers each status read of the job with the next of `reads` (the last
// one repeats), or with `reads(index)` when it is a function. With `reads` null the caller
// routes the job's reads itself. Returns live counts of the requests and reads.
export async function routeProvisioningJob(
  page: Page,
  fixture: Pick<Awaited<ReturnType<typeof createConsoleAppFixture>>, "app">,
  work: ReturnType<typeof provisioningJob>,
  reads: readonly object[] | ((index: number) => object) | null,
) {
  const context: Record<string, unknown> = fixture.app.getSchemas();
  const schemas = Object.fromEntries(
    Object.entries(context).map(([id, schema]): [string, TSchema] => {
      assert.ok(IsSchema(schema), "Controller registry entry must be a schema");
      return [id, schema];
    }),
  );
  const state: { submitted: number; reads: number; requestId: string | undefined } = {
    submitted: 0,
    reads: 0,
    requestId: undefined,
  };
  const admissionPath = `/namespaces/${work.namespaceId}/agents/provision`;
  await page.route(`**/namespaces/${work.namespaceId}/agents/provision`, (route) => {
    const request = route.request();
    if (request.method() !== "POST" || new URL(request.url()).pathname !== admissionPath) {
      return route.fallback();
    }
    const contentType = request.headers()["content-type"] ?? "";
    const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return route.fallback();
    }
    let body: unknown;
    try {
      body = JSON.parse(request.postData() ?? "");
    } catch {
      return route.fallback();
    }
    if (!Check(schemas, ProvisionAgentBody, body)) {
      return route.fallback();
    }
    const accepted = work.job("queued", { phase: "admitted", attemptCount: 0 });
    const response = {
      data: { provisioning: { ...accepted, requestId: body.requestId } },
      meta: provisioningMeta,
    };
    assert.ok(Check(AgentProvisioningResponse, response), "Invalid provisioning admission fixture");
    // Publish admission only after the complete response passes validation.
    state.submitted += 1;
    state.requestId = body.requestId;
    return route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify(response),
    });
  });
  if (reads !== null) {
    await page.route(`**${work.url}`, (route) => {
      const request = route.request();
      if (request.method() !== "GET" || new URL(request.url()).pathname !== work.url) {
        return route.fallback();
      }
      const index = state.reads++;
      const read =
        typeof reads === "function" ? reads(index) : reads[Math.min(index, reads.length - 1)];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          data: { ...read, requestId: state.requestId },
          meta: provisioningMeta,
        }),
      });
    });
  }
  return state;
}
