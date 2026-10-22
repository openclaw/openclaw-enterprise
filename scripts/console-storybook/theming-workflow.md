# Inspect console theming

Rebuild prepared assets and Storybook from the changed source. `Pages/Theming`
covers Sign In, Desktop, Mobile, Long Name, Empty, Denied, Loading, Missing
Credentials, and Public Error. Default branding remains in `Pages/Sign in` and
`Pages/Navigation`.

The default custom theme comes from `deploy/examples/console-theme/`. To preview
an operator bundle, set `OCC_CONSOLE_THEME_DIR` to its absolute directory while
preparing assets. Preparation uses the production loader, validation, metadata,
and generated CSS. API, session, credential, and runtime state remain simulated.

1. Open Sign In and enter disposable credentials. Inspect the title, logo, form,
   and keyboard focus, then navigate to an Agent.
2. Open Desktop and Mobile. Operate navigation and the mobile drawer; verify the
   full name remains accessible. Navigation logos render at 20×20 pixels; sign-in
   logos render at 40×40. Long Name must wrap without covering controls.
3. Inspect Empty, Denied, Loading, Missing Credentials, and Public Error for text
   readability, visible status labels, and consistent branding.
4. Capture final desktop/mobile screenshots and a short sign-in/navigation video
   outside the checkout. Name the source revision, environment, stories, and
   simulated proof boundary. Attach final media to the implementation PR.

Storybook does not prove mounted files in a deployed image, persistence, IAM,
credential propagation, or Agent execution. The QA matrix's `model-ui` workflow
uses the sample bundle with actual Compose and Helm installations.
