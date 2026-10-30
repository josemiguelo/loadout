package cli

import "github.com/josemiguelo/loadout/internal/app"

// home shows the home screen until the user quits. Every action runs inside
// it (a child loadout in the screen's run panel), so this only starts it and
// prints what it ended with, once the normal screen is back: after a
// self-upgrade (or a sync that upgraded) that is the run's output and how to
// go on, since the binary on disk is then a different version.
func home(a *app.AppContext) error {
	screen, err := app.NewScreen(a)
	if err != nil {
		return err
	}
	ended, err := screen.Run()
	if err != nil {
		return err
	}
	if ended.Message != "" {
		echo(ended.Message)
	}
	if ended.Code != 0 {
		return exitWith(ended.Code)
	}
	return nil
}
