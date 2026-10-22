# Check connected accounts

The Agent page's **Connections** section, Create Agent's **Connections** choice,
and the **Connection templates** card in Settings. Stories use simulated data. The
consent popup is a fixture page that reports the outcome the way the console page
behind the OCC callback does; provider consent, the code exchange, and token
refresh need the real backend.

1. Open **Components / Connections / Empty**. Below the Agent heading,
   **Connections** says that only the owner can deploy or use the Agent while it
   holds an account, and offers **Connect Gmail**.
2. Open **Consent warning and popup**. The dialog names the provider, the
   approved scope, and the endpoint tools can call, with a warning that the Agent
   becomes personal. Choose **Continue to accounts.google.com**: a popup opens on
   the simulated consent page and the dialog waits. Choose **Approve**. The popup
   closes; the section shows **Connected** with **Deploy new version**, and the row
   says the account is not in the running version yet. Reset, repeat, and choose
   **Deny**: the section shows **Not connected** with the consent-denied sentence.
3. Open **Starting**. The start request is pending, so the dialog says it is
   opening the provider and **Continue** stays disabled.
4. Compare **Connected**, **Connected, not deployed**, **Reconnect to apply
   changes**, and **Reconnect required**. Only the last three add a note, and only
   the two reconnect states offer **Reconnect**: a healthy connection refreshes
   by itself.
5. Open **Disconnect** and choose **Disconnect** in the dialog. The section says
   OCC is withdrawing the account, and the row shows **Disconnecting** with a
   disabled **Finish disconnecting**. **Withdrawal pending** opens in that state.
6. Open **Failed after redirect**. The page opened on the callback's failure
   redirect, which names no Agent, and returned to the Agent that started the
   consent with the reason.
7. Open **Start refused**. The dialog keeps the API's sentence about other
   people's access and offers **Continue** again. **Template use denied** keeps
   the connection with its template ID and **Disconnect**, without **Reconnect**.
8. Open **Pages / Create Agent / Connections**. **Connections** lists Gmail with
   its provider host.
9. Open **Pages / Settings / Connection templates**. The card shows the client,
   scopes, endpoint and variable, the redirect URI with **Copy**, and the
   Namespace that may connect. Grant use to a person, then remove it. Choose
   **Edit**, change a scope, and save: the template shows **Version 2**.
   **New connection template** opens the form filled from the Gmail example.
