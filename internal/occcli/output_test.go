package occcli

// Shared by install and read-only handoff tests on every CLI build target.
type handoffFailingWriter struct {
	remaining int
	err       error
}

func (w *handoffFailingWriter) Write(p []byte) (int, error) {
	n := min(len(p), w.remaining)
	w.remaining -= n
	if n < len(p) {
		return n, w.err
	}
	return n, nil
}
