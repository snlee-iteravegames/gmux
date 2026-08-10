package agentext

import (
	"os"
	"strings"
	"testing"
)

func TestPathMaterializesReadableExtension(t *testing.T) {
	t.Setenv("XDG_CACHE_HOME", t.TempDir())

	p, err := Path()
	if err != nil {
		t.Fatalf("Path: %v", err)
	}
	if !strings.HasSuffix(p, ".mjs") {
		t.Errorf("expected .mjs path, got %q", p)
	}
	data, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("read materialized ext: %v", err)
	}
	if !strings.Contains(string(data), "session_start") {
		t.Error("materialized extension missing session_start handler")
	}
	if !strings.Contains(string(data), "pi.setSessionName(command.name)") ||
		!strings.Contains(string(data), "pi.getSessionName()") {
		t.Error("materialized extension missing canonical pi rename API calls")
	}
	if strings.Contains(string(data), `path: "/input"`) {
		t.Error("session rename must never use PTY /input injection")
	}

	// Idempotent: a second call returns the same path.
	p2, err := Path()
	if err != nil || p2 != p {
		t.Errorf("Path not idempotent: %q/%v vs %q", p2, err, p)
	}
}
