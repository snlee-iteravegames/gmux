package probes

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCollectGitBranchAndDirtyCount(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	root := t.TempDir()
	runTestCommand(t, root, "git", "init", "-b", "probe-branch")
	if err := os.WriteFile(filepath.Join(root, "dirty.txt"), []byte("dirty"), 0o600); err != nil {
		t.Fatal(err)
	}

	git, github := collectGit(context.Background(), root, 2*time.Second)
	if git == nil {
		t.Fatal("expected git probe")
	}
	if git.Branch != "probe-branch" {
		t.Fatalf("branch = %q, want probe-branch", git.Branch)
	}
	if git.DirtyCount != 1 {
		t.Fatalf("dirty_count = %d, want 1", git.DirtyCount)
	}
	if github {
		t.Fatal("repository without remotes reported a GitHub remote")
	}
}

func TestCollectGitNonRepositoryIsOmitted(t *testing.T) {
	git, github := collectGit(context.Background(), t.TempDir(), 2*time.Second)
	if git != nil || github {
		t.Fatalf("non-repository returned git=%#v github=%v", git, github)
	}
}

func TestCollectTargetsCanonicalDedupAndRemoteExclusion(t *testing.T) {
	root := t.TempDir()
	alias := filepath.Join(t.TempDir(), "alias")
	if err := os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	remoteOnly := t.TempDir()
	canonicalRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}

	got := CollectTargets([]string{root, alias}, []SessionTarget{
		{Cwd: root},
		{WorkspaceRoot: alias, Cwd: t.TempDir()},
		{Peer: "remote-hub", WorkspaceRoot: remoteOnly},
	})
	if len(got) != 1 || got[0] != canonicalRoot {
		t.Fatalf("targets = %#v, want only canonical %q", got, canonicalRoot)
	}
	for _, target := range got {
		if target == remoteOnly {
			t.Fatal("remote session workspace was collected")
		}
	}
}

func TestScriptProbeValidContractAndWorkspaceArguments(t *testing.T) {
	root := t.TempDir()
	dir := t.TempDir()
	script := writeScript(t, dir, "workspace.sh", `#!/bin/sh
printf '{"label":"Workspace","value":"%s|%s","status":"success","url":"https://example.com/probe"}' "$1" "$GMUX_WORKSPACE"
`)
	got, ok := runScript(context.Background(), script, root, time.Second)
	if !ok {
		t.Fatal("valid script was omitted")
	}
	if got.ID != "workspace" || got.Label != "Workspace" || got.Value != root+"|"+root || got.Status != "success" || got.URL != "https://example.com/probe" {
		t.Fatalf("unexpected script probe: %#v", got)
	}
}

func TestScriptProbeInvalidJSONAndUnknownFieldAreOmitted(t *testing.T) {
	root := t.TempDir()
	dir := t.TempDir()
	invalid := writeScript(t, dir, "invalid.sh", "#!/bin/sh\nprintf 'not-json'\n")
	unknown := writeScript(t, dir, "unknown.sh", "#!/bin/sh\nprintf '{\"label\":\"L\",\"value\":\"V\",\"extra\":true}'\n")
	if _, ok := runScript(context.Background(), invalid, root, time.Second); ok {
		t.Fatal("invalid JSON script was accepted")
	}
	if _, ok := runScript(context.Background(), unknown, root, time.Second); ok {
		t.Fatal("unknown JSON field was accepted")
	}
}

func TestScriptProbeTimeoutIsOmitted(t *testing.T) {
	script := writeScript(t, t.TempDir(), "slow.sh", "#!/bin/sh\nsleep 1\nprintf '{\"label\":\"L\",\"value\":\"V\"}'\n")
	start := time.Now()
	if _, ok := runScript(context.Background(), script, t.TempDir(), 50*time.Millisecond); ok {
		t.Fatal("timed-out script was accepted")
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("script timeout took %s", elapsed)
	}
}

func TestScriptProbeOversizedStdoutIsOmitted(t *testing.T) {
	script := writeScript(t, t.TempDir(), "large.sh", "#!/bin/sh\nhead -c 20000 /dev/zero\n")
	if _, ok := runScript(context.Background(), script, t.TempDir(), time.Second); ok {
		t.Fatal("oversized stdout was accepted")
	}
}

func TestDiscoverScriptsRejectsSymlinksAndNonExecutableFiles(t *testing.T) {
	dir := t.TempDir()
	valid := writeScript(t, dir, "valid.sh", "#!/bin/sh\nprintf '{\"label\":\"L\",\"value\":\"V\"}'\n")
	if err := os.Symlink(valid, filepath.Join(dir, "linked.sh")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "plain.sh"), []byte("#!/bin/sh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "directory.sh"), 0o755); err != nil {
		t.Fatal(err)
	}

	got := discoverScripts(Config{ProbesDir: dir})
	if len(got) != 1 || got[0] != valid {
		t.Fatalf("scripts = %#v, want only %q", got, valid)
	}
}

func TestManagerCachesAndDeduplicatesChangeNotification(t *testing.T) {
	root := t.TempDir()
	var changes atomic.Int32
	manager := NewManager(Config{ProbesDir: t.TempDir()}, func() { changes.Add(1) })
	defer manager.Close()

	if got := manager.Refresh([]string{root}); len(got) != 0 {
		t.Fatalf("first refresh returned uncached values: %#v", got)
	}
	deadline := time.Now().Add(2 * time.Second)
	for changes.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if changes.Load() != 1 {
		t.Fatalf("change notifications = %d, want 1", changes.Load())
	}
	if got := manager.Refresh([]string{root}); len(got) != 1 {
		t.Fatalf("cached refresh = %#v, want one directory", got)
	}

	// Force the entry stale without waiting for the production 15s minimum.
	// Recomputing an identical result must update freshness without emitting.
	manager.mu.Lock()
	entry := manager.cache[root]
	entry.fetchedAt = time.Time{}
	manager.cache[root] = entry
	manager.mu.Unlock()
	manager.Refresh([]string{root})
	deadline = time.Now().Add(2 * time.Second)
	refreshed := false
	for time.Now().Before(deadline) {
		manager.mu.Lock()
		refreshed = !manager.cache[root].fetchedAt.IsZero()
		manager.mu.Unlock()
		if refreshed {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !refreshed {
		t.Fatal("stale cache entry was not recomputed")
	}
	if changes.Load() != 1 {
		t.Fatalf("identical recomputation emitted duplicate notification: %d", changes.Load())
	}
}

func TestHasGitHubRemote(t *testing.T) {
	valid := []string{
		"origin\tgit@github.com:gmuxapp/gmux.git (fetch)\n",
		"upstream\thttps://github.com/gmuxapp/gmux.git (fetch)\n",
		"origin\tssh://git@github.com/gmuxapp/gmux.git (fetch)\n",
	}
	for _, remote := range valid {
		if !hasGitHubRemote([]byte(remote)) {
			t.Errorf("GitHub remote not detected: %q", remote)
		}
	}
	if hasGitHubRemote([]byte("origin\thttps://evilgithub.com/gmuxapp/gmux (fetch)\n")) {
		t.Fatal("lookalike host accepted as GitHub")
	}
}

func writeScript(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}

func runTestCommand(t *testing.T, dir, name string, args ...string) {
	t.Helper()
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, output)
	}
}
