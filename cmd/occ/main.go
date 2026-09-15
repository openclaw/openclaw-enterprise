package main

import (
	"fmt"
	"os"

	"github.com/openclaw/openclaw-enterprise/internal/occcli"
)

func main() {
	command := occcli.New(os.Stdout, os.Stderr)
	if err := command.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
