// Package probes collects bounded, local-only runtime metadata for workspace directories.
package probes

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"

	"github.com/gmuxapp/gmux/packages/paths"
)

const (
	MaxTargets       = 256
	MaxScripts       = 32
	maxScriptOutput  = 16 << 10
	maxCommandOutput = 4 << 20
	maxIDLength      = 128
	maxLabelLength   = 128
	maxValueLength   = 1024
	maxURLLength     = 2048
)

// DirectoryProbe is the runtime metadata available for one canonical directory.
type DirectoryProbe struct {
	Git     *GitProbe     `json:"git,omitempty"`
	PR      *PRProbe      `json:"pr,omitempty"`
	Scripts []ScriptProbe `json:"scripts,omitempty"`
}

type GitProbe struct {
	Branch         string `json:"branch"`
	DirtyCount     int    `json:"dirty_count"`
	RepositoryKey  string `json:"repository_key,omitempty"`
	RepositoryName string `json:"repository_name,omitempty"`
	Upstream       string `json:"upstream,omitempty"`
	Ahead          *int   `json:"ahead,omitempty"`
	Behind         *int   `json:"behind,omitempty"`
}

type PRProbe struct {
	Number int    `json:"number"`
	Status string `json:"status"`
	URL    string `json:"url"`
}

type ScriptProbe struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	Value  string `json:"value"`
	Status string `json:"status"`
	URL    string `json:"url,omitempty"`
}

// SessionTarget contains only the fields needed to select a local workspace.
type SessionTarget struct {
	Peer          string
	WorkspaceRoot string
	Cwd           string
}

// CollectTargets canonicalizes and deduplicates configured paths and local
// session workspaces. Any session with Peer set is excluded before its path is
// inspected, so a hub never executes a remote cwd.
func CollectTargets(configured []string, sessions []SessionTarget) []string {
	seen := make(map[string]struct{}, MaxTargets)
	out := make([]string, 0, min(len(configured)+len(sessions), MaxTargets))
	add := func(candidate string) bool {
		root, err := canonicalDirectory(candidate)
		if err != nil {
			return false
		}
		if _, ok := seen[root]; ok {
			return false
		}
		seen[root] = struct{}{}
		out = append(out, root)
		return len(out) == MaxTargets
	}
	for _, configuredPath := range configured {
		if add(configuredPath) {
			sort.Strings(out)
			return out
		}
	}
	for _, session := range sessions {
		if session.Peer != "" {
			continue
		}
		root := session.WorkspaceRoot
		if root == "" {
			root = session.Cwd
		}
		if root != "" && add(root) {
			break
		}
	}
	sort.Strings(out)
	return out
}

func canonicalDirectory(path string) (string, error) {
	path = paths.NormalizePath(path)
	if path == "" {
		return "", errors.New("empty path")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	root, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(root)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", errors.New("not a directory")
	}
	return filepath.Clean(root), nil
}

// Config controls resource bounds. Zero values are filled from DefaultConfig.
type Config struct {
	TTL              time.Duration
	GitTimeout       time.Duration
	GHTimeout        time.Duration
	ScriptTimeout    time.Duration
	WorkspaceTimeout time.Duration
	MaxConcurrency   int
	ProbesDir        string
}

func DefaultConfig() Config {
	return Config{
		TTL:              15 * time.Second,
		GitTimeout:       2 * time.Second,
		GHTimeout:        4 * time.Second,
		ScriptTimeout:    2 * time.Second,
		WorkspaceTimeout: 6 * time.Second,
		MaxConcurrency:   4,
	}
}

func normalizeConfig(cfg Config) Config {
	defaults := DefaultConfig()
	if cfg.TTL < defaults.TTL {
		cfg.TTL = defaults.TTL
	}
	if cfg.GitTimeout <= 0 {
		cfg.GitTimeout = defaults.GitTimeout
	}
	if cfg.GHTimeout <= 0 {
		cfg.GHTimeout = defaults.GHTimeout
	}
	if cfg.ScriptTimeout <= 0 {
		cfg.ScriptTimeout = defaults.ScriptTimeout
	}
	if cfg.WorkspaceTimeout <= 0 {
		cfg.WorkspaceTimeout = defaults.WorkspaceTimeout
	}
	if cfg.MaxConcurrency <= 0 || cfg.MaxConcurrency > defaults.MaxConcurrency {
		cfg.MaxConcurrency = defaults.MaxConcurrency
	}
	return cfg
}

type cacheEntry struct {
	probe     DirectoryProbe
	fetchedAt time.Time
}

// Manager owns the TTL cache and bounded asynchronous refresh workers.
type Manager struct {
	mu       sync.Mutex
	cfg      Config
	cache    map[string]cacheEntry
	desired  map[string]struct{}
	pending  map[string]struct{}
	running  bool
	onChange func()
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
}

func NewManager(cfg Config, onChange func()) *Manager {
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{
		cfg:      normalizeConfig(cfg),
		cache:    make(map[string]cacheEntry),
		desired:  make(map[string]struct{}),
		pending:  make(map[string]struct{}),
		onChange: onChange,
		ctx:      ctx,
		cancel:   cancel,
	}
}

// Close cancels active commands and waits for the bounded worker set to exit.
func (m *Manager) Close() {
	m.cancel()
	m.wg.Wait()
}

// Refresh returns cached results immediately and schedules missing or stale
// targets. Callers must pass canonical paths produced by CollectTargets.
func (m *Manager) Refresh(targets []string) map[string]DirectoryProbe {
	if len(targets) > MaxTargets {
		targets = targets[:MaxTargets]
	}
	now := time.Now()
	m.mu.Lock()
	m.desired = make(map[string]struct{}, len(targets))
	for _, root := range targets {
		m.desired[root] = struct{}{}
		entry, ok := m.cache[root]
		if !ok || now.Sub(entry.fetchedAt) >= m.cfg.TTL {
			m.pending[root] = struct{}{}
		}
	}
	removed := false
	for root := range m.cache {
		if _, ok := m.desired[root]; !ok {
			delete(m.cache, root)
			removed = true
		}
	}
	for root := range m.pending {
		if _, ok := m.desired[root]; !ok {
			delete(m.pending, root)
		}
	}

	result := make(map[string]DirectoryProbe, len(targets))
	for _, root := range targets {
		if entry, ok := m.cache[root]; ok {
			result[root] = cloneProbe(entry.probe)
		}
	}
	if len(m.pending) > 0 && !m.running && m.ctx.Err() == nil {
		m.running = true
		m.wg.Add(1)
		go m.run()
	}
	m.mu.Unlock()
	if removed && m.ctx.Err() == nil && m.onChange != nil {
		m.onChange()
	}
	return result
}

func (m *Manager) run() {
	defer m.wg.Done()
	for {
		m.mu.Lock()
		batch := make([]string, 0, len(m.pending))
		for root := range m.pending {
			if _, wanted := m.desired[root]; wanted {
				batch = append(batch, root)
			}
		}
		m.pending = make(map[string]struct{})
		if len(batch) == 0 || m.ctx.Err() != nil {
			m.running = false
			m.mu.Unlock()
			return
		}
		m.mu.Unlock()
		sort.Strings(batch)

		scripts := discoverScripts(m.cfg)
		results := m.collectBatch(batch, scripts)
		changed := false
		now := time.Now()
		m.mu.Lock()
		for root, probe := range results {
			if _, wanted := m.desired[root]; !wanted {
				continue
			}
			old, exists := m.cache[root]
			if !exists || !reflect.DeepEqual(old.probe, probe) {
				changed = true
			}
			m.cache[root] = cacheEntry{probe: cloneProbe(probe), fetchedAt: now}
		}
		m.mu.Unlock()
		if changed && m.ctx.Err() == nil && m.onChange != nil {
			m.onChange()
		}
	}
}

func (m *Manager) collectBatch(roots []string, scripts []string) map[string]DirectoryProbe {
	workers := min(m.cfg.MaxConcurrency, len(roots))
	jobs := make(chan string)
	results := make(chan struct {
		root  string
		probe DirectoryProbe
	}, workers)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for root := range jobs {
				ctx, cancel := context.WithTimeout(m.ctx, m.cfg.WorkspaceTimeout)
				probe := collectWorkspace(ctx, root, scripts, m.cfg)
				cancel()
				results <- struct {
					root  string
					probe DirectoryProbe
				}{root: root, probe: probe}
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, root := range roots {
			select {
			case jobs <- root:
			case <-m.ctx.Done():
				return
			}
		}
	}()
	go func() {
		wg.Wait()
		close(results)
	}()
	out := make(map[string]DirectoryProbe, len(roots))
	for result := range results {
		out[result.root] = result.probe
	}
	return out
}

func cloneProbe(probe DirectoryProbe) DirectoryProbe {
	if probe.Git != nil {
		git := *probe.Git
		probe.Git = &git
	}
	if probe.PR != nil {
		pr := *probe.PR
		probe.PR = &pr
	}
	probe.Scripts = append([]ScriptProbe(nil), probe.Scripts...)
	return probe
}

func collectWorkspace(ctx context.Context, root string, scripts []string, cfg Config) DirectoryProbe {
	var probe DirectoryProbe
	git, github := collectGit(ctx, root, cfg.GitTimeout)
	probe.Git = git
	if git != nil && github {
		probe.PR = collectPR(ctx, root, cfg.GHTimeout)
	}
	for _, script := range scripts {
		if ctx.Err() != nil {
			break
		}
		if result, ok := runScript(ctx, script, root, cfg.ScriptTimeout); ok {
			probe.Scripts = append(probe.Scripts, result)
		}
	}
	return probe
}

func collectGit(parent context.Context, root string, timeout time.Duration) (*GitProbe, bool) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	inside, err := commandOutput(ctx, "", maxCommandOutput, "git", "-C", root, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(string(inside)) != "true" {
		return nil, false
	}
	branchOut, err := commandOutput(ctx, "", maxCommandOutput, "git", "-C", root, "branch", "--show-current")
	if err != nil {
		return nil, false
	}
	branch := strings.TrimSpace(string(branchOut))
	if branch == "" {
		branch = "HEAD"
	}
	if len(branch) > maxValueLength {
		return nil, false
	}
	status, err := commandOutput(ctx, "", maxCommandOutput, "git", "-C", root, "status", "--porcelain=v1", "--untracked-files=all")
	if err != nil {
		return nil, false
	}
	dirty := bytes.Count(status, []byte{'\n'})
	if len(status) > 0 && status[len(status)-1] != '\n' {
		dirty++
	}
	probe := &GitProbe{Branch: branch, DirtyCount: dirty}
	remotes, remoteErr := commandOutput(ctx, "", maxCommandOutput, "git", "-C", root, "remote", "-v")

	// Everything below is optional enrichment. A slow or older Git must not
	// discard the branch/dirty result already collected above.
	if commonOut, commonErr := commandOutput(ctx, "", maxCommandOutput, "git", "-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"); commonErr == nil {
		if commonDir, canonicalErr := canonicalGitCommonDir(root, commonOut); canonicalErr == nil {
			sum := sha256.Sum256([]byte(commonDir))
			probe.RepositoryKey = hex.EncodeToString(sum[:])
			probe.RepositoryName = repositoryName(commonDir)
		}
	}
	if upstreamOut, upstreamErr := commandOutput(ctx, "", maxValueLength, "git", "-C", root, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"); upstreamErr == nil {
		upstream := strings.TrimSpace(string(upstreamOut))
		if upstream != "" && len(upstream) <= maxValueLength {
			probe.Upstream = upstream
			if countsOut, countsErr := commandOutput(ctx, "", 128, "git", "-C", root, "rev-list", "--left-right", "--count", "HEAD...@{upstream}"); countsErr == nil {
				fields := strings.Fields(string(countsOut))
				if len(fields) == 2 {
					ahead, aheadErr := strconv.Atoi(fields[0])
					behind, behindErr := strconv.Atoi(fields[1])
					if aheadErr == nil && behindErr == nil && ahead >= 0 && behind >= 0 {
						probe.Ahead = &ahead
						probe.Behind = &behind
					}
				}
			}
		}
	}
	return probe, remoteErr == nil && hasGitHubRemote(remotes)
}

func canonicalGitCommonDir(root string, output []byte) (string, error) {
	commonDir := strings.TrimSpace(string(output))
	if commonDir == "" {
		return "", errors.New("empty git common dir")
	}
	if !filepath.IsAbs(commonDir) {
		commonDir = filepath.Join(root, commonDir)
	}
	absolute, err := filepath.Abs(commonDir)
	if err != nil {
		return "", err
	}
	canonical, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(canonical)
	if err != nil || !info.IsDir() {
		return "", errors.New("git common dir is not a directory")
	}
	return filepath.Clean(canonical), nil
}

func repositoryName(commonDir string) string {
	name := filepath.Base(filepath.Dir(commonDir))
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name))
	if name == "" || name == "." || name == string(filepath.Separator) {
		return ""
	}
	runes := []rune(name)
	if len(runes) > maxLabelLength {
		name = string(runes[:maxLabelLength])
	}
	return name
}

func hasGitHubRemote(output []byte) bool {
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		raw := fields[1]
		if strings.HasPrefix(strings.ToLower(raw), "git@github.com:") {
			return true
		}
		parsed, err := url.Parse(raw)
		if err == nil && strings.EqualFold(parsed.Hostname(), "github.com") {
			return true
		}
	}
	return false
}

func collectPR(parent context.Context, root string, timeout time.Duration) *PRProbe {
	if _, err := exec.LookPath("gh"); err != nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	out, err := commandOutput(ctx, root, maxScriptOutput, "gh", "pr", "view", "--json", "number,state,url,isDraft")
	if err != nil {
		return nil
	}
	var payload struct {
		Number  int    `json:"number"`
		State   string `json:"state"`
		URL     string `json:"url"`
		IsDraft bool   `json:"isDraft"`
	}
	decoder := json.NewDecoder(bytes.NewReader(out))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || payload.Number <= 0 || !validHTTPURL(payload.URL) {
		return nil
	}
	if err := requireEOF(decoder); err != nil {
		return nil
	}
	status := strings.ToLower(payload.State)
	if payload.IsDraft {
		status = "draft"
	}
	switch status {
	case "open", "closed", "merged", "draft":
	default:
		return nil
	}
	return &PRProbe{Number: payload.Number, Status: status, URL: payload.URL}
}

func discoverScripts(cfg Config) []string {
	dir := cfg.ProbesDir
	if dir == "" {
		if xdg := os.Getenv("XDG_CONFIG_HOME"); xdg != "" {
			dir = filepath.Join(xdg, "gmux", "probes")
		} else if home, err := os.UserHomeDir(); err == nil {
			dir = filepath.Join(home, ".config", "gmux", "probes")
		}
	}
	if dir == "" {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	out := make([]string, 0, min(len(entries), MaxScripts))
	for _, entry := range entries {
		if len(out) == MaxScripts {
			break
		}
		name := entry.Name()
		if filepath.Ext(name) != ".sh" {
			continue
		}
		path := filepath.Join(dir, name)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o111 == 0 {
			continue
		}
		out = append(out, path)
	}
	return out
}

func runScript(parent context.Context, script, root string, timeout time.Duration) (ScriptProbe, bool) {
	id := strings.TrimSuffix(filepath.Base(script), ".sh")
	if id == "" || len(id) > maxIDLength {
		return ScriptProbe{}, false
	}
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, script, root)
	prepareCommand(cmd)
	cmd.Env = append(os.Environ(), "GMUX_WORKSPACE="+root)
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 100 * time.Millisecond
	var stdout limitedBuffer
	stdout.limit = maxScriptOutput
	cmd.Stdout = &stdout
	err := cmd.Run()
	killCommandGroup(cmd)
	if err != nil || stdout.exceeded {
		return ScriptProbe{}, false
	}
	var payload struct {
		Label  *string `json:"label"`
		Value  *string `json:"value"`
		Status *string `json:"status,omitempty"`
		URL    *string `json:"url,omitempty"`
	}
	decoder := json.NewDecoder(bytes.NewReader(stdout.Bytes()))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || requireEOF(decoder) != nil {
		return ScriptProbe{}, false
	}
	if payload.Label == nil || payload.Value == nil || *payload.Label == "" || len(*payload.Label) > maxLabelLength || len(*payload.Value) > maxValueLength {
		return ScriptProbe{}, false
	}
	status := "neutral"
	if payload.Status != nil {
		status = *payload.Status
	}
	switch status {
	case "neutral", "info", "success", "warning", "error":
	default:
		return ScriptProbe{}, false
	}
	probeURL := ""
	if payload.URL != nil {
		probeURL = *payload.URL
		if len(probeURL) > maxURLLength || !validHTTPURL(probeURL) {
			return ScriptProbe{}, false
		}
	}
	return ScriptProbe{ID: id, Label: *payload.Label, Value: *payload.Value, Status: status, URL: probeURL}, true
}

func validHTTPURL(raw string) bool {
	parsed, err := url.ParseRequestURI(raw)
	return err == nil && (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("multiple JSON values")
		}
		return err
	}
	return nil
}

type limitedBuffer struct {
	bytes.Buffer
	limit    int
	exceeded bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.Buffer.Len()+len(p) > b.limit {
		remaining := max(0, b.limit-b.Buffer.Len())
		if remaining > 0 {
			_, _ = b.Buffer.Write(p[:remaining])
		}
		b.exceeded = true
		return len(p), nil
	}
	return b.Buffer.Write(p)
}

func commandOutput(ctx context.Context, dir string, limit int, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	prepareCommand(cmd)
	cmd.Dir = dir
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 100 * time.Millisecond
	var stdout limitedBuffer
	stdout.limit = limit
	cmd.Stdout = &stdout
	err := cmd.Run()
	killCommandGroup(cmd)
	if err != nil {
		return nil, err
	}
	if stdout.exceeded {
		return nil, errors.New("output limit exceeded")
	}
	return stdout.Bytes(), nil
}

// Commands run in their own process group. Context cancellation kills the
// entire group, and the post-Wait cleanup catches children that a successful
// script left behind while preserving direct (non-shell) execution.
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return os.ErrProcessDone
		}
		if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
		return nil
	}
}

func killCommandGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
