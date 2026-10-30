package model

// Refusal is anything loadout itself refuses to do, reported to the user as
// a clean `error: <message>` one-liner, never a stack trace (contract 9).
// main reports any error that is one; a new failure mode implements it
// rather than relying on someone remembering to add a case.
type Refusal interface {
	error
	Refusal()
}

// ManifestException is a manifest or lock loadout can't use.
type ManifestException struct{ Message string }

func (e *ManifestException) Error() string { return e.Message }

// Refusal marks it a refusal.
func (*ManifestException) Refusal() {}

// NewManifestException is a ManifestException saying message.
func NewManifestException(message string) *ManifestException {
	return &ManifestException{Message: message}
}

// ToolTooOldException says the lock needs a newer loadout: at least
// Required. `sync` upgrades on it.
type ToolTooOldException struct {
	Message  string
	Required string
}

func (e *ToolTooOldException) Error() string { return e.Message }

// Refusal marks it a refusal.
func (*ToolTooOldException) Refusal() {}
