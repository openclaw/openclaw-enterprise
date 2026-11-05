package occdev

import (
	"context"
	"io"
	"maps"
	"os"
	"sync"
)

// concurrently runs independent Local Setup steps at the same time and returns
// once every step has returned. A canceled step's commands are stopped through
// its context: the command it is waiting on is killed, but not processes that
// command started itself.
//
// Each step gets its own copy of the runner. The copies share the caller's
// output, serialized unless it is a file, and a private copy of the command
// environment. BuildKit writes plain progress so concurrent output stays legible.
//
// The first step to fail cancels the others, and only its error is returned:
// a sibling's failure after that cancellation is its consequence, not a second
// cause. When the caller's context ends first, every step fails after the
// cancellation, so the first failed step in argument order is reported.
func (r *runner) concurrently(ctx context.Context, steps ...func(context.Context, *runner) error) error {
	stepCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	var outputMu sync.Mutex
	out, errOut := lockedOutput(r.opts.Out, &outputMu), lockedOutput(r.opts.Err, &outputMu)
	var mu sync.Mutex
	var first error
	errs := make([]error, len(steps))
	var wg sync.WaitGroup
	for index, step := range steps {
		stepRunner := *r
		stepRunner.opts.Out, stepRunner.opts.Err = out, errOut
		stepRunner.env = make(map[string]string, len(r.env)+1)
		maps.Copy(stepRunner.env, r.env)
		if _, set := stepRunner.env["BUILDKIT_PROGRESS"]; !set {
			stepRunner.env["BUILDKIT_PROGRESS"] = "plain"
		}
		wg.Go(func() {
			err := step(stepCtx, &stepRunner)
			if err == nil {
				return
			}
			mu.Lock()
			defer mu.Unlock()
			errs[index] = err
			if first == nil && stepCtx.Err() == nil {
				first = err
				cancel()
			}
		})
	}
	wg.Wait()
	if first != nil {
		return first
	}
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// lockedOutput serializes writes to a shared writer. A file is returned
// unchanged: commands then write to it directly, as they do outside concurrent
// steps, and keep seeing a terminal when it is one.
func lockedOutput(w io.Writer, mu *sync.Mutex) io.Writer {
	if _, ok := w.(*os.File); ok {
		return w
	}
	return &lockedWriter{mu: mu, w: w}
}

type lockedWriter struct {
	mu *sync.Mutex
	w  io.Writer
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}
