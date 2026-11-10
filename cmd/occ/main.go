package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/openclaw/openclaw-enterprise/internal/occcli"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		// Let another interrupt terminate a command still waiting on I/O or cleanup.
		cancel()
	}()
	command := occcli.New(os.Stdout, os.Stderr)
	if err := command.ExecuteContext(ctx); err != nil {
		var status *occcli.ExitStatusError
		if errors.As(err, &status) {
			cancel()
			os.Exit(status.Code)
		}
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
