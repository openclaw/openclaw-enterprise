package occcli

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// hiddenRunes are the bidirectional, zero-width and other format characters
// OCC leaves in runtime log text (it strips only terminal escapes and C0/C1).
const hiddenRunes = "\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u200b\u200d\ufeff"

// Agent output is attacker-influenced: a log line or notice must not reorder or
// hide what an operator's terminal shows. Text output escapes such characters
// visibly; NDJSON output stays the exact record.
func TestAgentLogsEscapeBidiAndZeroWidthCharactersInTextAndNotices(t *testing.T) {
	line := `{"type":"line","time":"2026-09-30T12:00:01.000000001Z","stream":{"source":"gateway"},"contentClass":"operational","kind":"openclaw","level":"info",` +
		`"message":"paid \u202e0001$ \u200bok\\u202e","subsystem":"gate\u2066way","fields":{"user":"eve\u202d","z\u2067":"v","note":"eve\u00a0admin"}}`
	// These two carry the characters themselves, as OCC's JSON encoder sends them.
	gap := "{\"type\":\"gap\",\"time\":null,\"stream\":{\"source\":\"gateway\"},\"reason\":\"stream\u202ereplaced\",\"remedy\":\"Container \ufeffrestarted.\"}"
	withheld := "{\"type\":\"withheld\",\"time\":\"2026-09-30T12:00:02Z\",\"stream\":{\"source\":\"gateway\"},\"reason\":\"over\u200dlimit\",\"count\":3}"
	podless := func(response http.ResponseWriter, _ url.Values) {
		fmt.Fprint(response, `{"data":{"revisionId":"rev_\u2068x","source":"gate\u202bway","stream":null,"observedAt":"2026-09-30T12:00:00.000Z","records":[],"withheld":0,"truncated":false,"cursor":null},"meta":{"requestId":"r"}}`)
	}
	newStub := func() *runtimeLogStub {
		return &runtimeLogStub{t: t, revisions: `[{"id":"rev_\u2069\u202a2","revision":2}]`, pages: []func(http.ResponseWriter, url.Values){
			logPage("", line, gap, withheld), podless,
		}}
	}

	stub := newStub()
	out, errOut, err := runLogsCommand(t, context.Background(), stub, "agent", "logs", "agt_1", "--source", "gateway")
	if err != nil {
		t.Fatal(err)
	}
	// The literal \u202e already in the message stays as it was; a value with a
	// no-break space is quoted so it cannot read as two fields.
	if want := `2026-09-30T12:00:01.000000001Z INFO openclaw [gate\u2066way] paid \u202e0001$ \u200bok\u202e note="eve\u00a0admin" user="eve\u202d" z\u2067=v` + "\n"; out != want {
		t.Errorf("text output = %q, want %q", out, want)
	}
	for _, want := range []string{
		`agent agt_1 has no active revision; using latest revision rev_\u2069\u202a2`,
		`notice: - gap stream\u202ereplaced: Container \ufeffrestarted.`,
		`notice: 2026-09-30T12:00:02Z 3 lines withheld (over\u200dlimit)`,
	} {
		if !strings.Contains(errOut, want) {
			t.Errorf("notices lack %s:\n%s", want, errOut)
		}
	}
	if strings.ContainsAny(out+errOut, hiddenRunes) {
		t.Errorf("text output or notices print invisible characters raw:\n%q\n%q", out, errOut)
	}

	// A page without a running Pod names the revision and source in its notice.
	stub = &runtimeLogStub{t: t, activeID: "rev_1", pages: []func(http.ResponseWriter, url.Values){podless}}
	_, errOut, err = runLogsCommand(t, context.Background(), stub, "agent", "logs", "agt_1", "--source", "gateway", "--revision", "rev_1")
	if err != nil {
		t.Fatal(err)
	}
	if want := `notice: revision rev_\u2068x has no running Pod for source gate\u202bway`; !strings.Contains(errOut, want) || strings.ContainsAny(errOut, hiddenRunes) {
		t.Errorf("no-Pod notice = %q, want %s", errOut, want)
	}

	// NDJSON output is the exact record (JSON escaping keeps it valid); its
	// notices on stderr are text and escaped.
	stub = newStub()
	out, errOut, err = runLogsCommand(t, context.Background(), stub, "agent", "logs", "agt_1", "--source", "gateway", "-o", "json")
	if err != nil {
		t.Fatal(err)
	}
	if want := line + "\n" + gap + "\n" + withheld + "\n"; out != want {
		t.Errorf("NDJSON output altered the records:\n%q", out)
	}
	if !strings.Contains(errOut, `notice: - gap stream\u202ereplaced`) || strings.ContainsAny(errOut, hiddenRunes) {
		t.Errorf("NDJSON notices print invisible characters raw:\n%q", errOut)
	}
}

func TestVisibleTextEscapesOnlyInvisibleCharacters(t *testing.T) {
	for _, test := range []struct{ in, want string }{
		{"plain text, 日本語 and emoji \U0001f600", "plain text, 日本語 and emoji \U0001f600"},
		{"a\u202eb\u200bc\u2028d", `a\u202eb\u200bc\u2028d`},
		{"tag \U000e0041 private \ue000", `tag \U000e0041 private \ue000`},
		{"bad \xff byte", `bad \xff byte`},
		{`already \u202e`, `already \u202e`},
	} {
		if got := visibleText(test.in); got != test.want {
			t.Errorf("visibleText(%q) = %q, want %q", test.in, got, test.want)
		}
	}
}
