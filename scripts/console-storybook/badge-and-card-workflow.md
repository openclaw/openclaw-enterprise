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
   the current version's row reads "v6", a space, then a green "Current"
   badge, with the date on the next line. Its row is as tall as the other
   versions' rows. A screen reader still announces "View version v6, current
   version".
4. Open **Components / Credentials / One Slack token missing**. The bound
   Slack token reads "Bound" in a green badge, and the other reads "Missing"
   in a red one.
5. Open **Pages / Create Agent / Repositories using the Agent default**. Each
   selected repository's access summary ("Read-only · Agent default") is a
   blue badge that wraps rather than overflowing at 390. A repository whose
   access conflicts with policy shows its summary in a red badge.
6. Open **Components / Dialogs / Plugins (phone)**. Each plugin's state
   ("Enabled", "Disabled", "Not selected", "Unavailable") is a neutral badge
   under its name. Tab through the list: no badge pushes a plugin's focus ring
   outside the scrolling list.
