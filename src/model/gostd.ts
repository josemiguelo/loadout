// Go standard library behaviours the port keeps, where JavaScript's differ:
// unicode.IsSpace (JS's \s and trim() take U+FEFF and leave U+0085),
// string order (Go sorts UTF-8 bytes, JS compares UTF-16 units: they part
// beyond the BMP), and path.Clean/Join/IsAbs (node's posix.normalize keeps
// trailing slashes and turns "" into "."). Messages, sort orders and paths
// must come out as the Go code made them.

/** isSpace is Go's unicode.IsSpace for one code point. */
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

/** trimSpace is Go's strings.TrimFunc(s, unicode.IsSpace). */
export function trimSpace(s: string): string {
  const cps = Array.from(s);
  let start = 0;
  let end = cps.length;
  while (start < end && isSpace(cps[start]!.codePointAt(0)!)) start++;
  while (end > start && isSpace(cps[end - 1]!.codePointAt(0)!)) end--;
  return cps.slice(start, end).join("");
}

/** isBlank says whether s is empty or only whitespace (unicode.IsSpace). */
export function isBlank(s: string): boolean {
  return trimSpace(s) === "";
}

/** hasSpace says whether s holds a whitespace code point (unicode.IsSpace). */
export function hasSpace(s: string): boolean {
  for (const c of s) if (isSpace(c.codePointAt(0)!)) return true;
  return false;
}

/** compareStrings orders as Go's < on strings: by UTF-8 bytes, i.e. by code point. */
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

/** sortStrings sorts xs in place as Go's slices.Sort does, and returns it. */
export function sortStrings(xs: string[]): string[] {
  return xs.sort(compareStrings);
}

/** sortedStrings is a sorted copy of xs (slices.Sorted). */
export function sortedStrings(xs: Iterable<string>): string[] {
  return sortStrings([...xs]);
}

/** isSortedStrings is Go's slices.IsSorted for strings. */
export function isSortedStrings(xs: readonly string[]): boolean {
  for (let i = 1; i < xs.length; i++) if (compareStrings(xs[i - 1]!, xs[i]!) > 0) return false;
  return true;
}

/** cleanPath is Go's path.Clean: the shortest equivalent `/` path; "" is ".". */
export function cleanPath(path: string): string {
  if (path === "") return ".";
  const rooted = path[0] === "/";
  const n = path.length;
  // buf[0..w) is the output so far, as Go's lazybuf.
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

/** joinPath is Go's path.Join: the non-empty elements, `/`-joined and cleaned; "" when all are empty. */
export function joinPath(...elems: string[]): string {
  const parts = elems.filter((e) => e !== "");
  return parts.length === 0 ? "" : cleanPath(parts.join("/"));
}

/** isAbsPath is Go's path.IsAbs. */
export function isAbsPath(path: string): boolean {
  return path.startsWith("/");
}

/** cut is Go's strings.Cut: before and after the first sep, and whether it was there. */
export function cut(s: string, sep: string): [before: string, after: string, found: boolean] {
  const i = s.indexOf(sep);
  if (i < 0) return [s, "", false];
  return [s.slice(0, i), s.slice(i + sep.length), true];
}

/** cutPrefix is Go's strings.CutPrefix. */
export function cutPrefix(s: string, prefix: string): [rest: string, found: boolean] {
  return s.startsWith(prefix) ? [s.slice(prefix.length), true] : [s, false];
}

/** trimPrefix is Go's strings.TrimPrefix. */
export function trimPrefix(s: string, prefix: string): string {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

/** trimRight is Go's strings.TrimRight with a set of characters. */
export function trimRight(s: string, cutset: string): string {
  let end = s.length;
  while (end > 0 && cutset.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
}

/** slicesEqual is Go's slices.Equal. */
export function slicesEqual<T>(a: readonly T[] | undefined, b: readonly T[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** errnoText is Go's syscall.Errno text for the errno codes file work meets. */
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

/** syscallOp is the Go os operation node's syscall name stands for (os.ReadDir opens first). */
const syscallOp: Record<string, string> = { scandir: "open", opendir: "open" };

/**
 * goPathError is node's file error e worded as Go's *os.PathError ("open
 * /x: permission denied"; a rename as *os.LinkError, "rename /a /b: …"), so
 * messages (state warnings, `error: ` lines) read as the Go binary's. op
 * and path fill in what node leaves out (a read's path). Anything that
 * isn't an errno error comes back as it is.
 */
export function goPathError(e: unknown, op?: string, path?: string): Error {
  const err = e as NodeJS.ErrnoException & { dest?: string };
  if (!(e instanceof Error) || typeof err.code !== "string") return e instanceof Error ? e : new Error(String(e));
  const text = errnoText[err.code] ?? err.message;
  const operation = op ?? (err.syscall !== undefined ? (syscallOp[err.syscall] ?? err.syscall) : "open");
  const file = path ?? err.path ?? "";
  const where = operation === "rename" && err.dest !== undefined ? `${file} ${err.dest}` : file;
  return Object.assign(new Error(`${operation} ${where}: ${text}`), { code: err.code });
}
