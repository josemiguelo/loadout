// Package engine is what loadout does with a manifest: observe, plan,
// install, upgrade, run scripts and configs.
package engine

// ResolutionException is a plan that could not be built; nothing was executed.
type ResolutionException struct{ Message string }

func (e *ResolutionException) Error() string { return e.Message }

// Refusal marks it a refusal.
func (*ResolutionException) Refusal() {}

// UpgradeException is a mechanism that can't be upgraded, and why —
// refusals are explicit, never silent.
type UpgradeException struct{ Message string }

func (e *UpgradeException) Error() string { return e.Message }

// Refusal marks it a refusal.
func (*UpgradeException) Refusal() {}

// ConfigException is a refusal about configs: chezmoi couldn't answer, a
// unit doesn't exist, or files were edited in place.
type ConfigException struct{ Message string }

func (e *ConfigException) Error() string { return e.Message }

// Refusal marks it a refusal.
func (*ConfigException) Refusal() {}
