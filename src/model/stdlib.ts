// String, path and file-error rules loadout keeps where JavaScript's own
// differ: white space (JS's \s and trim() take U+FEFF and leave U+0085),
// string order (by UTF-8 bytes; JS compares UTF-16 units, and they part
// beyond the BMP), and path cleaning (node's posix.normalize keeps trailing
// slashes and turns "" into "."). Messages, sort orders and paths in the
// lock and state files depend on them, so they must not change.

/** isSpace says whether cp is white space: \t to \r, space, U+0085, U+00A0 and Unicode's other spaces, never U+FEFF. */
export function isSpace(cp: number): boolean {
  if (cp <= 0xff) {
    return cp === 0x20 || (cp >= 0x09 && cp <= 0x0d) || cp === 0x85 || cp === 0xa0;
  }
  return (
    cp === 0x1680 ||
    (cp >= 0x2000 && cp <= 0x200a) ||
    cp === 0x2028 ||
    cp === 0x2029 ||
    cp === 0x202f ||
    cp === 0x205f ||
    cp === 0x3000
  );
}

/** trimSpace is s without the white space (isSpace) at either end. */
export function trimSpace(s: string): string {
  const cps = Array.from(s);
  let start = 0;
  let end = cps.length;
  while (start < end && isSpace(cps[start]!.codePointAt(0)!)) start++;
  while (end > start && isSpace(cps[end - 1]!.codePointAt(0)!)) end--;
  return cps.slice(start, end).join("");
}

/** isBlank says whether s is empty or only white space (isSpace). */
export function isBlank(s: string): boolean {
  return trimSpace(s) === "";
}

/** hasSpace says whether s holds a white space code point (isSpace). */
export function hasSpace(s: string): boolean {
  for (const c of s) if (isSpace(c.codePointAt(0)!)) return true;
  return false;
}

/** compareStrings orders strings by UTF-8 bytes, i.e. by code point. */
export function compareStrings(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(j)!;
    if (x !== y) return x < y ? -1 : 1;
    i += x > 0xffff ? 2 : 1;
    j += y > 0xffff ? 2 : 1;
  }
  const restA = a.length - i;
  const restB = b.length - j;
  return restA === restB ? 0 : restA < restB ? -1 : 1;
}

/** sortStrings sorts xs in place by compareStrings, and returns it. */
export function sortStrings(xs: string[]): string[] {
  return xs.sort(compareStrings);
}

/** sortedStrings is a copy of xs sorted by compareStrings. */
export function sortedStrings(xs: Iterable<string>): string[] {
  return sortStrings([...xs]);
}

/** isSortedStrings says whether xs is in compareStrings order. */
export function isSortedStrings(xs: readonly string[]): boolean {
  for (let i = 1; i < xs.length; i++) if (compareStrings(xs[i - 1]!, xs[i]!) > 0) return false;
  return true;
}

/** cleanPath is the shortest equivalent `/` path: no `.`, no `..` it can resolve, no doubled or trailing slash; "" is ".". */
export function cleanPath(path: string): string {
  if (path === "") return ".";
  const rooted = path[0] === "/";
  const n = path.length;
  // buf[0..w) is the output so far.
  const buf: string[] = [];
  let w = 0;
  const append = (c: string) => {
    buf[w++] = c;
  };
  let r = 0;
  let dotdot = 0;
  if (rooted) {
    append("/");
    r = 1;
    dotdot = 1;
  }
  while (r < n) {
    if (path[r] === "/") {
      r++;
    } else if (path[r] === "." && (r + 1 === n || path[r + 1] === "/")) {
      r++;
    } else if (path[r] === "." && path[r + 1] === "." && (r + 2 === n || path[r + 2] === "/")) {
      r += 2;
      if (w > dotdot) {
        w--;
        while (w > dotdot && buf[w] !== "/") w--;
      } else if (!rooted) {
        if (w > 0) append("/");
        append(".");
        append(".");
        dotdot = w;
      }
    } else {
      if ((rooted && w !== 1) || (!rooted && w !== 0)) append("/");
      for (; r < n && path[r] !== "/"; r++) append(path[r]!);
    }
  }
  if (w === 0) return ".";
  return buf.slice(0, w).join("");
}

/** joinPath is the non-empty elements, `/`-joined and cleaned; "" when all are empty. */
export function joinPath(...elems: string[]): string {
  const parts = elems.filter((e) => e !== "");
  return parts.length === 0 ? "" : cleanPath(parts.join("/"));
}

/** isAbsPath says whether path starts with `/`. */
export function isAbsPath(path: string): boolean {
  return path.startsWith("/");
}

/** cut is s before and after the first sep, and whether it was there. */
export function cut(s: string, sep: string): [before: string, after: string, found: boolean] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, "", false];
  return [s.slice(0, i), s.slice(i + sep.length), true];
}

/** cutPrefix is s without prefix, and whether s had it. */
export function cutPrefix(s: string, prefix: string): [rest: string, found: boolean] {
  return s.startsWith(prefix) ? [s.slice(prefix.length), true] : [s, false];
}

/** trimPrefix is s without prefix, or s when it doesn't start with it. */
export function trimPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

/** trimRight is s without the trailing characters that are in cutset. */
export function trimRight(s: string, cutset: string): string {
  let end = s.length;
  while (end > 0 && cutset.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
}

/** slicesEqual says whether a and b hold the same elements in the same order. */
export function slicesEqual<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** errnoText is the text a file error gives for each errno code file work meets. */
const errnoText: Record<string, string> = {
  ENOENT: "no such file or directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EISDIR: "is a directory",
  ENOTDIR: "not a directory",
  EEXIST: "file exists",
  ENOTEMPTY: "directory not empty",
  ENOSPC: "no space left on device",
  EROFS: "read-only file system",
  ELOOP: "too many levels of symbolic links",
  ENAMETOOLONG: "file name too long",
  EXDEV: "invalid cross-device link",
  EBUSY: "device or resource busy",
  EMFILE: "too many open files",
  EIO: "input/output error",
};

/** syscallOp is the operation a file error names for node's syscall (reading a folder opens it first). */
const syscallOp: Record<string, string> = { scandir: "open", opendir: "open" };

/**
 * fileError is node's file error e worded as loadout words file errors:
 * "open /x: permission denied", a rename "rename /a /b: …". State warnings
 * and `error: ` lines carry it. op and path fill in what node leaves out (a
 * read's path). Anything that
 * isn't an errno error comes back as it is.
 */
export function fileError(e: unknown, op?: string, path?: string): Error {
  const err = e as NodeJS.ErrnoException & { dest?: string };
  if (!(e instanceof Error) || typeof err.code !== "string") return e instanceof Error ? e : new Error(String(e));
  const text = errnoText[err.code] ?? err.message;
  const operation = op ?? (err.syscall !== undefined ? (syscallOp[err.syscall] ?? err.syscall) : "open");
  const file = path ?? err.path ?? "";
  const where = operation === "rename" && err.dest !== undefined ? `${file} ${err.dest}` : file;
  return Object.assign(new Error(`${operation} ${where}: ${text}`), { code: err.code });
}
