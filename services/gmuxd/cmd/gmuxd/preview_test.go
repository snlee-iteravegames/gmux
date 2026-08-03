package main

import (
	"bytes"
	"encoding/json"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gmuxapp/gmux/services/gmuxd/internal/store"
)

type previewErrorEnvelope struct {
	OK    bool `json:"ok"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func previewTestRequest(t *testing.T, sessions *store.Store, method, sessionID, pathValue string) *httptest.ResponseRecorder {
	t.Helper()
	requestURL := "/v1/sessions/" + sessionID + "/preview"
	if pathValue != "" {
		requestURL += "?" + url.Values{"path": []string{pathValue}}.Encode()
	}
	req := httptest.NewRequest(method, requestURL, nil)
	rec := httptest.NewRecorder()
	previewHandler(rec, req, sessionID, sessions)
	return rec
}

func previewTestStore(cwd, workspaceRoot string) *store.Store {
	sessions := store.New()
	sessions.Upsert(store.Session{
		ID:            "local",
		Cwd:           cwd,
		WorkspaceRoot: workspaceRoot,
		Kind:          "shell",
	})
	return sessions
}

func requirePreviewError(t *testing.T, rec *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if rec.Code != status {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, status, rec.Body.String())
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	var envelope previewErrorEnvelope
	if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("decode error response: %v; body=%s", err, rec.Body.String())
	}
	if envelope.OK {
		t.Fatal("error response unexpectedly has ok=true")
	}
	if envelope.Error.Code != code {
		t.Fatalf("error code = %q, want %q", envelope.Error.Code, code)
	}
}

func TestPreviewServesRelativeWorkspaceText(t *testing.T) {
	workspace := t.TempDir()
	cwd := filepath.Join(workspace, "src")
	if err := os.Mkdir(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	body := []byte("# Preview\n\nhello\n")
	if err := os.WriteFile(filepath.Join(workspace, "README.md"), body, 0o644); err != nil {
		t.Fatal(err)
	}

	sessions := previewTestStore(cwd, workspace)
	rec := previewTestRequest(t, sessions, http.MethodGet, "local", "../README.md")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if !bytes.Equal(rec.Body.Bytes(), body) {
		t.Fatalf("body = %q, want %q", rec.Body.Bytes(), body)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Errorf("Content-Type = %q, want text/plain charset", got)
	}
	disposition, params, err := mime.ParseMediaType(rec.Header().Get("Content-Disposition"))
	if err != nil {
		t.Fatalf("parse Content-Disposition: %v", err)
	}
	if disposition != "inline" || params["filename"] != "README.md" {
		t.Errorf("Content-Disposition = %q, want inline README.md", rec.Header().Get("Content-Disposition"))
	}
}

func TestPreviewAllowsAbsolutePathInsideWorkspaceRoot(t *testing.T) {
	workspace := t.TempDir()
	cwd := filepath.Join(workspace, "src")
	if err := os.Mkdir(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(workspace, "notes.txt")
	if err := os.WriteFile(target, []byte("notes\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rec := previewTestRequest(t, previewTestStore(cwd, workspace), http.MethodGet, "local", target)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
}

func TestPreviewServesAllowedImages(t *testing.T) {
	tests := []struct {
		name        string
		filename    string
		data        []byte
		contentType string
	}{
		{name: "png", filename: "image.png", data: []byte("\x89PNG\r\n\x1a\n"), contentType: "image/png"},
		{name: "jpeg", filename: "image.jpeg", data: []byte("\xff\xd8\xff\xe0JFIF\x00"), contentType: "image/jpeg"},
		{name: "gif", filename: "image.gif", data: []byte("GIF89a"), contentType: "image/gif"},
		{name: "webp", filename: "image.webp", data: []byte("RIFF\x04\x00\x00\x00WEBPVP8 "), contentType: "image/webp"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, tt.filename), tt.data, 0o644); err != nil {
				t.Fatal(err)
			}
			rec := previewTestRequest(t, previewTestStore(root, root), http.MethodGet, "local", tt.filename)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
			}
			if got := rec.Header().Get("Content-Type"); got != tt.contentType {
				t.Fatalf("Content-Type = %q, want %q", got, tt.contentType)
			}
		})
	}
}

func TestPreviewRejectsMissingAndRemoteSessions(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	sessions := previewTestStore(root, root)

	rec := previewTestRequest(t, sessions, http.MethodGet, "missing", "file.txt")
	requirePreviewError(t, rec, http.StatusNotFound, "not_found")

	sessions.UpsertRemote(store.Session{
		ID:            "remote",
		Peer:          "other-host",
		Cwd:           root,
		WorkspaceRoot: root,
		Kind:          "shell",
	})
	rec = previewTestRequest(t, sessions, http.MethodGet, "remote", "file.txt")
	requirePreviewError(t, rec, http.StatusNotImplemented, "remote_preview_unsupported")
}

func TestPreviewValidatesMethodAndPath(t *testing.T) {
	root := t.TempDir()
	sessions := previewTestStore(root, root)

	rec := previewTestRequest(t, sessions, http.MethodPost, "local", "file.txt")
	requirePreviewError(t, rec, http.StatusMethodNotAllowed, "bad_request")

	rec = previewTestRequest(t, sessions, http.MethodGet, "local", "")
	requirePreviewError(t, rec, http.StatusBadRequest, "bad_request")
}

func TestPreviewBlocksTraversalAbsoluteEscapeAndSymlinkEscape(t *testing.T) {
	parent := t.TempDir()
	workspace := filepath.Join(parent, "workspace")
	cwd := filepath.Join(workspace, "src")
	outside := filepath.Join(parent, "secret.txt")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outside, []byte("secret"), 0o644); err != nil {
		t.Fatal(err)
	}
	sessions := previewTestStore(cwd, workspace)

	for _, pathValue := range []string{"../../secret.txt", outside, "../../missing.txt"} {
		rec := previewTestRequest(t, sessions, http.MethodGet, "local", pathValue)
		requirePreviewError(t, rec, http.StatusForbidden, "path_outside_workspace")
	}

	link := filepath.Join(workspace, "escape.txt")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	rec := previewTestRequest(t, sessions, http.MethodGet, "local", "../escape.txt")
	requirePreviewError(t, rec, http.StatusForbidden, "path_outside_workspace")
}

func TestPreviewAllowsSymlinkThatStaysInsideRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "real.txt"), []byte("safe"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("real.txt", filepath.Join(root, "alias.txt")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	rec := previewTestRequest(t, previewTestStore(root, root), http.MethodGet, "local", "alias.txt")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "safe" {
		t.Fatalf("body = %q, want safe", rec.Body.String())
	}
}

func TestPreviewRejectsNonRegularAndMissingFiles(t *testing.T) {
	root := t.TempDir()
	sessions := previewTestStore(root, root)

	rec := previewTestRequest(t, sessions, http.MethodGet, "local", "missing.txt")
	requirePreviewError(t, rec, http.StatusNotFound, "not_found")

	if err := os.Mkdir(filepath.Join(root, "directory.txt"), 0o755); err != nil {
		t.Fatal(err)
	}
	rec = previewTestRequest(t, sessions, http.MethodGet, "local", "directory.txt")
	requirePreviewError(t, rec, http.StatusUnsupportedMediaType, "unsupported_file")
}

func TestPreviewMIMEAndExtensionAllowlist(t *testing.T) {
	tests := []struct {
		name     string
		filename string
		data     []byte
	}{
		{name: "html", filename: "page.html", data: []byte("<!doctype html><title>x</title>")},
		{name: "html disguised as markdown", filename: "page.md", data: []byte("<!doctype html><title>x</title>")},
		{name: "svg", filename: "image.svg", data: []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>")},
		{name: "pdf", filename: "file.pdf", data: []byte("%PDF-1.7\n")},
		{name: "nul binary", filename: "file.txt", data: []byte("hello\x00world")},
		{name: "invalid utf8", filename: "file.txt", data: []byte{'h', 'i', 0xff}},
		{name: "unknown text extension", filename: "file.exe", data: []byte("plain text")},
		{name: "image extension mismatch", filename: "image.jpg", data: []byte("\x89PNG\r\n\x1a\n")},
		{name: "text named as image", filename: "image.png", data: []byte("plain text")},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			if err := os.WriteFile(filepath.Join(root, tt.filename), tt.data, 0o644); err != nil {
				t.Fatal(err)
			}
			rec := previewTestRequest(t, previewTestStore(root, root), http.MethodGet, "local", tt.filename)
			requirePreviewError(t, rec, http.StatusUnsupportedMediaType, "unsupported_media_type")
		})
	}
}

func TestPreviewEnforcesTextAndImageSizeLimits(t *testing.T) {
	root := t.TempDir()
	sessions := previewTestStore(root, root)

	textPath := filepath.Join(root, "large.txt")
	if err := os.WriteFile(textPath, bytes.Repeat([]byte{'a'}, maxPreviewTextBytes+1), 0o644); err != nil {
		t.Fatal(err)
	}
	rec := previewTestRequest(t, sessions, http.MethodGet, "local", "large.txt")
	requirePreviewError(t, rec, http.StatusRequestEntityTooLarge, "too_large")

	imagePath := filepath.Join(root, "large.png")
	imageFile, err := os.Create(imagePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := imageFile.Write([]byte("\x89PNG\r\n\x1a\n")); err != nil {
		imageFile.Close()
		t.Fatal(err)
	}
	if err := imageFile.Truncate(maxPreviewImageBytes + 1); err != nil {
		imageFile.Close()
		t.Fatal(err)
	}
	if err := imageFile.Close(); err != nil {
		t.Fatal(err)
	}
	rec = previewTestRequest(t, sessions, http.MethodGet, "local", "large.png")
	requirePreviewError(t, rec, http.StatusRequestEntityTooLarge, "too_large")
}

func TestPreviewSanitizesContentDispositionFilename(t *testing.T) {
	root := t.TempDir()
	filename := "unsafe\nname.txt"
	if err := os.WriteFile(filepath.Join(root, filename), []byte("safe"), 0o644); err != nil {
		t.Fatal(err)
	}

	rec := previewTestRequest(t, previewTestStore(root, root), http.MethodGet, "local", filename)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rec.Code, rec.Body.String())
	}
	header := rec.Header().Get("Content-Disposition")
	if strings.ContainsAny(header, "\r\n") {
		t.Fatalf("unsafe Content-Disposition header %q", header)
	}
	_, params, err := mime.ParseMediaType(header)
	if err != nil {
		t.Fatal(err)
	}
	if params["filename"] != "unsafe_name.txt" {
		t.Fatalf("filename = %q, want unsafe_name.txt", params["filename"])
	}
}
