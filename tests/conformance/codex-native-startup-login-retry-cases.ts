import type { TestContext } from "node:test";

import { checkCodexStartup, login, timedOut } from "../fixtures/codex-native-startup.mjs";
import type {
  FailureClass,
  LoginFailureCode,
  NativeStep,
  StartupExpectation,
} from "../fixtures/codex-native-startup-types.ts";
import type { Ready } from "./codex-native-startup-retry-cases.ts";

type LoginFailure = StartupExpectation & {
  readonly check: "login";
  readonly code: LoginFailureCode;
};

type LoginScenario = {
  readonly name: string;
  readonly expect: Ready | LoginFailure;
  readonly native: readonly NativeStep[];
  readonly loginClasses: readonly FailureClass[];
  readonly loginPauses?: readonly number[];
  readonly random?: number;
  readonly lateWakeMs?: number;
};

type TerminalRefusal = {
  readonly description: string;
  readonly stderr: string;
  readonly failureClass: FailureClass;
  readonly code?: LoginFailureCode;
};

const terminalRefusals: readonly TerminalRefusal[] = [
  {
    description: "a login 401",
    stderr: "request failed with status 401 Unauthorized",
    failureClass: "http_401_403",
    code: "AUTHENTICATION_FAILED",
  },
  {
    description: "a login 403",
    stderr: "request failed with status 403 Forbidden",
    failureClass: "http_401_403",
    code: "AUTHENTICATION_FAILED",
  },
  // A credential rejection Codex quotes beside network text still names the credential.
  {
    description: "a login credential rejection beside network text",
    stderr: 'error sending request: "status 401 Unauthorized"',
    failureClass: "network",
    code: "AUTHENTICATION_FAILED",
  },
  {
    description: "a login rate limit",
    stderr: "last status: 429 Too Many Requests",
    failureClass: "http_other",
  },
  {
    description: "a login TLS failure",
    stderr: "invalid peer certificate: UnknownIssuer",
    failureClass: "tls",
  },
  {
    description: "a login TLS failure beside network text",
    stderr: "error sending request: tls handshake eof",
    failureClass: "tls",
  },
  // The class names the most specific text; a no-retry marker still vetoes the retry.
  {
    description: "a login proxy 5xx naming a certificate",
    stderr: "unexpected status 502 Bad Gateway: upstream certificate verify failed",
    failureClass: "http_5xx",
  },
  {
    description: "a login proxy 5xx naming a TLS handshake",
    stderr: "unexpected status 503: tls handshake eof",
    failureClass: "http_5xx",
  },
  {
    description: "a login proxy 5xx naming a handshake failure",
    stderr: "status 502: handshake failure",
    failureClass: "http_5xx",
  },
  {
    description: "a login 401 beside a transport timeout",
    stderr: "HTTP status client error (401 Unauthorized) for url: operation timed out",
    failureClass: "network",
  },
  {
    description: "a login rate limit beside a closed connection",
    stderr: "Rate limit reached, connection closed",
    failureClass: "network",
  },
  {
    description: "a login invalid key beside a broken pipe",
    stderr: "invalid api key; broken pipe",
    failureClass: "network",
  },
  {
    description: "a login 5xx naming a credential",
    stderr: "status 503: credential unavailable",
    failureClass: "http_5xx",
  },
  {
    description: "an unresolvable login host",
    stderr: "dns error: Name does not resolve",
    failureClass: "network",
  },
  {
    description: "unrecognized login output",
    stderr: "something else went wrong",
    failureClass: "unknown",
  },
  {
    description: "a silent login failure",
    stderr: "",
    failureClass: "empty",
  },
];

export async function registerCodexPatLoginRetryCases(
  t: TestContext,
  {
    success,
    ready,
    loginFailure,
  }: {
    readonly success: NativeStep<"probe">;
    readonly ready: Ready;
    readonly loginFailure: (code?: LoginFailureCode) => LoginFailure;
  },
): Promise<void> {
  const loginFailed = (stderr: string, elapsed?: number) =>
    login({ status: 1, stderr }, undefined, elapsed);
  const network = "failed to request personal access token metadata: error sending request for url";
  const serverError = "personal access token metadata request failed with status 503";
  const scenarios: readonly LoginScenario[] = [
    {
      name: "a login network failure then success retries once",
      native: [loginFailed(network), login(), success],
      expect: ready,
      loginClasses: ["network"],
      loginPauses: [1000],
    },
    {
      // The request URL Codex names is not output that fails the same way again.
      name: "a login network failure naming a URL with failure words retries once",
      native: [
        loginFailed(
          "error sending request for url (https://credential-quota.example.invalid/apikey/403)",
        ),
        login(),
        success,
      ],
      expect: ready,
      loginClasses: ["network"],
      loginPauses: [1000],
    },
    {
      name: "a login 5xx then success retries once",
      native: [loginFailed(serverError), login(), success],
      expect: ready,
      loginClasses: ["http_5xx"],
      loginPauses: [1000],
    },
    {
      name: "a login network failure then a 5xx then success backs off twice",
      native: [loginFailed(network), loginFailed(serverError), login(), success],
      expect: ready,
      loginClasses: ["network", "http_5xx"],
      loginPauses: [1000, 2000],
    },
    {
      // A timed-out attempt waited 30 s already, so only the fast failure backs off.
      name: "a login timeout then a network failure then success waits only after the fast failure",
      native: [login(timedOut, 30000), loginFailed(network), login(undefined, 30000), success],
      expect: ready,
      loginClasses: ["timeout", "network"],
      loginPauses: [2000],
    },
    {
      name: "login network failures are held after five attempts with the same status shape",
      native: Array.from({ length: 5 }, () => loginFailed(network)),
      expect: loginFailure(),
      loginClasses: ["network", "network", "network", "network", "network"],
      loginPauses: [1000, 2000, 4000, 8000],
    },
    {
      // Each wait follows a fast failure; the attempts and waits stay inside 90 s.
      name: "login backoff ends at the 90-second budget",
      random: 0.999,
      native: [
        loginFailed(network, 20000),
        loginFailed(network, 20000),
        loginFailed(network, 20000),
        loginFailed(network, 10000),
      ],
      expect: loginFailure(),
      loginClasses: ["network", "network", "network", "network"],
      // 20 + 1.5 + 20 + 3 + 20 + 6 + 10 s leaves under 10 s: the 12 s fourth wait does not fit.
      loginPauses: [1500, 2999, 5998],
    },
    {
      // A wait that wakes late must not start an attempt without a timeout.
      name: "a login retry wait that wakes too late is held at once",
      lateWakeMs: 1000,
      native: [loginFailed(network, 87500)],
      expect: loginFailure(),
      loginClasses: ["network"],
      loginPauses: [1000],
    },
    {
      name: "a login network failure then a credential rejection is held at once",
      native: [loginFailed(network), loginFailed("request failed with status 401 Unauthorized")],
      expect: loginFailure("AUTHENTICATION_FAILED"),
      loginClasses: ["network", "http_401_403"],
      loginPauses: [1000],
    },
    {
      // Jitter spreads retries by up to half of the base delay.
      name: "a login retry waits at most half again its base delay",
      random: 0.999,
      native: [loginFailed(network), loginFailed(network), login(), success],
      expect: ready,
      loginClasses: ["network", "network"],
      loginPauses: [1500, 2999],
    },
    {
      // Three attempts keep the 90 s the three 30 s attempts always had.
      name: "a login retry gets only the remaining budget",
      native: [loginFailed(network, 59500), login(timedOut, 29500)],
      expect: loginFailure(),
      loginClasses: ["network", "timeout"],
      loginPauses: [1000],
    },
    {
      name: "a login network failure with no budget left for a retry is held at once",
      native: [loginFailed(network, 89000)],
      expect: loginFailure(),
      loginClasses: ["network"],
    },
    ...terminalRefusals.map(({ description, stderr, failureClass, code }) => ({
      name: `${description} is held at once`,
      native: [loginFailed(stderr)],
      expect: loginFailure(code),
      loginClasses: [failureClass],
    })),
    {
      // A wrapper-side process error is not a reliability failure, whatever the output says.
      name: "a login whose output overflowed is held at once",
      native: [login({ status: null, error: { code: "ENOBUFS" }, stderr: network })],
      expect: loginFailure(),
      loginClasses: ["network"],
    },
    {
      name: "a login timeout whose output names a credential rejection is held at once",
      native: [login({ ...timedOut, stderr: "status 401 Unauthorized" })],
      expect: loginFailure(),
      loginClasses: ["http_401_403"],
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      await checkCodexStartup(t, { ...scenario, loginMode: "codex_pat" });
    });
  }
}
