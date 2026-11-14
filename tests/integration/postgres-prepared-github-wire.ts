import assert from "node:assert/strict";
import { KeyObject } from "node:crypto";
import type { Server } from "node:https";
import type { TestContext } from "node:test";
import type {
  EgressRef,
  EgressSourceKey,
  PreparedTokenEvidence,
} from "../../packages/contracts/src/index.ts";
import type { Clock } from "../../apps/controller/src/drivers/repo/access/backend-contracts.ts";
import type { PostgresPreparedGitHubLifecycle } from "../../apps/controller/src/drivers/repo/github/access/prepared-lifecycle.ts";
import {
  captureMetadata as captureMetadataFromFixture,
  dispatchMetadata as dispatchMetadataFromFixture,
  raceMaintenance as raceMaintenanceFromFixture,
} from "../helpers/github-metadata-exchange.mjs";
import {
  listenOnNewOrigin as listenOnNewOriginFromFixture,
  startGitHubFixture,
} from "../fixtures/repository-credentials/github.mjs";
import { wireTime as fixtureWireTime } from "../helpers/static-egress.mjs";

// The shared JavaScript helpers remain callable from their existing tests. Treat
// their results as unknown until this suite checks the wire fields it uses.
export const callFixture: (
  target: (...args: never[]) => unknown,
  receiver: unknown,
  args: readonly unknown[],
) => unknown = Reflect.apply;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resourceId(value: unknown): string {
  assert.ok(record(value) && typeof value.id === "string");
  return value.id;
}

function egressRef(value: unknown): value is EgressRef {
  return record(value) && typeof value.id === "string" && typeof value.generation === "number";
}

function sourceKey(value: unknown): value is EgressSourceKey {
  return (
    record(value) &&
    typeof value.installationId === "string" &&
    typeof value.namespaceId === "string" &&
    egressRef(value.source) &&
    egressRef(value.backend) &&
    egressRef(value.provider)
  );
}

function preparedEvidence(value: unknown): value is PreparedTokenEvidence {
  return (
    record(value) &&
    value.kind === "prepared_github" &&
    sourceKey(value.source) &&
    egressRef(value.binding) &&
    egressRef(value.family) &&
    typeof value.ownerEpoch === "number" &&
    typeof value.inputVersion === "string" &&
    typeof value.preparationAttemptId === "string" &&
    typeof value.materialId === "string" &&
    typeof value.materialVersion === "string" &&
    typeof value.providerExpiresAt === "string" &&
    typeof value.usableUntil === "string" &&
    typeof value.grantHash === "string" &&
    typeof value.isolationId === "string"
  );
}

const parseEvidenceJson: (text: string) => unknown = JSON.parse;

export function readPreparedEvidence(wire: ReadySelection["evidence"]): PreparedTokenEvidence {
  const value = parseEvidenceJson(wire.authority_evidence.toString("utf8"));
  assert.ok(preparedEvidence(value), "signed selection carries prepared GitHub evidence");
  return value;
}

interface WireTime {
  seconds: number | string;
  nanos: number;
}

export function wireTime(millis: number): WireTime {
  return fixtureWireTime(millis);
}

// Fields used by the scenarios. The shared fixture retains the original signed packet.
export interface CapturedMetadata {
  deadline: WireTime;
  request: { context: { request_id: string } };
}

export interface ReadySelection {
  evidence: { authority_evidence: Buffer };
}

export interface LifecycleEgress {
  readonly installation: unknown;
  readonly capture: () => unknown;
  resolve(
    request: CapturedMetadata,
  ): Promise<{ ready: ReadySelection | undefined; refused: Refusal | undefined }>;
  permitRequest(request: CapturedMetadata, ready: ReadySelection): unknown;
  authorize(permit: unknown): Promise<{ allowed: unknown; refused: Refusal | undefined }>;
  protect(request: CapturedMetadata, response: unknown): Promise<unknown>;
  refusalCode(name: "DENIED" | "DEADLINE_EXCEEDED"): number;
}

interface Refusal {
  code: number;
}

function refusal(value: unknown): value is Refusal {
  return record(value) && typeof value.code === "number";
}

function readySelection(value: unknown): value is ReadySelection {
  return (
    record(value) && record(value.evidence) && Buffer.isBuffer(value.evidence.authority_evidence)
  );
}

interface DeployedEgress extends Pick<
  LifecycleEgress,
  "installation" | "capture" | "permitRequest" | "protect"
> {
  readonly namespace: unknown;
  readonly agent: unknown;
  readonly secretReads: number;
  resolve(request: CapturedMetadata): Promise<unknown>;
  authorize(permit: unknown): Promise<unknown>;
  refusalCode(name: string): unknown;
  revoke(): Promise<void>;
}

export function deployedEgress(value: unknown): value is DeployedEgress {
  return (
    record(value) &&
    value.fixtureKind === "deployed" &&
    typeof value.secretReads === "number" &&
    typeof value.capture === "function" &&
    typeof value.resolve === "function" &&
    typeof value.permitRequest === "function" &&
    typeof value.authorize === "function" &&
    typeof value.protect === "function" &&
    typeof value.refusalCode === "function" &&
    typeof value.revoke === "function"
  );
}

export function wireResponses(
  raw: DeployedEgress,
): Pick<LifecycleEgress, "resolve" | "authorize" | "refusalCode"> {
  return {
    async resolve(request) {
      const reply = await raw.resolve(request);
      assert.ok(record(reply));
      const { ready, refused } = reply;
      assert.ok(ready === undefined || readySelection(ready));
      assert.ok(refused === undefined || refusal(refused));
      return { ready, refused };
    },
    async authorize(permit) {
      const reply = await raw.authorize(permit);
      assert.ok(record(reply));
      const { allowed, refused } = reply;
      assert.ok(refused === undefined || refusal(refused));
      return { allowed, refused };
    },
    refusalCode(name) {
      const code = raw.refusalCode(name);
      assert.equal(typeof code, "number");
      return Number(code);
    },
  };
}

export function captureMetadata(fixture: LifecycleEgress): CapturedMetadata {
  const request = callFixture(captureMetadataFromFixture, undefined, [fixture]);
  assert.ok(capturedMetadata(request));
  return request;
}

function capturedMetadata(request: unknown): request is CapturedMetadata {
  return (
    record(request) &&
    record(request.deadline) &&
    (typeof request.deadline.seconds === "number" ||
      typeof request.deadline.seconds === "string") &&
    typeof request.deadline.nanos === "number" &&
    record(request.request) &&
    record(request.request.context) &&
    typeof request.request.context.request_id === "string"
  );
}

export async function dispatchMetadata(
  fixture: LifecycleEgress,
  gh: GitHubFixture,
  request: CapturedMetadata,
  ready: ReadySelection,
) {
  const response = await callFixture(dispatchMetadataFromFixture, undefined, [
    fixture,
    gh,
    request,
    ready,
  ]);
  assert.ok(
    record(response) && typeof response.status === "number" && Buffer.isBuffer(response.body),
  );
  return { status: response.status, body: response.body };
}

export async function raceMaintenance(
  owners: PostgresPreparedGitHubLifecycle[],
  signal: AbortSignal,
): Promise<unknown> {
  return callFixture(raceMaintenanceFromFixture, undefined, [owners, signal]);
}

export async function listenOnNewOrigin(
  t: TestContext,
  createIssuer: () => Server,
): Promise<string> {
  const origin = await callFixture(listenOnNewOriginFromFixture, undefined, [t, createIssuer]);
  assert.ok(typeof origin === "string");
  return origin;
}

interface IssuedToken {
  token: string;
  expires_at: string;
  permissions: Readonly<Record<string, string>>;
  repository_selection: "selected";
  repositories: ReadonlyArray<{ id: number }>;
}

export interface GitHubFixtureOptions {
  tokenLifetimeMs?: number;
  tokenResponse?(packet: IssuedToken): IssuedToken;
  beforeIssueResponse?(): Promise<void>;
  issueResponseGate?(): Promise<void> | undefined;
  revokeResponseGate?(): Promise<void> | undefined;
}

interface GitHubFixture {
  readonly origin: string;
  readonly tls: { ca: Buffer; key: Buffer; cert: Buffer };
  readonly privateKey: KeyObject;
  readonly issuesOfTokens: ReadonlyArray<{
    repositoryIds: readonly (string | number)[] | "installation";
    permissions: Readonly<Record<string, string>>;
  }>;
  readonly trace: ReadonlyArray<{ method: string; target: string }>;
  readonly errors: readonly unknown[];
  tokenState(): ReadonlyArray<{ revoked: boolean }>;
  setIssueStatus(status: number, body?: string): void;
  setRevokeStatus(status: number): void;
  disconnectAfterMutation(method: "POST", target: string): void;
}

export async function startLifecycleGitHub(
  t: TestContext,
  clock: Clock,
  options: GitHubFixtureOptions,
): Promise<GitHubFixture> {
  // The fixture's default clock has extra test controls, but the protocol uses
  // the Clock contract. Pass the system clock without requiring those controls.
  const started: unknown = await callFixture(startGitHubFixture, undefined, [
    t,
    { clock, ...options },
  ]);
  assert.ok(githubFixture(started));
  return started;
}

function githubFixture(value: unknown): value is GitHubFixture {
  return (
    record(value) &&
    typeof value.origin === "string" &&
    record(value.tls) &&
    Buffer.isBuffer(value.tls.ca) &&
    Buffer.isBuffer(value.tls.key) &&
    Buffer.isBuffer(value.tls.cert) &&
    value.privateKey instanceof KeyObject &&
    Array.isArray(value.issuesOfTokens) &&
    Array.isArray(value.trace) &&
    Array.isArray(value.errors) &&
    typeof value.tokenState === "function" &&
    typeof value.setIssueStatus === "function" &&
    typeof value.setRevokeStatus === "function" &&
    typeof value.disconnectAfterMutation === "function"
  );
}
