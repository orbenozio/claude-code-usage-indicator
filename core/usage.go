package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const usageEndpoint = "https://api.anthropic.com/api/oauth/usage"

// credentials mirrors the parts of ~/.claude/.credentials.json we read.
// We ONLY read accessToken — never write this file back.
type credentials struct {
	ClaudeAiOauth struct {
		AccessToken string `json:"accessToken"`
		ExpiresAt   int64  `json:"expiresAt"` // epoch ms
	} `json:"claudeAiOauth"`
}

// rawUsage is the upstream response. Every field is optional; unknown keys ignored.
type rawWindow struct {
	Utilization *float64 `json:"utilization"`
	ResetsAt    string   `json:"resets_at"`
}

type rawUsage struct {
	FiveHour   *rawWindow `json:"five_hour"`
	SevenDay   *rawWindow `json:"seven_day"`
	ExtraUsage *struct {
		IsEnabled bool `json:"is_enabled"`
	} `json:"extra_usage"`
}

// Window is the normalized per-window shape adapters render.
type Window struct {
	Utilization int    `json:"utilization"`
	ResetsAt    string `json:"resets_at"`
}

// Usage is the stable, host-agnostic output of the core.
type Usage struct {
	FiveHour   *Window `json:"five_hour"`
	SevenDay   *Window `json:"seven_day"`
	ExtraUsage struct {
		Enabled bool `json:"enabled"`
	} `json:"extra_usage"`
	FetchedAt string `json:"fetched_at"`
	Stale     bool   `json:"stale"`
	Error     string `json:"error,omitempty"`
}

// credentialsPath returns ~/.claude/.credentials.json for the current user.
func credentialsPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".claude", ".credentials.json"), nil
}

// readAccessToken reads the OAuth access token. Read-only: it never writes the file.
func readAccessToken() (string, error) {
	path, err := credentialsPath()
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("cannot read credentials: %w", err)
	}
	var c credentials
	if err := json.Unmarshal(data, &c); err != nil {
		return "", fmt.Errorf("cannot parse credentials: %w", err)
	}
	if c.ClaudeAiOauth.AccessToken == "" {
		return "", fmt.Errorf("no accessToken in credentials")
	}
	return c.ClaudeAiOauth.AccessToken, nil
}

// fetchUsage performs the single GET. Returns the parsed upstream body.
func fetchUsage(token string, timeout time.Duration) (*rawUsage, error) {
	req, err := http.NewRequest(http.MethodGet, usageEndpoint, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	req.Header.Set("anthropic-version", "2023-06-01")

	client := &http.Client{Timeout: timeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("unauthorized (token expired?) — open Claude Code to refresh")
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("usage endpoint returned HTTP %d", resp.StatusCode)
	}
	var ru rawUsage
	if err := json.Unmarshal(body, &ru); err != nil {
		return nil, fmt.Errorf("cannot parse usage response: %w", err)
	}
	return &ru, nil
}

// normalize flattens upstream into the stable Usage shape.
func normalize(ru *rawUsage, fetchedAt time.Time) *Usage {
	u := &Usage{
		FetchedAt: fetchedAt.UTC().Format(time.RFC3339),
		Stale:     false,
	}
	u.FiveHour = normalizeWindow(ru.FiveHour)
	u.SevenDay = normalizeWindow(ru.SevenDay)
	if ru.ExtraUsage != nil {
		u.ExtraUsage.Enabled = ru.ExtraUsage.IsEnabled
	}
	return u
}

func normalizeWindow(w *rawWindow) *Window {
	if w == nil || w.Utilization == nil {
		return nil
	}
	out := &Window{Utilization: int(*w.Utilization + 0.5)}
	if t, err := time.Parse(time.RFC3339, w.ResetsAt); err == nil {
		out.ResetsAt = t.UTC().Format(time.RFC3339)
	} else {
		out.ResetsAt = w.ResetsAt // pass through if unparseable
	}
	return out
}

// errorUsage builds the normalized shape for a failure, so adapters never break.
func errorUsage(err error, fetchedAt time.Time) *Usage {
	return &Usage{
		FetchedAt: fetchedAt.UTC().Format(time.RFC3339),
		Stale:     true,
		Error:     err.Error(),
	}
}
