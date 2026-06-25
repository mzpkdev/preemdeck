/**
 * pyname.ts — a faithful reproduction of the reference `pathlib.PurePosixPath(value).name`,
 * used by inject_mode and show_mode for the "bare name" anti-traversal guard.
 *
 * Both scripts reject a value when `name(value) !== value`, so a config/CLI value
 * carrying a path separator or a dot-segment can't escape the skills dir. Matching
 * the reference `.name` exactly keeps the guard byte-identical across the rewrite.
 *
 * Reference semantics (POSIX flavour), verified against the reference:
 *   - the final path component after splitting on "/";
 *   - "" for the empty string, a lone ".", and any pure-root path ("/", "//");
 *   - ".." is NOT special: PurePosixPath("..").name == "..", "a/..".name == "..";
 *   - trailing slashes are ignored ("a/" -> "a");
 *   - "..." / "foo..bar" / ".hidden" keep their literal value.
 */

/** The reference `PurePosixPath(value).name`. */
export const pyName = (value: string): string => {
    let s = value
    // pathlib ignores trailing separators for .name ("a/" -> "a", "//" -> root).
    while (s.length > 1 && s.endsWith("/")) s = s.slice(0, -1)
    const idx = s.lastIndexOf("/")
    const last = idx === -1 ? s : s.slice(idx + 1)
    // The empty path and a lone "." have no name; everything else (incl. "..") does.
    if (last === "" || last === ".") return ""
    return last
}
