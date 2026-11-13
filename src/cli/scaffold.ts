// The scaffolds `init` writes (internal/cli/scaffold/<kind>/…), their
// text embedded in the binary as the SDKs are (bun inlines a text import,
// `bun build --compile` too). One entry per file: scaffold.test.ts checks
// the table against the folder, so a file added there must be added here.
// TypeScript types some of these imports as the modules themselves (a .ts
// file, a .json), others not at all; each is the file's text.

// @ts-ignore a text import's default is the file's text
import t0 from "../../internal/cli/scaffold/child/.gitignore" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t1 from "../../internal/cli/scaffold/child/loadout.ts" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t2 from "../../internal/cli/scaffold/child/machines/state/.gitkeep" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t3 from "../../internal/cli/scaffold/child/machines/{{.Hostname}}.loadout.ts" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t4 from "../../internal/cli/scaffold/child/maintenance/.gitkeep" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t5 from "../../internal/cli/scaffold/child/package.json" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t6 from "../../internal/cli/scaffold/child/programs/.gitkeep" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t7 from "../../internal/cli/scaffold/child/tsconfig.json" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t8 from "../../internal/cli/scaffold/child-configs/.chezmoiroot" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t9 from "../../internal/cli/scaffold/child-configs/.gitignore" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t10 from "../../internal/cli/scaffold/child-configs/loadout.ts" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t11 from "../../internal/cli/scaffold/child-configs/loadouts/.gitkeep" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t12 from "../../internal/cli/scaffold/child-configs/machines/state/.gitkeep" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t13 from "../../internal/cli/scaffold/child-configs/machines/{{.Hostname}}.loadout.ts" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t14 from "../../internal/cli/scaffold/child-configs/package.json" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t15 from "../../internal/cli/scaffold/child-configs/tsconfig.json" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t16 from "../../internal/cli/scaffold/init/.gitignore" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t17 from "../../internal/cli/scaffold/init/loadout.ts" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t18 from "../../internal/cli/scaffold/init/machines/data.ts" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t19 from "../../internal/cli/scaffold/init/machines/machines.loadout.ts" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t20 from "../../internal/cli/scaffold/init/machines/state/.gitkeep" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t21 from "../../internal/cli/scaffold/init/maintenance/.gitkeep" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t22 from "../../internal/cli/scaffold/init/package.json" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t23 from "../../internal/cli/scaffold/init/programs/cli.loadout.ts" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t24 from "../../internal/cli/scaffold/init/tsconfig.json" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t25 from "../../internal/cli/scaffold/init-configs/.chezmoiroot" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t26 from "../../internal/cli/scaffold/init-configs/.gitignore" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t27 from "../../internal/cli/scaffold/init-configs/loadout.ts" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t28 from "../../internal/cli/scaffold/init-configs/loadouts/private_dot_config/.ripgrep.loadout.ts" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t29 from "../../internal/cli/scaffold/init-configs/machines/data.ts" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t30 from "../../internal/cli/scaffold/init-configs/machines/machines.loadout.ts" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t31 from "../../internal/cli/scaffold/init-configs/machines/state/.gitkeep" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t32 from "../../internal/cli/scaffold/init-configs/package.json" with { type: "text" };
// @ts-ignore a text import's default is the file's text
import t33 from "../../internal/cli/scaffold/init-configs/tsconfig.json" with { type: "text" };

/** scaffoldTexts is every scaffold's files by kind: path in the scaffold (a template) to its text. */
export const scaffoldTexts: Record<string, Record<string, string>> = {
  "child": {
    ".gitignore": t0 as unknown as string,
    "loadout.ts": t1 as unknown as string,
    "machines/state/.gitkeep": t2 as unknown as string,
    "machines/{{.Hostname}}.loadout.ts": t3 as unknown as string,
    "maintenance/.gitkeep": t4 as unknown as string,
    "package.json": t5 as unknown as string,
    "programs/.gitkeep": t6 as unknown as string,
    "tsconfig.json": t7 as unknown as string,
  },
  "child-configs": {
    ".chezmoiroot": t8 as unknown as string,
    ".gitignore": t9 as unknown as string,
    "loadout.ts": t10 as unknown as string,
    "loadouts/.gitkeep": t11 as unknown as string,
    "machines/state/.gitkeep": t12 as unknown as string,
    "machines/{{.Hostname}}.loadout.ts": t13 as unknown as string,
    "package.json": t14 as unknown as string,
    "tsconfig.json": t15 as unknown as string,
  },
  "init": {
    ".gitignore": t16 as unknown as string,
    "loadout.ts": t17 as unknown as string,
    "machines/data.ts": t18 as unknown as string,
    "machines/machines.loadout.ts": t19 as unknown as string,
    "machines/state/.gitkeep": t20 as unknown as string,
    "maintenance/.gitkeep": t21 as unknown as string,
    "package.json": t22 as unknown as string,
    "programs/cli.loadout.ts": t23 as unknown as string,
    "tsconfig.json": t24 as unknown as string,
  },
  "init-configs": {
    ".chezmoiroot": t25 as unknown as string,
    ".gitignore": t26 as unknown as string,
    "loadout.ts": t27 as unknown as string,
    "loadouts/private_dot_config/.ripgrep.loadout.ts": t28 as unknown as string,
    "machines/data.ts": t29 as unknown as string,
    "machines/machines.loadout.ts": t30 as unknown as string,
    "machines/state/.gitkeep": t31 as unknown as string,
    "package.json": t32 as unknown as string,
    "tsconfig.json": t33 as unknown as string,
  },
};
