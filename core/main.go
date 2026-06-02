// Command usage-core reads the Claude OAuth token (read-only) and prints the
// current usage as normalized JSON on stdout. It is the shared, host-agnostic
// core; per-host adapters (VS Code, JetBrains, …) just spawn it and render.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"
)

func main() {
	// Flags are forward-looking; default behavior is a single JSON fetch.
	_ = flag.Bool("json", true, "emit normalized usage as JSON (default)")
	timeoutMs := flag.Int("timeout", 8000, "HTTP timeout in milliseconds")
	flag.Parse()

	now := time.Now()
	usage := run(time.Duration(*timeoutMs) * time.Millisecond)

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(usage); err != nil {
		fmt.Fprintln(os.Stderr, "failed to encode usage:", err)
		os.Exit(1)
	}
	// Logical failures (expired token, network) are carried inside the JSON
	// (error/stale) so adapters get one predictable shape. Exit 0 in that case.
	_ = now
}

// run does the whole one-shot: read token, fetch, normalize. On any failure it
// returns the normalized error shape rather than crashing.
func run(timeout time.Duration) *Usage {
	fetchedAt := time.Now()
	token, err := readAccessToken()
	if err != nil {
		return errorUsage(err, 0, fetchedAt)
	}
	raw, retryAfter, err := fetchUsage(token, timeout)
	if err != nil {
		return errorUsage(err, retryAfter, fetchedAt)
	}
	return normalize(raw, fetchedAt)
}
