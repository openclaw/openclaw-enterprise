# Check badges and cards

A status badge is a word or two of human copy, never a raw enum value. It uses
the `.badge` pattern: `--text-sm` medium on a tinted chip. Its tone comes from
`data-tone`: neutral (grey) by default, or success (green), warning (amber),
danger (red) or info (blue). A card is a `.card` with the surface, the light
edge, the large radius and 24 px padding, or 16 px at 520 px and narrower.
Check each story at 1440 and at 390.

1. Open **Pages / Namespaces / Ready and provisioning**. Each Namespace row is
   a card. "Ready" is a green badge and "Provisioning" an amber one, never
   `ready` or `provisioning`. At 390 the card padding is 16 px and the badge
   stays on the row's first line.
2. Open **Pages / Backends / Configured**. Each Backend row is a card, and its
   type badge ("ChatGPT", "GitHub", "OpenShell") is neutral.
3. Open **Pages / Agent detail / New version failed**. In the Versions card,
   the current version's row reads "v6", a space, then a blue "Current"
   badge, with the date on the next line. Current is blue, not green: it means
   only that OCC selected the version, which can be stopped or failed. Its row is as tall as the other
   versions' rows. A screen reader still announces "View version v6, current
   version". The failed v7 row reads "v7", a space, then a red "Failed" badge,
   announced as "View version v7, deployment failed". Only the latest
   deployment's version carries an outcome badge.
4. Open **Components / Credentials / One Slack token missing**. The bound
   Slack token reads "Bound" in a green badge, and the other reads "Missing"
   in a red one.
5. Open **Pages / Create Agent / Repositories using the Agent default**. Each
   selected repository's access summary ("Read-only · Agent default") is a
   blue badge that wraps rather than overflowing at 390. A repository whose
   access conflicts with policy shows its summary in a red badge. In
   **Pages / Agent detail / Repository access while choices load**, "Access
   awaiting verification" is blue; in **Repository access without a Repo
   Driver** it is amber. Red is only for a choice that is not approved.
6. Open **Components / Dialogs / Plugins (phone)**. Each plugin's state
   ("Enabled", "Disabled", "Not selected", "Unavailable") is a neutral badge
   under its name. Tab through the list: no badge pushes a plugin's focus ring
   outside the scrolling list.
7. Open **Pages / Agent detail / New version failed**. The Agent's facts are
   one card: three columns (Selected version, Latest visible deployment, Live
   serving) split by hairlines, each an 18 px semibold value under a 12 px
   label. "Failed" is a red badge after "v7", and "May be offline" an amber
   one. At 390 the facts stack, each label and value on one line. Under them,
   "What this page can tell you" is closed; opening it lists what selection,
   deployment records and listed bindings do not confirm, said nowhere else
   on the page.
