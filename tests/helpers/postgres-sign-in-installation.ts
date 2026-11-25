import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import pg, { type Pool } from "pg";
import type {
  CompositionDependencies,
  ProductionConfig,
  composeProduction,
} from "../../apps/controller/src/composition/production.ts";
import { PostgresPlatformState } from "../../packages/occ/src/index.ts";
import { asRecord } from "../../packages/utils/src/index.ts";
import { databaseUrl } from "./postgres-database.mjs";
import {
  bootstrapProductionInstallation,
  composeProductionSignIn,
  consoleOrigin,
  createAccount,
  currentSession,
  defaultInstallSettings,
  fakeOidc,
  signedInHeaders,
} from "./production-sign-in.mjs";
import type { SignInSettings } from "./sign-in-chart.ts";

export type SignInApp = Awaited<ReturnType<typeof composeProduction>>;
export type FixtureOidc = ReturnType<typeof fakeOidc>;
export type Credentials = { email: string; password: string };
export type FixtureAccount = Credentials & { id: string };

type CloseFirst = () => readonly ({ close(): void | Promise<void> } | undefined)[];

type AuthSecrets = Readonly<Record<string, string> & { "occ-auth/secret": string }>;
type OidcSecrets = AuthSecrets &
  Readonly<Record<"occ-oidc-login/client-id" | "occ-oidc-login/client-secret", string>>;
type FixtureSettings = Credentials & { secrets: AuthSecrets };
type FixtureOptions =
  | (FixtureSettings & { oidc?: false })
  | (FixtureSettings & { oidc: boolean; secrets: OidcSecrets });

type PasswordOptions = {
  passwordHasher?: CompositionDependencies["passwordHasher"];
  passwordSlowLaneFloors?: ProductionConfig["passwordSlowLaneFloors"];
};
type AccountInput = { email: string; role?: keyof Awaited<ReturnType<typeof installationRoles>> };
type OnboardOptions = PasswordOptions & { remoteAddress?: string | undefined };
type Onboarded<Name extends string> = {
  admin: FixtureAccount;
  roles: Awaited<ReturnType<typeof installationRoles>>;
  accounts: Record<Name, FixtureAccount>;
};

type Onboard = {
  <const Name extends string>(
    options: OnboardOptions & { accounts: Record<Name, AccountInput> },
  ): Promise<Onboarded<Name>>;
  (options?: OnboardOptions & { accounts?: undefined }): Promise<Onboarded<never>>;
};

type ComposeOptions = Omit<
  Parameters<typeof composeProductionSignIn>[1],
  "settings" | "databaseUrl" | "secrets"
> & {
  databaseUrl?: string;
  secrets?: Readonly<Record<string, string>>;
};

type SignInInstallation<Provider> = ReturnType<typeof postgresSignInState> & {
  oidc: Provider;
  onboard: Onboard;
  composeApp(settings: SignInSettings, options?: ComposeOptions): Promise<SignInApp>;
};

/** Read the current app list at teardown, then close the fixture's pool after the apps. */
export function postgresSignInState(context: TestContext, closeFirst: CloseFirst = () => []) {
  const pool = new pg.Pool({
    ...(databaseUrl === undefined ? {} : { connectionString: databaseUrl }),
  });
  const state = new PostgresPlatformState(pool);
  context.after(async () => {
    for (const closable of closeFirst()) {
      await closable?.close();
    }
    await pool.end();
  });
  return { pool, state };
}

/** Find the bootstrapped administrator Role and add the fixture's read-only Role. */
export async function installationRoles(state: PostgresPlatformState, pool: Pool) {
  const installation = await state.loadInstallation();
  assert.ok(installation, "Expected the bootstrapped Installation.");
  const { roles } = await state.loadNativeIAMState(installation.id);
  const admin = roles.find((role) =>
    role.permissions.some(
      ({ action, resourceKind }) => action === "administer" && resourceKind === "installation",
    ),
  );
  if (admin === undefined) {
    throw new Error("The bootstrap policy lacks an Installation administrator Role.");
  }
  const reader = { id: "role_installation_reader_fixture" };
  await pool.query(
    `INSERT INTO occ.iam_roles (id, namespace_id, name, permissions)
     VALUES ($1, NULL, 'Installation reader', $2::jsonb) ON CONFLICT (id) DO NOTHING`,
    [reader.id, JSON.stringify([{ action: "read", resourceKind: "installation" }])],
  );
  return { admin, reader };
}

type OnboardingInstallation = FixtureSettings &
  ReturnType<typeof postgresSignInState> & {
    databaseUrl: string | undefined;
    authSecret: string;
  };

export function onboardPasswordAccounts<const Name extends string>(
  context: TestContext,
  options: OnboardingInstallation & OnboardOptions & { accounts: Record<Name, AccountInput> },
): Promise<Onboarded<Name>>;
export function onboardPasswordAccounts(
  context: TestContext,
  options: OnboardingInstallation & OnboardOptions & { accounts?: undefined },
): Promise<Onboarded<never>>;
/** Onboard named accounts through the default password installation, then close its app. */
export async function onboardPasswordAccounts(
  context: TestContext,
  {
    databaseUrl,
    state,
    pool,
    email,
    authSecret,
    secrets,
    password,
    accounts = {},
    remoteAddress,
    passwordSlowLaneFloors,
    passwordHasher,
  }: OnboardingInstallation &
    OnboardOptions & { accounts?: Record<string, AccountInput> | undefined },
): Promise<Onboarded<string>> {
  const recovery = {
    email,
    password: await bootstrapProductionInstallation(context, { databaseUrl, email, authSecret }),
  };
  const roles = await installationRoles(state, pool);
  const app = await composeProductionSignIn(context, {
    databaseUrl,
    settings: defaultInstallSettings,
    secrets,
    passwordSlowLaneFloors,
    passwordHasher,
  });
  try {
    const headers = await signedInHeaders(app, consoleOrigin, recovery, remoteAddress);
    const session: unknown = await currentSession(app, headers.cookie);
    const id = asRecord(asRecord(session)?.user)?.id;
    assert.ok(typeof id === "string", "Expected a recovery user ID in the active session.");
    const created: [string, FixtureAccount][] = [];
    for (const [name, account] of Object.entries(accounts)) {
      const roleName = account.role ?? "reader";
      const role = Object.hasOwn(roles, roleName) ? roles[roleName] : undefined;
      if (role === undefined) {
        throw new Error(`Unknown Installation Role ${account.role} for ${name}.`);
      }
      created.push([
        name,
        await createAccount(app, headers, { email: account.email, password, roleId: role.id }),
      ]);
    }
    return { admin: { ...recovery, id }, roles, accounts: Object.fromEntries(created) };
  } finally {
    await app.close();
  }
}

export function preparePostgresSignInInstallation(
  context: TestContext,
  closeFirst: CloseFirst,
  options: FixtureSettings & { oidc: true; secrets: OidcSecrets },
): Promise<SignInInstallation<FixtureOidc>>;
export function preparePostgresSignInInstallation(
  context: TestContext,
  closeFirst: CloseFirst,
  options: FixtureSettings & { oidc?: false },
): Promise<SignInInstallation<undefined>>;
export function preparePostgresSignInInstallation(
  context: TestContext,
  closeFirst: CloseFirst,
  options: FixtureOptions,
): Promise<SignInInstallation<FixtureOidc | undefined>>;
/** Prepare PostgreSQL once, then let the caller onboard accounts and compose each app. */
export async function preparePostgresSignInInstallation(
  context: TestContext,
  closeFirst: CloseFirst,
  options: FixtureOptions,
): Promise<SignInInstallation<FixtureOidc | undefined>> {
  const { email, password, secrets } = options;
  const fixture = postgresSignInState(context, closeFirst);
  const oidc = options.oidc
    ? fakeOidc(context, {
        clientId: options.secrets["occ-oidc-login/client-id"],
        clientSecret: options.secrets["occ-oidc-login/client-secret"],
      })
    : undefined;

  function onboard<const Name extends string>(
    options: OnboardOptions & { accounts: Record<Name, AccountInput> },
  ): Promise<Onboarded<Name>>;
  function onboard(options?: OnboardOptions & { accounts?: undefined }): Promise<Onboarded<never>>;
  function onboard({
    accounts = {},
    remoteAddress,
    passwordHasher,
    passwordSlowLaneFloors,
  }: OnboardOptions & {
    accounts?: Record<string, AccountInput> | undefined;
  } = {}): Promise<Onboarded<string>> {
    return onboardPasswordAccounts(context, {
      ...fixture,
      databaseUrl,
      email,
      authSecret: secrets["occ-auth/secret"],
      secrets,
      password,
      accounts,
      remoteAddress,
      passwordHasher,
      passwordSlowLaneFloors,
    });
  }

  return {
    ...fixture,
    oidc,
    onboard,
    composeApp(settings, overrides = {}) {
      return composeProductionSignIn(context, { databaseUrl, settings, secrets, ...overrides });
    },
  };
}
