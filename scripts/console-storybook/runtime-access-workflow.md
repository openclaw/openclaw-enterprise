# Watch the Logs page respond to a change in access

Open these stories under **Pages / Agent detail**. The Console is real; the API responses
and log lines are simulated. **Reset story** starts over. For the recovery steps, sign in
or go Back inside the preview instead, so the Console keeps the state you are checking.

1. **Log access lost after output appears.** Wait for rows, then select **Follow**.
   The next read is refused: the rows and their caption disappear, Follow stops, and
   Download is disabled. The Pod stays. Sign out, sign in with invented values, and reopen
   the Research assistant’s Logs. The rows return. Reset to try **Download** instead.
2. **Download refused while an earlier log page is in flight.** Select **Follow**, wait
   three seconds, then **Download**. No file downloads. About seven seconds later the
   earlier page arrives; the rows stay empty. This cannot retract output already seen.
3. **Pod status access lost while logs remain readable.** Leave Follow off. After about
   ten seconds the Pod and its observation time disappear, but the log rows stay. Select
   **Follow**: it reads logs without restoring the old Pod selection.
4. **Pod status access restored on Back.** Start with readable logs and no Pod status.
   Open **Namespaces**, then use browser **Back**. The Pod appears.
5. **Selected Pod disappears from runtime status.** Select **gateway-retiring** in the Pod
   picker before the next status poll. When that Pod disappears, the picker, caption and
   log lines switch together. Output from the retired Pod is no longer shown.
