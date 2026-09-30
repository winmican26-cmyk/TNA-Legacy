/**
 * Vendor resource canonicalization (Vendor Authority Adapter v0.1 remediation).
 *
 * The accepted authority-envelope contract (`validFile` / `matchesResource` in
 * `packages/authority-envelope`) evaluates resources in a canonical absolute POSIX namespace: a
 * resource must start with `/`, contain no `\`, `%` or `*`, and every path segment must be a real
 * name (never empty, `.` or `..`). That is accepted, frozen, fail-closed behavior and is deliberately
 * NOT changed here.
 *
 * The defect this module repairs is on the adapter side of the boundary. A vendor runtime reports
 * paths in its own native form — a Windows drive path (`C:\work\file.txt`), a POSIX path, or a path
 * relative to the session's working directory (`output/file.txt`). The adapter was forwarding that
 * raw string straight into the authorization request, so a genuine descendant of the declared scope
 * was refused by the policy engine with "Undeclared resource or operation" — not because the declared
 * pattern failed to match, but because the request never carried a canonical resource at all.
 *
 * The translation below is strictly narrowing:
 *   - a path already canonical is returned unchanged, so accepted semantics are untouched;
 *   - a native path inside the session working directory is expressed relative to the canonical
 *     workspace root, which is the only root a `/workspace/**` declaration covers;
 *   - anything else is expressed as a canonical path outside `/workspace`, which no `/workspace/**`
 *     declaration can match, so it is refused by the accepted policy engine unchanged;
 *   - `.`/`..` segments are collapsed *before* the containment test, so no traversal can ever be
 *     mapped into the workspace root.
 *
 * It never widens a declaration: a resource that was not a descendant of the declared scope before
 * this function is not one after it.
 */

/** The canonical root a `/workspace/**` file declaration covers. */
export const CANONICAL_WORKSPACE_ROOT = '/workspace';

/** Prefix used for anything outside the session working directory. It is deliberately not a
 * descendant of `CANONICAL_WORKSPACE_ROOT`, so an out-of-scope path stays out of scope. */
const EXTERNAL_ROOT = '/external';

function toPosixSeparators(value: string): string { return value.replace(/\\/g, '/'); }

/** A Windows drive-absolute path such as `C:/work/file.txt` or `c:/work/file.txt`. */
function hasDrivePrefix(path: string): boolean { return /^[A-Za-z]:\//.test(path); }

/**
 * Collapses `.` and `..` segments in a POSIX-style path. A `..` that would escape the head of the
 * path is dropped rather than allowed to climb above it, so the result is always a normalized path
 * relative to the same head. Traversal is therefore resolved away, never preserved.
 */
function collapseSegments(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { out.pop(); continue; }
    out.push(segment);
  }
  // The leading empty segment is dropped above, so the leading `/` must be restored explicitly —
  // otherwise an absolute path silently becomes relative and every containment test downstream fails.
  return absolute ? `/${out.join('/')}` : out.join('/');
}

/** True when `child` is the root itself or a descendant of it. */
function isWithin(root: string, child: string): boolean {
  if (child === root) return true;
  return child.startsWith(root + '/');
}

/**
 * Maps a path that is inside the session working directory onto the canonical workspace root, and
 * anything outside it onto a canonical path that is deliberately not under that root.
 */
function relativize(absolute: string, root: string, workspaceRoot: string): string {
  if (isWithin(root, absolute)) {
    const relative = absolute.slice(root.length).replace(/^\/+/, '');
    return relative === '' ? workspaceRoot : `${workspaceRoot}/${relative}`;
  }
  return `${EXTERNAL_ROOT}/${absolute}`;
}

/**
 * Canonicalizes a vendor-reported resource into the accepted absolute POSIX namespace.
 *
 * @param rawPath the path exactly as the vendor reported it
 * @param cwd the vendor session's working directory, in any native form
 * @param workspaceRoot canonical root the declared file scopes are written against
 */
export function canonicalVendorResource(rawPath: string, cwd: string, workspaceRoot: string = CANONICAL_WORKSPACE_ROOT): string {
  const raw = toPosixSeparators(rawPath.trim());
  if (raw === '') return workspaceRoot;

  const root = toPosixSeparators(cwd.trim()).replace(/\/+$/, '');

  // 1. Vendor-native form: a Windows drive path, or a path relative to the session cwd. These are the
  //    cases that produced the defect — a raw native path is not a canonical resource, so the accepted
  //    policy engine refused a genuine descendant of the declared scope. Resolve against the cwd and
  //    collapse `..` *before* the containment test, so no traversal can be mapped into the root.
  if (!raw.startsWith('/') || hasDrivePrefix(raw)) {
    const absolute = hasDrivePrefix(raw) ? raw : `${root}/${raw}`;
    return relativize(collapseSegments(absolute), root, workspaceRoot);
  }

  // 2. Already a POSIX absolute path. If it sits inside the session working directory it is the same
  //    descendant defect in POSIX form, so it is mapped onto the canonical workspace root. Collapsing
  //    `..` first means a traversal that would escape the cwd cannot be mapped into the root.
  if (isWithin(root, raw)) {
    const collapsed = collapseSegments(raw);
    if (isWithin(root, collapsed)) return relativize(collapsed, root, workspaceRoot);
    return `${EXTERNAL_ROOT}/${collapsed}`;
  }

  // 3. Otherwise it is already in the accepted namespace — under the workspace root, or simply some
  //    other absolute path. Hand it to the frozen `validFile`/`matchesResource` untouched, including
  //    traversal forms, which the frozen matcher refuses on its own terms. Nothing is mapped here, so
  //    no traversal can gain scope by being passed through.
  return raw;
}
