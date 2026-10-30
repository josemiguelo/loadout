package platform

import (
	"testing"
	"time"
)

func TestTimestampsReadAsKotlinsInstantWritesThem(t *testing.T) {
	at := func(nanos int) string { return IsoOf(time.Date(2026, 8, 14, 12, 0, 0, nanos, time.UTC)) }
	for want, got := range map[string]string{
		"2026-08-14T12:00:00Z":           at(0),
		"2026-08-14T12:00:00.650Z":       at(650_000_000),
		"2026-08-14T12:00:00.651749Z":    at(651_749_000),
		"2026-08-14T12:00:00.651749402Z": at(651_749_402),
	} {
		if got != want {
			t.Errorf("%s, want %s", got, want)
		}
	}
}

func TestAnInterruptIsTakenOnce(t *testing.T) {
	TakeInterrupt()
	interrupts <- nil
	if !TakeInterrupt() || TakeInterrupt() {
		t.Error("taken once")
	}
}
