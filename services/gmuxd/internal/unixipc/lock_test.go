package unixipc

import "testing"

func TestAcquireDaemonLockIsExclusive(t *testing.T) {
	stateDir := t.TempDir()
	first, err := AcquireDaemonLock(stateDir)
	if err != nil {
		t.Fatal(err)
	}

	if second, err := AcquireDaemonLock(stateDir); err == nil {
		second.Close()
		first.Close()
		t.Fatal("second daemon lock unexpectedly succeeded")
	}

	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	third, err := AcquireDaemonLock(stateDir)
	if err != nil {
		t.Fatalf("lock was not released on close: %v", err)
	}
	third.Close()
}
