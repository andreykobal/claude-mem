/**
 * Every spelling a stored file path may have for these lookup paths.
 *
 * #2691 — PreToolUse:Read and PostToolUse can disagree on the stored path form
 * (absolute vs project-root-relative vs cwd-relative), so callers send several
 * candidates. A Windows tool input is stored as written (`C:\proj\src\a.ts`)
 * while callers send forward-slashed forms, so each candidate also matches its
 * backslashed spelling; captured tool evidence keeps a leading `./` verbatim.
 * Shared by the local store and the server's by-file read.
 */
export function expandFilePathCandidates(filePaths: string | string[]): string[] {
  const paths = (Array.isArray(filePaths) ? filePaths : [filePaths])
    .filter(p => typeof p === 'string' && p.length > 0);
  // An absolute POSIX filename also determines how its relative candidates read.
  const literalBackslashes = paths.some(p => p.startsWith('/') && !p.startsWith('//') && p.includes('\\'));
  return Array.from(
    new Set(paths
      .flatMap(p => {
        const forward = (literalBackslashes ? p : p.replaceAll('\\', '/')).replace(/^(\.\/)+/, '');
        const forms = [p, forward];
        // Read resolves away ./, but captured tool evidence keeps it verbatim.
        // Only relative paths have this equivalent current-directory spelling.
        if (forward && !/^(\/|[A-Za-z]:|~\/)/.test(forward)) forms.push(`./${forward}`);
        return literalBackslashes ? forms : forms.flatMap(form => [form, form.replaceAll('/', '\\')]);
      })
      .filter(Boolean))
  );
}
