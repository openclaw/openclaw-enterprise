# Browse unreadable saved configuration

These stories run the production Console against simulated read responses. They
do not prove PostgreSQL decoding, runtime health, or configuration repair.

1. Open **Pages / Agents / Unreadable saved configuration**. Both Agents remain
   listed. Research assistant has a **Saved configuration unreadable** badge.
2. Open **Pages / Agent detail / Unreadable Agent draft**. Confirm the Agent name
   and version history remain visible. Configuration, Plugins, Channels, and
   Credentials show the repair banner without editors or deployment controls.
3. Choose **v1 · Selected for service** in **Viewing version**. Its readable admitted settings
   remain available. Return to **Open draft** to see the draft error.
4. Open **Pages / Agent detail / Unreadable revision snapshot**. The selected
   version retains its identity and history entry. Configuration and Plugins
   show the repair banner; no missing settings appear as empty JSON or defaults.
   Deployment activity reports its own read failure.
5. Select **Open draft**. Its healthy draft can still be edited. Return
   to the unreadable version, switch tabs, and use **Retry** to confirm the
   scoped error stays visible. Check the same navigation at a narrow viewport.

Capture screenshots and a short walkthrough outside the checkout. Saved-state
decoding and strict deployment behavior are covered by the PostgreSQL/API tests.
