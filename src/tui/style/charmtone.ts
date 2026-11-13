// The Charmtone colours the screen's themes use (charmbracelet/x/exp/charmtone).

import type { Color } from "./lipgloss.ts";

const hex = (h: string): Color => ({
  r: parseInt(h.slice(1, 3), 16),
  g: parseInt(h.slice(3, 5), 16),
  b: parseInt(h.slice(5, 7), 16),
});

export const Tang = hex("#FF985A");
export const Sriracha = hex("#EB4268");
export const Coral = hex("#FF577D");
export const Dolly = hex("#FF60FF");
export const Urchin = hex("#C337E0");
export const Charple = hex("#6B50FF");
export const Oceania = hex("#2B55B3");
export const Malibu = hex("#00A4FF");
export const Guac = hex("#12C78F");
export const Julep = hex("#00FFB2");
export const Bok = hex("#68FFD6");
export const Mustard = hex("#F5EF34");
export const Citron = hex("#E8FF27");
export const Butter = hex("#FFFAF1");

// Neutrals.
export const Pepper = hex("#201F26");
export const BBQ = hex("#2D2C36");
export const Char = hex("#3A3943");
export const Iron = hex("#4D4C57");
export const Oyster = hex("#605F6B");
export const Squid = hex("#858392");
export const Smoke = hex("#BFBCC8");
export const Steep = hex("#D6D3DC");
export const Sash = hex("#ECEBF0");
export const Salt = hex("#F7F6FB");

// Diffs.
export const Gator = hex("#18463D");
export const Pom = hex("#AB2454");
