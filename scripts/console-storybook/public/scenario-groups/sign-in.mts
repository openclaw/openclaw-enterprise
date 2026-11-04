type SignInAction =
  { click: string } | { selector: string; click: boolean } | { selector: string; value: string };

type SignInRule = {
  path: `/api/auth/${string}`;
  method?: "GET" | "POST";
} & (
  | { status: number; bodyError?: never; hold?: never; once?: never; data?: never }
  | { bodyError: true; status?: never; hold?: never; once?: never; data?: never }
  | { hold: true; status?: never; bodyError?: never; once?: never; data?: never }
  | {
      path: "/api/auth/session";
      method: "GET";
      once: true;
      data: {
        authenticated: true;
        user: {
          id: "storybook-operator";
          name: "Demo Operator";
          email: "operator@example.com";
        };
        sessionKey?: never;
      };
      status?: never;
      bodyError?: never;
      hold?: never;
    }
);

type SignInScenario = {
  group: "Pages/Sign in";
  name: string;
  description: string;
  path?: `/console/${string}`;
  signedOut?: true;
  buildRevision?: string;
  githubEnabled?: true;
  googleEnabled?: true;
  passwordRecoveryOnly?: true;
  pendingGithubAttempt?: true;
  pendingGoogleAttempt?: true;
  expiredSession?: true;
  steps?: readonly string[];
  gap?: string;
  actions?: readonly SignInAction[];
  rules?: readonly SignInRule[];
};

export function signInScenarios({
  draft,
  click,
  account,
}: {
  draft: `/console/${string}`;
  click(text: string): { click: string };
  account: readonly { selector: string; click: boolean }[];
}) {
  const submitPassword = [
    { selector: "#username", value: "operator@example.com" },
    { selector: "#password", value: "demo-only" },
    click("Sign in"),
  ];
  return {
    login: {
      group: "Pages/Sign in",
      name: "Signed out",
      path: "/console/login",
      signedOut: true,
      buildRevision: "1234567890abcdef1234567890abcdef12345678",
      description:
        "The email and password form, and a footer naming the build. Any nonempty demo email/password signs into this fixture.",
    },
    githubLogin: {
      group: "Pages/Sign in",
      name: "GitHub enabled",
      path: "/console/login",
      signedOut: true,
      githubEnabled: true,
      description:
        "Provider discovery adds Continue with GitHub beside the password form. Clicking it demonstrates an unavailable provider; this fixture never navigates to GitHub.",
      steps: [
        "Check the GitHub icon and label, then select the button to see the unavailable message.",
      ],
      gap: "An administrator must attach the numeric GitHub identity to an existing account through the API. Enrollment, account creation, and recovery administration have no console controls. OAuth navigation and session issuance require backend verification.",
    },
    githubUnavailable: {
      group: "Pages/Sign in",
      name: "GitHub unavailable",
      path: "/console/login",
      signedOut: true,
      githubEnabled: true,
      actions: [click("Continue with GitHub")],
      description:
        "A failed GitHub start leaves password sign-in and a deliberate retry available.",
    },
    githubRateLimited: {
      group: "Pages/Sign in",
      name: "GitHub rate limited",
      path: "/console/login",
      signedOut: true,
      githubEnabled: true,
      rules: [{ path: "/api/auth/providers/github/start", method: "POST", status: 429 }],
      actions: [click("Continue with GitHub")],
      description: "Admission refusal asks the user to wait without automatically retrying.",
    },
    recoveryOnlyLogin: {
      group: "Pages/Sign in",
      name: "Recovery-only password",
      path: "/console/login",
      signedOut: true,
      githubEnabled: true,
      googleEnabled: true,
      passwordRecoveryOnly: true,
      description:
        "With OCC_AUTH_PASSWORD_SIGN_IN=recovery-only, ordinary accounts continue with GitHub or Google. The password form stays behind Recovery sign-in for the recovery account.",
    },
    recoveryOnlyForm: {
      group: "Pages/Sign in",
      name: "Recovery sign-in form",
      path: "/console/login",
      signedOut: true,
      githubEnabled: true,
      passwordRecoveryOnly: true,
      rules: [{ path: "/api/auth/sign-in/email", method: "POST", status: 401 }],
      actions: [
        click("Recovery sign-in"),
        { selector: "#username", value: "member@example.com" },
        { selector: "#password", value: "demo-only" },
        click("Sign in"),
      ],
      description:
        "Recovery sign-in reveals the password form. A refused password explains that only the recovery account can use one.",
    },
    recoveryOnlyCallbackRejected: {
      group: "Pages/Sign in",
      name: "Recovery-only GitHub callback rejected",
      path: "/console/?authError=github",
      signedOut: true,
      githubEnabled: true,
      passwordRecoveryOnly: true,
      description:
        "Without a password to fall back on, a rejected callback points the user to an administrator.",
    },
    githubCallbackRejected: {
      group: "Pages/Sign in",
      name: "GitHub callback rejected",
      path: "/console/?authError=github",
      signedOut: true,
      githubEnabled: true,
      description:
        "A rejected callback shows the generic sign-in error and keeps password recovery available.",
    },
    githubResultRejected: {
      group: "Pages/Sign in",
      name: "GitHub result not confirmed",
      path: "/console/",
      pendingGithubAttempt: true,
      githubEnabled: true,
      rules: [{ path: "/api/auth/providers/github/result", method: "POST", status: 401 }],
      description:
        "The tab that started GitHub sign-in could not confirm that the current session is the one its attempt created, so it shows the sign-in error instead of adopting that session.",
    },
    googleLogin: {
      group: "Pages/Sign in",
      name: "Google enabled",
      path: "/console/login",
      signedOut: true,
      githubEnabled: true,
      googleEnabled: true,
      description:
        "Provider discovery adds Continue with Google beside the password form and any other configured provider. Clicking it demonstrates an unavailable provider; this fixture never navigates to Google.",
      steps: [
        "Check the Google and GitHub icons and labels, then select either button to see the unavailable message.",
      ],
      gap: "An administrator must attach the Google subject identifier to an existing account through the API. Email addresses never match an account. OAuth navigation and session issuance require backend verification.",
    },
    googleUnavailable: {
      group: "Pages/Sign in",
      name: "Google unavailable",
      path: "/console/login",
      signedOut: true,
      googleEnabled: true,
      actions: [click("Continue with Google")],
      description:
        "A failed Google start leaves password sign-in and a deliberate retry available.",
    },
    googleCallbackRejected: {
      group: "Pages/Sign in",
      name: "Google callback rejected",
      path: "/console/?authError=google",
      signedOut: true,
      googleEnabled: true,
      description:
        "A rejected Google callback shows the generic sign-in error and keeps password recovery available.",
    },
    googleAccountDisabled: {
      group: "Pages/Sign in",
      name: "Google account disabled",
      path: "/console/?authError=google&authReason=account-disabled",
      signedOut: true,
      googleEnabled: true,
      description:
        "Google authenticated an identity attached to a disabled account, so the page says the account is disabled and names an administrator, not a retry, password or identity attach.",
    },
    recoveryOnlyAccountDisabled: {
      group: "Pages/Sign in",
      name: "Recovery-only account disabled",
      path: "/console/?authError=github&authReason=account-disabled",
      signedOut: true,
      githubEnabled: true,
      passwordRecoveryOnly: true,
      description:
        "With recovery-only password sign-in, a disabled account's GitHub sign-in gives the same administrator advice.",
    },
    recoveryOnlyProviderUnavailable: {
      group: "Pages/Sign in",
      name: "Recovery-only provider outage",
      path: "/console/?authError=github&authReason=provider-unavailable",
      signedOut: true,
      githubEnabled: true,
      passwordRecoveryOnly: true,
      description:
        "The provider could not answer or refused the client, so the page says sign-in is unavailable right now and points administrators to Recovery sign-in, not to an identity attach.",
    },
    googleResultRejected: {
      group: "Pages/Sign in",
      name: "Google result not confirmed",
      path: "/console/",
      pendingGoogleAttempt: true,
      googleEnabled: true,
      rules: [{ path: "/api/auth/providers/google/result", method: "POST", status: 401 }],
      description:
        "The tab that started Google sign-in could not confirm that the current session is the one its attempt created, so it shows the sign-in error instead of adopting that session.",
    },
    providerDiscoveryUnavailable: {
      group: "Pages/Sign in",
      name: "Provider discovery unavailable",
      path: "/console/login",
      signedOut: true,
      rules: [{ path: "/api/auth/providers", status: 503 }],
      description:
        "Failed provider discovery leaves the password form usable without provider buttons.",
    },
    loginError: {
      group: "Pages/Sign in",
      name: "Invalid credentials",
      path: "/console/login",
      signedOut: true,
      rules: [{ path: "/api/auth/sign-in/email", method: "POST", status: 401 }],
      actions: submitPassword,
      description: "A rejected sign-in leaves the form available for retry.",
    },
    passwordSignInUnconfirmed: {
      group: "Pages/Sign in",
      name: "Password sign-in unconfirmed",
      path: "/console/login",
      signedOut: true,
      rules: [{ path: "/api/auth/sign-in/email", method: "POST", bodyError: true }],
      actions: submitPassword,
      description:
        "An interrupted password response leaves the result unknown. Reload to check the session before entering the password again.",
    },
    expired: {
      group: "Pages/Sign in",
      name: "Session expired",
      path: draft,
      signedOut: true,
      expiredSession: true,
      description:
        "A protected deep link in a tab whose session expired says so, redirects to sign-in and retains the return destination.",
      steps: [
        "Sign in with the fixture credentials and confirm the Agent draft page returns.",
        "Confirm no draft is saved or deployment started by signing in.",
      ],
    },
    firstVisit: {
      group: "Pages/Sign in",
      name: "Deep link, first visit",
      path: draft,
      signedOut: true,
      description:
        "A first visit to a protected deep link asks to sign in without saying a session expired, and retains the return destination.",
      steps: ["Sign in with the fixture credentials and confirm the Agent draft page returns."],
    },
    sessionUnavailable: {
      group: "Pages/Sign in",
      name: "Session unavailable",
      rules: [{ path: "/api/auth/session", status: 503 }],
      description: "The console cannot verify the session. Private data stays hidden.",
    },
    missingSessionBindingRetry: {
      group: "Pages/Sign in",
      name: "Missing session binding, retry",
      rules: [
        {
          path: "/api/auth/session",
          method: "GET",
          once: true,
          data: {
            authenticated: true,
            user: {
              id: "storybook-operator",
              name: "Demo Operator",
              email: "operator@example.com",
            },
          },
        },
      ],
      description:
        "Simulated session recovery: the first authenticated response has no session binding. Retry uses the ordinary bound fixture session.",
      steps: [
        "Observe Session unavailable with private content and console navigation hidden.",
        "Choose Retry and confirm the Agents page appears.",
      ],
    },
    loading: {
      group: "Pages/Sign in",
      name: "Checking session",
      rules: [{ path: "/api/auth/session", hold: true }],
      description:
        "Reload with the entry script throttled: “Loading OpenClaw Enterprise…” appears before it runs, then becomes “Checking session…” in the same place.",
      steps: [
        "Check that neither console navigation nor a sign-in form appears while the session is unknown.",
        "Wait for Session unavailable, then choose Retry to repeat the check.",
      ],
    },
    logoutFailure: {
      group: "Pages/Sign in",
      name: "Sign-out unconfirmed",
      rules: [{ path: "/api/auth/sign-out", method: "POST", status: 503 }],
      actions: [...account, click("Sign out")],
      description:
        "Failed sign-out with a still-active session hides private content until revocation can be confirmed.",
    },
  } satisfies Record<string, SignInScenario>;
}
