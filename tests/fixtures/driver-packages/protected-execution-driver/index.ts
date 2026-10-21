/** Installed only in the registration test's private controller package root. */
import { get } from "node:https";
import { isDeepStrictEqual } from "node:util";
import { json } from "node:stream/consumers";
import type {
  CredentialProviderDefinition,
  DriverRegistration,
  EgressInstallation,
  ProxyRevisionContext,
} from "../../../../packages/contracts/src/index.ts";

export const calls = { validate: 0, create: 0, lifecycle: 0, close: 0 };
export const exchangeProbe = {
  decisions: [] as unknown[],
  rejectsSecondOwner: undefined as (() => boolean) | undefined,
  closed: 0,
};
export const configurationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["endpoint", "ca"],
  properties: { endpoint: { type: "string" }, ca: { type: "string" } },
};
type Configuration = { endpoint: string; ca: string };

export function validateConfiguration(config: Configuration): void {
  calls.validate++;
  if (new URL(config.endpoint).protocol !== "https:") {
    throw Error("Fixture peer must use TLS");
  }
}

/** Only the release protocol is implemented. This fixture has no credential source or provider effects. */
export function createDriver({
  id,
  implementation,
  configuration,
}: {
  id: string;
  implementation: string;
  configuration: Configuration;
}): DriverRegistration {
  calls.create++;
  const sender = { id: "fixture-sender", generation: 1 };
  function read(): Promise<EgressInstallation> {
    return new Promise((resolve, reject) =>
      get(
        configuration.endpoint,
        {
          ca: configuration.ca,
          timeout: 2000,
          headers: { authorization: "Bearer test-supervisor" },
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(Error("Unauthenticated fixture supervisor"));
          } else {
            resolve(json(response) as Promise<EgressInstallation>);
          }
        },
      )
        .on("error", reject)
        .on("timeout", function (this: import("node:http").ClientRequest) {
          this.destroy(Error("fixture peer timed out"));
        }),
    );
  }
  function outsideProfile(): never {
    throw new Error("Outside this fixture's deny-all release profile");
  }
  const unusedProvider = {
    normalizeConfig: outsideProfile,
    normalizeGrant: outsideProfile,
    routes: outsideProfile,
    classify: outsideProfile,
    inject: outsideProfile,
    protectResponse: outsideProfile,
  } as unknown as CredentialProviderDefinition;
  return {
    capabilities: {
      sandbox: {
        id,
        implementation,
        capability: "sandbox",
        facets: ["networking"],
        cleanup: outsideProfile,
        provisionHarness: outsideProfile,
        async enrollHarness(_context, installed, release) {
          const result = await release("fixture-challenge");
          if (
            result.sandboxId !== installed.sandboxId ||
            result.startupId !== "fixture-challenge"
          ) {
            throw new Error("Wrong startup release");
          }
        },
        harnessEndpoint: outsideProfile,
        harnessStatus: outsideProfile,
      },
      credential_proxy: {
        id,
        implementation,
        capability: "credential_proxy",
        sourceControl: {
          sender,
          backend: sender,
          resolver: sender,
          providers: [unusedProvider],
          assertAvailable: async () => {
            await read();
          },
        },
        async bindExchange(connect) {
          const owner = {
            verify: async () => undefined,
            capture: () => undefined,
            owns: () => false,
          };
          const exchange = connect(owner);
          if (
            Object.keys(exchange).sort().join(",") !==
            "authorizeSend,beginResponse,protectResponse,renewResponse,resolve"
          ) {
            throw new Error("Expected only the exchange authority");
          }
          const result = await exchange.resolve(
            "",
            "unverified",
            {
              id: "unknown",
              method: "GET",
              url: "https://unowned.invalid",
              headers: [],
              body: new Uint8Array(),
              deadlineAt: new Date(Date.now() + 1000).toISOString(),
            },
            AbortSignal.timeout(1000),
          );
          exchangeProbe.decisions.push(result);
          exchangeProbe.rejectsSecondOwner = () => {
            try {
              connect(owner);
            } catch {
              return true;
            }
            return false;
          };
          return {
            close() {
              exchangeProbe.closed++;
            },
          };
        },
        async configureRevision({ plan }: ProxyRevisionContext) {
          if (plan.routes.length) {
            outsideProfile();
          }
          return { plan, configuration: { routes: [] } };
        },
        async wiringStatus(_context, wiring) {
          if (!isDeepStrictEqual(wiring.configuration, { routes: [] })) {
            outsideProfile();
          }
          return read();
        },
        async verifyInstallation(_context, installed) {
          return isDeepStrictEqual(installed, await read());
        },
        withdrawBinding: outsideProfile,
        removeRevision: outsideProfile,
      },
    },
    computeLifecycleHooks: {
      async afterNamespacePrepared() {
        calls.lifecycle++;
      },
    },
    close() {
      calls.close++;
    },
  };
}
