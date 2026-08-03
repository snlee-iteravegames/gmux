package main

import (
	"bytes"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/gmuxapp/gmux/services/gmuxd/internal/store"
)

const (
	maxPreviewTextBytes  = 2 << 20  // 2 MiB
	maxPreviewImageBytes = 10 << 20 // 10 MiB
)

type previewRoot struct {
	absolute string
	resolved string
}

type previewError struct {
	status  int
	code    string
	message string
}

func (e *previewError) Error() string { return e.message }

var previewImageTypes = map[string]string{
	".gif":  "image/gif",
	".jpeg": "image/jpeg",
	".jpg":  "image/jpeg",
	".png":  "image/png",
	".webp": "image/webp",
}

var previewTextExtensions = map[string]struct{}{
	"": {},

	".astro": {}, ".bash": {}, ".bat": {}, ".c": {}, ".cc": {}, ".cfg": {},
	".cjs": {}, ".conf": {}, ".cpp": {}, ".cs": {}, ".css": {}, ".csv": {},
	".cxx": {}, ".dart": {}, ".diff": {}, ".editorconfig": {}, ".env": {},
	".erl": {}, ".ex": {}, ".exs": {}, ".fish": {}, ".fs": {}, ".fsx": {},
	".gitignore": {}, ".gitattributes": {}, ".gql": {}, ".go": {}, ".graphql": {},
	".h": {}, ".hpp": {}, ".hrl": {}, ".ini": {}, ".java": {}, ".js": {},
	".json": {}, ".jsonc": {}, ".jsx": {}, ".kt": {}, ".kts": {}, ".less": {},
	".log": {}, ".lua": {}, ".m": {}, ".markdown": {}, ".md": {}, ".mdown": {},
	".mjs": {}, ".mm": {}, ".patch": {}, ".php": {}, ".properties": {},
	".proto": {}, ".ps1": {}, ".py": {}, ".pyi": {}, ".r": {}, ".rb": {},
	".rs": {}, ".sass": {}, ".scala": {}, ".scss": {}, ".sh": {}, ".sql": {},
	".svelte": {}, ".swift": {}, ".toml": {}, ".ts": {}, ".tsv": {}, ".tsx": {},
	".txt": {}, ".uss": {}, ".uxml": {}, ".vb": {}, ".vue": {}, ".yaml": {},
	".yml": {}, ".zsh": {},
}

// previewHandler serves a bounded, read-only preview of a regular file belonging
// to a local session. It deliberately runs before peer forwarding: file access
// is never proxied to another gmuxd.
func previewHandler(w http.ResponseWriter, r *http.Request, sessionID string, sessions *store.Store) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "bad_request", "method not allowed")
		return
	}

	sess, ok := sessions.Get(sessionID)
	if !ok {
		writeError(w, http.StatusNotFound, "not_found", "session not found")
		return
	}
	if sess.Peer != "" {
		writeError(w, http.StatusNotImplemented, "remote_preview_unsupported", "file preview is not supported for remote sessions")
		return
	}

	requested := r.URL.Query().Get("path")
	if requested == "" {
		writeError(w, http.StatusBadRequest, "bad_request", "path is required")
		return
	}
	if strings.IndexByte(requested, 0) >= 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "path contains invalid characters")
		return
	}

	target, err := resolvePreviewPath(sess, requested)
	if err != nil {
		writePreviewError(w, err)
		return
	}

	before, err := os.Stat(target)
	if err != nil {
		writePreviewFileError(w, err)
		return
	}
	if !before.Mode().IsRegular() {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_file", "preview requires a regular file")
		return
	}
	if before.Size() > maxPreviewImageBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "file exceeds preview size limit")
		return
	}

	f, err := os.Open(target)
	if err != nil {
		writePreviewFileError(w, err)
		return
	}
	defer f.Close()

	afterOpen, err := f.Stat()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "file preview unavailable")
		return
	}
	if !afterOpen.Mode().IsRegular() || !os.SameFile(before, afterOpen) {
		writeError(w, http.StatusConflict, "file_changed", "file changed while opening preview")
		return
	}
	if afterOpen.Size() > maxPreviewImageBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "file exceeds preview size limit")
		return
	}

	data, err := io.ReadAll(io.LimitReader(f, maxPreviewImageBytes+1))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "internal", "file preview unavailable")
		return
	}
	if len(data) > maxPreviewImageBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "file exceeds preview size limit")
		return
	}

	afterRead, err := f.Stat()
	if err != nil || !afterRead.Mode().IsRegular() || !os.SameFile(afterOpen, afterRead) ||
		afterRead.Size() != afterOpen.Size() || int64(len(data)) != afterRead.Size() {
		writeError(w, http.StatusConflict, "file_changed", "file changed while reading preview")
		return
	}

	filename := safePreviewFilename(filepath.Base(filepath.Clean(requested)))
	contentType, sizeLimit, ok := previewContentType(filename, data)
	if !ok {
		writeError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "file type is not supported for preview")
		return
	}
	if int64(len(data)) > sizeLimit {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "file exceeds preview size limit")
		return
	}

	disposition := mime.FormatMediaType("inline", map[string]string{"filename": filename})
	if disposition == "" {
		disposition = "inline"
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", disposition)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func resolvePreviewPath(sess store.Session, requested string) (string, error) {
	workspaceRoot, workspaceOK := canonicalPreviewRoot(sess.WorkspaceRoot)
	cwdRoot, cwdOK := canonicalPreviewRoot(sess.Cwd)

	roots := make([]previewRoot, 0, 2)
	if workspaceOK {
		roots = append(roots, workspaceRoot)
	}
	if cwdOK && (!workspaceOK || cwdRoot.resolved != workspaceRoot.resolved) {
		roots = append(roots, cwdRoot)
	}
	if len(roots) == 0 {
		return "", &previewError{http.StatusForbidden, "preview_unavailable", "session has no valid preview root"}
	}

	pathValue, err := expandPreviewHome(requested)
	if err != nil {
		return "", &previewError{http.StatusBadRequest, "bad_request", "invalid path"}
	}
	if !filepath.IsAbs(pathValue) {
		if !cwdOK {
			return "", &previewError{http.StatusForbidden, "preview_unavailable", "session has no valid working directory"}
		}
		pathValue = filepath.Join(cwdRoot.resolved, pathValue)
	}
	targetAbsolute, err := filepath.Abs(filepath.Clean(pathValue))
	if err != nil {
		return "", &previewError{http.StatusBadRequest, "bad_request", "invalid path"}
	}

	targetResolved, err := filepath.EvalSymlinks(targetAbsolute)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// Check missing paths lexically so a nonexistent traversal target
			// outside every root is still rejected as an escape, not a 404.
			for _, root := range roots {
				if previewPathWithin(root.absolute, targetAbsolute) || previewPathWithin(root.resolved, targetAbsolute) {
					return "", &previewError{http.StatusNotFound, "not_found", "file not found"}
				}
			}
			return "", &previewError{http.StatusForbidden, "path_outside_workspace", "path is outside the session preview roots"}
		}
		return "", &previewError{http.StatusForbidden, "path_unavailable", "path cannot be resolved safely"}
	}
	targetResolved, err = filepath.Abs(filepath.Clean(targetResolved))
	if err != nil {
		return "", &previewError{http.StatusBadRequest, "bad_request", "invalid path"}
	}

	for _, root := range roots {
		if previewPathWithin(root.resolved, targetResolved) {
			return targetResolved, nil
		}
	}
	return "", &previewError{http.StatusForbidden, "path_outside_workspace", "path is outside the session preview roots"}
}

func canonicalPreviewRoot(pathValue string) (previewRoot, bool) {
	if strings.TrimSpace(pathValue) == "" {
		return previewRoot{}, false
	}
	expanded, err := expandPreviewHome(pathValue)
	if err != nil {
		return previewRoot{}, false
	}
	absolute, err := filepath.Abs(filepath.Clean(expanded))
	if err != nil {
		return previewRoot{}, false
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return previewRoot{}, false
	}
	resolved, err = filepath.Abs(filepath.Clean(resolved))
	if err != nil {
		return previewRoot{}, false
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return previewRoot{}, false
	}
	return previewRoot{absolute: absolute, resolved: resolved}, true
}

func expandPreviewHome(pathValue string) (string, error) {
	if pathValue != "~" && !strings.HasPrefix(pathValue, "~"+string(filepath.Separator)) {
		return pathValue, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	if pathValue == "~" {
		return home, nil
	}
	return filepath.Join(home, strings.TrimPrefix(pathValue, "~"+string(filepath.Separator))), nil
}

func previewPathWithin(root, target string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil || filepath.IsAbs(rel) {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func previewContentType(filename string, data []byte) (string, int64, bool) {
	detected := http.DetectContentType(data)
	mediaType, _, err := mime.ParseMediaType(detected)
	if err != nil {
		return "", 0, false
	}
	ext := strings.ToLower(filepath.Ext(filename))

	if expected, ok := previewImageTypes[ext]; ok && mediaType == expected {
		return expected, maxPreviewImageBytes, true
	}
	if mediaType != "text/plain" || bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(data) {
		return "", 0, false
	}
	if _, ok := previewTextExtensions[ext]; !ok {
		return "", 0, false
	}
	return "text/plain; charset=utf-8", maxPreviewTextBytes, true
}

func safePreviewFilename(filename string) string {
	filename = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == '/' || r == '\\' {
			return '_'
		}
		return r
	}, filename)
	filename = strings.TrimSpace(filename)
	if filename == "" || filename == "." {
		return "preview"
	}
	return filename
}

func writePreviewError(w http.ResponseWriter, err error) {
	var previewErr *previewError
	if errors.As(err, &previewErr) {
		writeError(w, previewErr.status, previewErr.code, previewErr.message)
		return
	}
	writeError(w, http.StatusInternalServerError, "internal", "file preview unavailable")
}

func writePreviewFileError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, os.ErrNotExist):
		writeError(w, http.StatusNotFound, "not_found", "file not found")
	case errors.Is(err, os.ErrPermission):
		writeError(w, http.StatusForbidden, "permission_denied", "file cannot be read")
	default:
		writeError(w, http.StatusInternalServerError, "internal", "file preview unavailable")
	}
}
