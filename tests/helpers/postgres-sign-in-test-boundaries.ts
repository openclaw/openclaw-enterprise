import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import pg, { type Pool } from "pg";
import type { composeProduction } from "../../apps/controller/src/composition/production.ts";
import type { HumanAuthenticationAccount } from "../../packages/occ/src/index.ts";
import type { preparePostgresSignInInstallation } from "./postgres-sign-in-installation.mjs";
import {
  accountPrincipalId as untypedAccountPrincipalId,
  changeAccount as untypedChangeAccount,
  createAccount as untypedCreateAccount,
  oidcSignIn as untypedOidcSignIn,
  passwordSignIn as untypedPasswordSignIn,
  postgresSignInState,
  readAccount as readUntypedAccount,
  signedInHeaders as untypedSignedInHeaders,
} from "./production-sign-in.mjs";
import { injectLocalhost as untypedInjectLocalhost } from "./inject-json.mjs";

export type SignInApp = Awaited<
  ReturnType<Awaited<ReturnType<typeof preparePostgresSignInInstallation>>["composeApp"]>
>;
export type App = Pick<Awaited<ReturnType<typeof composeProduction>>, "close" | "inject" | "ready">;
export type SessionHeaders = { host: string; cookie: string; origin: string };
export type Credentials = { email: string; password: string };
export type FixtureAccount = Credentials & { id: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

export function text(value: unknown): string {
  assert.ok(typeof value === "string");
  return value;
}

export function integer(value: unknown): number {
  assert.ok(typeof value === "number");
  assert.ok(Number.isInteger(value));
  return value;
}

function assertFixtureAccount(value: unknown): asserts value is FixtureAccount {
  const account = record(value);
  text(account.id);
  text(account.email);
  text(account.password);
}

type Onboarded<Name extends string> = {
  admin: FixtureAccount;
  roles: { admin: { id: string }; reader: { id: string } };
  accounts: Record<Name, FixtureAccount>;
};

function assertOnboarded<Name extends string>(
  value: unknown,
  names: readonly Name[],
): asserts value is Onboarded<Name> {
  const result = record(value);
  assertFixtureAccount(result.admin);
  const roles = record(result.roles);
  text(record(roles.admin).id);
  text(record(roles.reader).id);
  const accounts = record(result.accounts);
  for (const name of names) {
    assertFixtureAccount(accounts[name]);
  }
}

export function onboarded<const Name extends string>(value: unknown, names: readonly Name[]) {
  assertOnboarded(value, names);
  return value;
}

function assertSessionHeaders(value: unknown): asserts value is SessionHeaders {
  const headers = record(value);
  text(headers.host);
  text(headers.cookie);
  text(headers.origin);
}

function assertAccountSnapshot(value: unknown): asserts value is HumanAuthenticationAccount {
  const account = record(value);
  text(account.userId);
  integer(account.version);
  assert.equal(typeof account.disabled, "boolean");
  text(account.principalId);
  assert.ok(Array.isArray(account.methods));
  const methods: unknown[] = account.methods;
  for (const methodValue of methods) {
    const method = record(methodValue);
    text(method.methodId);
    text(method.providerId);
    text(method.subject);
  }
}

export async function readAccount(app: SignInApp, headers: Record<string, string>, userId: string) {
  const value: unknown = await readUntypedAccount(app, headers, userId);
  assertAccountSnapshot(value);
  return value;
}

export type InjectedResponse = {
  statusCode: number;
  body: string;
  headers: Record<string, unknown> & {
    "set-cookie"?: string | string[];
    location?: string;
    "retry-after"?: string | number;
  };
  json(): unknown;
};

function assertInjectedResponse(value: unknown): asserts value is InjectedResponse {
  const response = record(value);
  integer(response.statusCode);
  text(response.body);
  const headers = record(response.headers);
  const cookie = headers["set-cookie"];
  assert.ok(
    cookie === undefined ||
      typeof cookie === "string" ||
      (Array.isArray(cookie) && cookie.every((part: unknown) => typeof part === "string")),
  );
  assert.ok(headers.location === undefined || typeof headers.location === "string");
  const retryAfter = headers["retry-after"];
  assert.ok(
    retryAfter === undefined || typeof retryAfter === "string" || typeof retryAfter === "number",
  );
  assert.equal(typeof response.json, "function");
}

export function response(value: unknown): InjectedResponse {
  assertInjectedResponse(value);
  return value;
}

// Authentication responses and parser errors can include credentials.
export function parseAuthResponse(
  label: string,
  response: Pick<InjectedResponse, "json">,
): unknown {
  try {
    return response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export async function authOperation<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw new Error(`${label} failed`);
  }
}

export function recordData(value: unknown): Record<string, unknown> {
  return record(record(value).data);
}

export async function injectLocalhost(
  app: App,
  method: string,
  url: string,
  options: Parameters<typeof untypedInjectLocalhost>[3] = {},
): Promise<InjectedResponse> {
  return response(await untypedInjectLocalhost(app, method, url, options));
}

export async function passwordSignIn(
  app: App,
  origin: string,
  account: Credentials,
  remoteAddress?: string,
): Promise<InjectedResponse> {
  return response(await untypedPasswordSignIn(app, origin, account, remoteAddress));
}

export async function changeAccount(
  app: SignInApp,
  headers: SessionHeaders,
  userId: string,
  operation: string,
  expectedVersion?: number,
): Promise<InjectedResponse> {
  return response(await untypedChangeAccount(app, headers, userId, operation, expectedVersion));
}

export async function signedInHeaders(
  app: SignInApp,
  origin: string,
  account: Credentials,
  remoteAddress?: string,
): Promise<SessionHeaders> {
  const headers: unknown = await untypedSignedInHeaders(app, origin, account, remoteAddress);
  assertSessionHeaders(headers);
  return headers;
}

export async function createAccount(
  app: SignInApp,
  headers: SessionHeaders,
  options: { email: string; password: string; roleId: string },
): Promise<FixtureAccount> {
  const account: unknown = await untypedCreateAccount(app, headers, options);
  assertFixtureAccount(account);
  return account;
}

export async function accountPrincipalId(pool: Pool, userId: string): Promise<string> {
  return text(await untypedAccountPrincipalId(pool, userId));
}

export async function oidcSignIn(
  app: SignInApp,
  origin: string,
  provider: NonNullable<Awaited<ReturnType<typeof preparePostgresSignInInstallation>>["oidc"]>,
  authorization: { subject: string },
  remoteAddress: string,
): Promise<{ callback: InjectedResponse }> {
  const result = record(
    await untypedOidcSignIn(app, origin, provider, authorization, remoteAddress),
  );
  return { callback: response(result.callback) };
}

export function account(value: unknown): FixtureAccount {
  assertFixtureAccount(value);
  return value;
}

export function responseData(value: { json(): unknown }): unknown {
  return record(value.json()).data;
}

export function events(value: readonly unknown[]): Record<string, unknown>[] {
  return value.map(record);
}

export function postgresState(context: TestContext, closeFirst: () => (App | undefined)[]) {
  // The JavaScript fixture infers its default close list as never[]; retain its real teardown callback.
  const state = record(Reflect.apply(postgresSignInState, undefined, [context, closeFirst]));
  assert.ok(state.pool instanceof pg.Pool);
  return { pool: state.pool };
}

export function number(value: unknown): number {
  assert.ok(typeof value === "number");
  return value;
}

export function first<T>(values: readonly T[]): T {
  const value = values[0];
  assert.ok(value !== undefined);
  return value;
}

function isApp(value: unknown): value is App {
  return (
    isRecord(value) &&
    typeof value.close === "function" &&
    typeof value.inject === "function" &&
    typeof value.ready === "function"
  );
}

export function app(value: unknown): App {
  assert.ok(isApp(value));
  return value;
}
