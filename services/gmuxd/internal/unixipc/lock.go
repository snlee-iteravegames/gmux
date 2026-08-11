package unixipc

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

// AcquireDaemonLock obtains a process-wide singleton lock before gmuxd starts
// any discovery or cleanup work. The file remains on disk between runs; the
// kernel releases the advisory lock when the returned file is closed.
func AcquireDaemonLock(stateDir string) (*os.File, error) {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return nil, fmt.Errorf("creating state directory %s: %w", stateDir, err)
	}
	path := filepath.Join(stateDir, "gmuxd.lock")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("opening daemon lock %s: %w", path, err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, fmt.Errorf("another gmuxd owns %s: %w", path, err)
	}
	return f, nil
}
