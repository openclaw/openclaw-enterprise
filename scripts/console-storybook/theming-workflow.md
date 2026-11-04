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
   full name remains accessible. The operator’s logo has no added outline: it
   fits within 48 × 48 px in navigation, preserving its aspect ratio, and
   40 × 40 px at sign-in. In Long Name,
   the drawer wraps the full name. The phone’s top bar truncates it with an
   ellipsis so the menu and account controls stay reachable.
3. Compare **Pages/Secrets → Mobile**: the bundled 48 × 38 px mascot has a white
   outline on navy and dims with the header when a sheet opens. With forced
   colors active, navigation uses the original artwork within the same 48 × 48 px limit.
   **Pages/Sign in** also keeps the original artwork, at 40 × 40 px.
4. Inspect Empty, Denied, Loading, Missing Credentials, and Public Error for text
   readability, visible status labels, and consistent branding.
5. Capture final desktop/mobile screenshots and a short sign-in/navigation video
   outside the checkout. Name the source revision, environment, stories, and
   simulated proof boundary. Attach final media to the implementation PR.

Storybook does not prove mounted files in a deployed image, persistence, IAM,
credential propagation, or Agent execution. The QA matrix's `model-ui` workflow
uses the sample bundle with actual Compose and Helm installations.
