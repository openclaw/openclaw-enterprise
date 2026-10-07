package occcli

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/openclaw/openclaw-enterprise/internal/occclient"
	"github.com/spf13/cobra"
)

// clientLabel names this host for the approval page, which shows it as unverified.
func clientLabel() string {
	host, err := os.Hostname()
	if err != nil {
		host = "unknown host"
	}
	var label strings.Builder
	for _, character := range "occ on " + host {
		if character >= 0x20 && character <= 0x7e && label.Len() < 64 {
			label.WriteRune(character)
		}
	}
	return label.String()
}

func apiErrorCode(err error) (int, string) {
	var apiError *occclient.APIError
	if errors.As(err, &apiError) {
		return apiError.Status, apiError.Code
	}
	return 0, ""
}

func (app *application) originClient(token string) (string, *occclient.Client, error) {
	if app.url == "" {
		return "", nil, fmt.Errorf("set OCC_URL or pass --url")
	}
	origin, err := canonicalOrigin(app.url)
	if err != nil {
		return "", nil, err
	}
	client, err := occclient.New(occclient.Config{
		URL:             app.url,
		CLISessionToken: token,
		CABundle:        app.caBundle,
		Timeout:         app.parsedTimeout,
		Context:         app.ctx,
	})
	return origin, client, err
}

func (app *application) loginCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Sign in to OCC as yourself by approving a code in the console",
		Long: "Sign in to OCC as yourself. occ prints a code; open /console/cli-login in a browser\n" +
			"where you are signed in to the console and approve it. The CLI session acts with your\n" +
			"current permissions and ends with that browser session (at most 8 hours); there is no\n" +
			"refresh. Pass --namespace to pin the session to one Namespace (OCC_NAMESPACE alone does\n" +
			"not pin). A service key from --service-key-file or OCC_SERVICE_KEY_FILE still takes\n" +
			"precedence for every other command.",
		Args: cobra.NoArgs,
		RunE: func(command *cobra.Command, _ []string) error {
			pin := ""
			if command.Flags().Changed("namespace") {
				namespace, err := app.requiredNamespace()
				if err != nil {
					return err
				}
				pin = namespace
			}
			origin, client, err := app.originClient("")
			if err != nil {
				return err
			}
			started, err := client.StartCLISignIn(clientLabel(), pin)
			if err != nil {
				if status, _ := apiErrorCode(err); status == http.StatusNotFound {
					return fmt.Errorf("this OCC controller does not support occ login (HTTP 404): upgrade it, enable auth.cliSessions, or use --service-key-file")
				}
				return err
			}
			fmt.Fprintf(app.errOut,
				"To sign in, open %s%s in a browser where you are signed in to the console,\n"+
					"and enter this code:\n\n    %s\n\n"+
					"Only approve a code you just started yourself. It expires in %d minutes.\n",
				origin, started.VerificationURI, started.UserCode, (started.ExpiresIn+59)/60)
			interval := time.Duration(started.Interval) * time.Second
			deadline := time.Now().Add(time.Duration(started.ExpiresIn) * time.Second)
			for {
				if err := sleepContext(app.ctx, interval); err != nil {
					return err
				}
				if time.Now().After(deadline) {
					return fmt.Errorf("the sign-in code expired before it was approved; run occ login again")
				}
				result, err := client.PollCLISignIn(started.DeviceCode)
				if err == nil {
					if err := saveSession(storedSession{
						Origin:      origin,
						Token:       result.Token,
						SessionID:   result.Session.ID,
						ExpiresAt:   result.Session.ExpiresAt,
						Email:       result.User.Email,
						NamespaceID: result.Session.NamespaceID,
						CABundle:    app.caBundle,
					}); err != nil {
						return err
					}
					fmt.Fprintf(app.out, "Signed in to %s as %s until %s.\n", origin, result.User.Email, result.Session.ExpiresAt)
					if result.Session.NamespaceID != "" {
						fmt.Fprintf(app.out, "This session is pinned to Namespace %s.\n", result.Session.NamespaceID)
					}
					return nil
				}
				status, code := apiErrorCode(err)
				switch {
				case code == "AUTHORIZATION_PENDING":
				case code == "SLOW_DOWN":
					interval += 5 * time.Second
				case status == http.StatusServiceUnavailable || status == http.StatusTooManyRequests:
					// The approval is kept; try again at the next interval.
				case code == "ACCESS_DENIED":
					return fmt.Errorf("the sign-in request was denied in the console")
				case code == "EXPIRED_TOKEN":
					return fmt.Errorf("the sign-in request expired or lost its approving browser session; run occ login again")
				default:
					return err
				}
			}
		},
	}
}

func (app *application) logoutCommand() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "End this host's occ login session for the OCC endpoint",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			if app.url == "" {
				return fmt.Errorf("set OCC_URL or pass --url")
			}
			origin, err := canonicalOrigin(app.url)
			if err != nil {
				return err
			}
			session, err := loadSession(origin)
			if err != nil {
				return err
			}
			if session == nil {
				fmt.Fprintf(app.out, "Not signed in to %s.\n", origin)
				return nil
			}
			_, client, err := app.originClient(session.Token)
			var serverErr error
			if err == nil {
				serverErr = client.LogoutCLISession()
				if status, _ := apiErrorCode(serverErr); status == http.StatusUnauthorized || status == http.StatusNotFound {
					// Already ended (expired, revoked, signed out in the browser) or disabled.
					serverErr = nil
				}
			} else {
				serverErr = err
			}
			// The local copy goes either way.
			if err := removeSession(origin); err != nil {
				return err
			}
			if serverErr != nil {
				return fmt.Errorf("removed the local session, but OCC did not confirm the sign-out (%w); it ends at %s, or revoke it in the console", serverErr, session.ExpiresAt)
			}
			fmt.Fprintf(app.out, "Signed out of %s.\n", origin)
			return nil
		},
	}
}

func (app *application) authCommand() *cobra.Command {
	command := commandGroup("auth", "Inspect how occ authenticates")
	status := &cobra.Command{
		Use:   "status",
		Short: "Show the active credential source and, for occ login, its account and expiry",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			if app.serviceKeyFile != "" {
				return app.printItems(map[string]any{
					"source": "service-key-file",
					"path":   app.serviceKeyFile,
				}, false, []column{{title: "SOURCE", key: "source"}, {title: "PATH", key: "path"}})
			}
			if app.url == "" {
				return fmt.Errorf("set OCC_URL or pass --url")
			}
			origin, err := canonicalOrigin(app.url)
			if err != nil {
				return err
			}
			session, err := loadSession(origin)
			if err != nil {
				return err
			}
			columns := []column{
				{title: "SOURCE", key: "source"},
				{title: "ORIGIN", key: "origin"},
				{title: "ACCOUNT", key: "account"},
				{title: "EXPIRES", key: "expiresAt"},
				{title: "NAMESPACE", key: "namespaceId"},
				{title: "STATE", key: "state"},
			}
			if session == nil {
				return app.printItems(map[string]any{
					"source": "none", "origin": origin, "state": "signed out",
				}, false, columns)
			}
			view := map[string]any{
				"source":      "cli-session",
				"origin":      origin,
				"account":     session.Email,
				"expiresAt":   session.ExpiresAt,
				"namespaceId": session.NamespaceID,
				"sessionId":   session.SessionID,
			}
			if session.expired(time.Now()) {
				view["state"] = "expired"
				return app.printItems(view, false, columns)
			}
			_, client, err := app.originClient(session.Token)
			if err != nil {
				return err
			}
			current, err := client.CurrentCLISession()
			switch status, _ := apiErrorCode(err); {
			case err == nil:
				view["state"] = "active"
				view["expiresAt"] = current.ExpiresAt
				if current.User != nil {
					view["account"] = current.User.Email
				}
			case status == http.StatusUnauthorized:
				view["state"] = "ended"
			default:
				return err
			}
			return app.printItems(view, false, columns)
		},
	}
	command.AddCommand(status)
	return command
}
