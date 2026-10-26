# Check status blocks

An error, warning or notice is one `.status` block: a 3 px stripe in its
tone's colour on that tone's light wash, the light edge, the medium radius and
12/16 px padding. The text stays in the body colour; only a block's label
(such as "Startup warnings") takes the tone. `data-tone` is danger (red),
warning (amber), info (blue) or success (green). Check each story at 1440 and
at 390.

1. Open **Pages / Create Agent / Plugin refusal after the Configuration is
   saved**. The refusal is a danger block with `role="alert"`. It has focus,
   sits above the "Secret saved" line and is fully on screen at 390. Its long
   setting path wraps inside the block.
2. Open **Pages / Agent detail / Plugin selections refused by the
   Configuration**. The Save plugin selections refusal is a danger block, not
   the grey hint, and has focus.
3. Open **Pages / Agent detail / Sharing outcome uncertain**. The refusal
   above the Share Agent form is a danger block.
4. Open **Pages / Create Agent / Experimental Dedicated OpenClaw**. The
   "Experimental: Dedicated OpenClaw…" line is a warning block.
5. Open **Pages / Agent detail / New version failed**. The failed version's
   "CONVERGENCE_DEADLINE_EXCEEDED: …" line is a danger block.
6. Open **Pages / Agent detail / Log access lost after output appears** and
   select Follow. The log access refusal is a danger block.
7. Open **Pages / Agent detail / Edit Configuration**. The line above the tab
   ("New version. Changes affect future deployments…") is an info block.
8. Open **Components / Credentials / Authentication save refused**. The
   refusal is a danger block with focus; "Saving authentication…" before it
   was a grey hint.
9. Open **Components / Credentials / Authentication saved, grant denied**.
   The partial-save message is a warning block.
10. Open **Pages / Agent detail / Repository access save refused**. The
    refusal under the editor is a danger block with focus.
11. Open **Pages / Agent detail / Edit Configuration refused**. The refusal
    under the editor is a danger block with `role="alert"`. It has focus and
    is fully on screen at 1440 and 390.
12. Open **Pages / Agent detail / Current observations for a reader without
    operate**. Run diagnostics for this version is disabled, and an info
    block says "Your access does not include running diagnostics for this
    Agent.", as Stop Agent does.
13. Open **Pages / Agent detail / Current observations refused**. Scroll
    until Run diagnostics sits at the bottom of the screen and click it. The
    refusal below it comes into view; focus stays on the button.
14. Open **Pages / Agent detail / New version failed**. The failed-deployment
    block above the facts is a danger block with 20/24 px padding (16 px at
    390). Its label reads "Deployment failed · v7", its title is one 16 px
    semibold line, and `CONVERGENCE_DEADLINE_EXCEEDED` ends its first sentence
    in mono. Open v7 Logs is its one filled button.
15. Open **Pages / Agent detail / New version failed, deploy again** at 390.
    Deploy again (filled) and Open v7 Logs (edged) stack, each the block's
    full width and at least 44 px tall. Any status block's actions stack this
    way under 520 px. In **New version failed, viewer cannot edit**, Open v7
    Logs is the only action and the filled one.
16. Open **Pages / Agent detail / New version failed, protected admission
    changed** and **New version failed, stored records inconsistent**. Each
    message ends with its own step and no logs advice after it. The first
    offers Deploy again (filled); the second offers only Open v7 Logs.
17. Open **Pages / Create Agent / A newer deployment took over** and click
    **Create Agent**. The form explains why the first deployment ended. Check
    that its feedback uses the informational stripe and offers no retry or link.
