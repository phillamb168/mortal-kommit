import { mkdir, writeFile, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, join, resolve, isAbsolute } from 'node:path';
import { git, run } from './process.js';
import { parseMr, gitlabRemoteMatches, validateSelection, type ReviewSelection } from './forge.js';
import { resolvePullRequest } from './github.js';
export {
  parseMr,
  parsePr,
  remoteMatches,
  gitlabRemoteMatches,
  githubRemoteMatches,
} from './forge.js';
import type { Scope } from '../core/types.js';

export function safePath(root: string, path: string) {
  if (
    !path ||
    path.includes('\0') ||
    isAbsolute(path) ||
    path.split(/[\\/]/).some((p) => p === '..' || p === '.git')
  )
    throw new Error('Path outside snapshot');
  const result = resolve(root, path);
  if (!result.startsWith(resolve(root) + '/')) throw new Error('Path outside snapshot');
  return result;
}
export function excluded(path: string): boolean {
  return (
    /(^|\/)(\.git|node_modules|vendor|dist|build|coverage|\.next|\.cache|__pycache__)(\/|$)/i.test(
      path,
    ) ||
    /(^|\/)(\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(rsa|ed25519)|\.npmrc|\.netrc|auth\.json)$/i.test(
      path,
    ) ||
    /\.(pem|key|p12|pfx|keystore|lock|min\.js|map)$/i.test(path) ||
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(path)
  );
}
export function containsSecret(text: string) {
  text = text.replace(/\\(["'])/g, '$1');
  return /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bgh[pousr]_[A-Za-z0-9]{25,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}|\bnsec1[023456789acdefghjklmnpqrstuvwxyz]{40,}|(?:password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["'][A-Za-z0-9/+_-]{16,}["']/i.test(
    text,
  );
}
export async function resolveScope(
  repo: string,
  storage: string,
  options: ReviewSelection = {},
): Promise<{ scope: Scope; gitDir: string }> {
  validateSelection(options);
  repo = await realpath(repo);
  const root = await git(repo, 'rev-parse', '--show-toplevel');
  const branch = await git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(
    () => '(detached)',
  );
  const headLocal = await git(root, 'rev-parse', '--verify', 'HEAD^{commit}');
  const dirty = !!(await git(root, 'status', '--porcelain=v1'));
  const gitDir = join(storage, 'objects.git');
  await mkdir(storage, { recursive: true });
  await git(storage, 'init', '--bare', gitDir);
  if (!options.mr && !options.pr)
    await git(
      gitDir,
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      root,
      `${headLocal}:refs/mk/head`,
    );
  let head = headLocal,
    base = '',
    mode: Scope['mode'] = 'unpublished',
    mr: Scope['mr'],
    pr: Scope['pr'];
  const warnings = dirty
    ? ['Uncommitted and untracked changes are excluded; the checkout is preserved.']
    : [];
  if (options.pr) {
    const selected = await resolvePullRequest(root, gitDir, options.pr);
    head = selected.head;
    base = selected.base;
    pr = selected.pr;
    mode = 'pr';
    warnings.push(...selected.warnings);
  } else if (options.mr) {
    const parsed = parseMr(options.mr),
      path = `projects/${encodeURIComponent(parsed.project)}/merge_requests/${parsed.iid}`;
    const request = async (suffix = '') =>
      JSON.parse(
        await run('glab', ['api', '--hostname', parsed.host, '--method', 'GET', path + suffix], {
          cwd: root,
        }),
      );
    const origin = await git(root, 'remote', 'get-url', 'origin').catch(() => '');
    if (!(await gitlabRemoteMatches(origin, parsed.host, parsed.project)))
      throw new Error(
        'MR project does not match this registered repository origin. Register the matching repository.',
      );
    const info = await request();
    if (!info.diff_refs?.base_sha || !info.diff_refs?.head_sha)
      throw new Error(
        'GitLab has not prepared immutable diff_refs yet. Retry when the MR diff is ready.',
      );
    head = info.diff_refs.head_sha;
    base = info.diff_refs.base_sha;
    mode = 'mr';
    const remote = origin;
    await git(
      gitDir,
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      remote,
      `refs/merge-requests/${parsed.iid}/head:refs/mk/mr-head`,
      `refs/heads/${info.target_branch}:refs/mk/target`,
    );
    if ((await git(gitDir, 'rev-parse', 'refs/mk/mr-head')) !== head)
      throw new Error('MR head changed while fetching. Retry for a consistent snapshot.');
    await git(gitDir, 'cat-file', '-e', `${base}^{commit}`);
    const changed = (
      await git(gitDir, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, head)
    ).split('\0');
    let discussion = '';
    let omittedNotes = 0;
    for (let page = 1; page <= 20; page++) {
      const rows = JSON.parse(
        await run(
          'glab',
          [
            'api',
            '--hostname',
            parsed.host,
            '--method',
            'GET',
            `${path}/discussions?per_page=100&page=${page}`,
          ],
          { cwd: root, max: 4 * 1024 * 1024 },
        ),
      );
      if (!Array.isArray(rows)) throw new Error('Unexpected GitLab discussions response');
      for (const thread of rows)
        for (const note of thread.notes ?? []) {
          const file = note.position?.new_path ?? note.position?.old_path;
          if (note.system || (file && !changed.includes(file))) {
            omittedNotes++;
            continue;
          }
          const text = JSON.stringify({
            id: note.id,
            resolved: note.resolved ?? null,
            file,
            line: note.position?.new_line ?? note.position?.old_line,
            body: note.body,
          });
          if (Buffer.byteLength(discussion + text) > 64000) {
            omittedNotes++;
            continue;
          }
          discussion += text + '\n';
        }
      if (rows.length < 100) break;
      if (page === 20) warnings.push('Discussion pagination capped at 20 pages.');
    }
    if (omittedNotes)
      warnings.push(`${omittedNotes} system, unrelated, or over-budget discussion notes omitted.`);
    const again = await request();
    if (again.diff_refs?.head_sha !== head || again.diff_refs?.base_sha !== base)
      throw new Error('MR revisions changed during preparation. Retry.');
    mr = {
      url: options.mr,
      title: info.title,
      description: info.description ?? '',
      discussion: discussion.slice(0, 64000),
      target: info.target_branch,
      start: info.diff_refs.start_sha,
    };
    for (const field of ['description', 'discussion'] as const)
      if (containsSecret(mr[field])) {
        mr[field] = '[Omitted: secret-like content detected]';
        warnings.push(`MR ${field} omitted because it contains secret-like content.`);
      }
  } else if (options.base) {
    if (options.base.startsWith('-')) throw new Error('Invalid base ref');
    const selected = await git(root, 'rev-parse', '--verify', `${options.base}^{commit}`);
    await git(
      gitDir,
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      root,
      `${selected}:refs/mk/selected-base`,
    );
    base = await git(gitDir, 'merge-base', selected, head);
    mode = 'base';
    if (base !== selected)
      warnings.push(`Explicit base comparison uses merge-base ${base} with ${options.base}.`);
  } else {
    if (branch === '(detached)')
      throw new Error('Detached HEAD has no reliable upstream. Supply --base <ref>.');
    const remote = await git(root, 'config', '--get', `branch.${branch}.remote`).catch(() => '');
    const merge = await git(root, 'config', '--get', `branch.${branch}.merge`).catch(() => '');
    if (!remote || !merge)
      throw new Error(
        'No upstream configured. Supply --base <ref>; the entire branch is not assumed unpublished.',
      );
    const url = remote === '.' ? root : await git(root, 'remote', 'get-url', remote);
    try {
      await git(
        gitDir,
        'fetch',
        '--no-tags',
        '--no-write-fetch-head',
        url,
        `${merge}:refs/mk/upstream`,
      );
    } catch {
      throw new Error(
        'Cannot refresh upstream information. Supply an explicit --base after checking the intended comparison.',
      );
    }
    base = await git(gitDir, 'rev-parse', 'refs/mk/upstream');
    const [behind, ahead] = (
      await git(gitDir, 'rev-list', '--left-right', '--count', `${base}...${head}`)
    )
      .split(/\s+/)
      .map(Number);
    if (behind && ahead)
      throw new Error(
        `Branch diverged (${ahead} ahead, ${behind} behind). Supply --base <ref> explicitly.`,
      );
    if (behind && !ahead)
      throw new Error('No unpublished commits: this branch is behind its upstream.');
  }
  if (pr)
    for (const field of ['title', 'description', 'discussion'] as const)
      if (containsSecret(pr[field])) {
        pr[field] = '[Omitted: secret-like content detected]';
        warnings.push(`PR ${field} omitted because it contains secret-like content.`);
      }
  const shas = (await git(gitDir, 'rev-list', '--reverse', `${base}..${head}`))
    .split('\n')
    .filter(Boolean);
  if (!shas.length) throw new Error('Empty review range: no selected commits.');
  const commits = [];
  for (const sha of shas)
    commits.push({ sha, subject: await git(gitDir, 'show', '-s', '--format=%s', sha) });
  const changedFiles = (
    await git(gitDir, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, head)
  )
    .split('\0')
    .filter(Boolean);
  return {
    gitDir,
    scope: {
      repo: root,
      branch,
      mode,
      base,
      head,
      comparison: `${base}..${head}`,
      commits,
      dirty,
      warnings,
      changedFiles,
      mr,
      pr,
    },
  };
}
export async function snapshots(gitDir: string, scope: Scope, directory: string) {
  const omissions: string[] = [];
  let total = 0;
  for (const revision of ['base', 'head'] as const) {
    const root = join(directory, revision);
    await mkdir(root, { recursive: true });
    const tree = await git(gitDir, 'ls-tree', '-r', '-l', '-z', scope[revision]);
    let files = 0,
      revisionBytes = 0;
    const changed = new Set(scope.changedFiles);
    const entries = tree
      .split('\0')
      .filter(Boolean)
      .sort(
        (a, b) =>
          Number(changed.has(b.slice(b.indexOf('\t') + 1))) -
          Number(changed.has(a.slice(a.indexOf('\t') + 1))),
      );
    for (const entry of entries) {
      const m = entry.match(/^(\d+) blob ([a-f0-9]+)\s+(\d+)\t([\s\S]+)$/);
      if (!m) {
        omissions.push(
          `${revision}:${entry.slice(entry.indexOf('\t') + 1)} — submodule or unsupported tree entry`,
        );
        continue;
      }
      const [, mode, oid, size, path] = m;
      if (
        excluded(path) ||
        mode === '120000' ||
        Number(size) > 256 * 1024 ||
        revisionBytes + Number(size) > 12 * 1024 * 1024 ||
        total + Number(size) > 24 * 1024 * 1024 ||
        files >= 12000
      ) {
        omissions.push(`${revision}:${path} — excluded path, symlink, or size limit`);
        continue;
      }
      const content = await run('git', ['--git-dir', gitDir, 'cat-file', 'blob', oid], {
        max: 300 * 1024,
      });
      if (content.includes('\0') || containsSecret(content)) {
        omissions.push(`${revision}:${path} — binary or secret-bearing content`);
        continue;
      }
      const dest = safePath(root, path);
      await mkdir(resolve(dest, '..'), { recursive: true });
      await writeFile(dest, content, { mode: 0o444 });
      total += Buffer.byteLength(content);
      revisionBytes += Buffer.byteLength(content);
      files++;
    }
  }
  return omissions;
}
export async function listFiles(root: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(join(root, prefix), { withFileTypes: true })) {
    const p = join(prefix, e.name);
    if (e.isDirectory()) out.push(...(await listFiles(root, p)));
    else if (e.isFile()) out.push(p);
  }
  return out.sort();
}
export async function boundedContext(directory: string, scope: Scope) {
  const files = await listFiles(join(directory, 'head'));
  const selected = new Set(scope.changedFiles.filter((f) => files.includes(f)));
  for (const f of files)
    if (
      /(^|\/)(AGENTS\.md|README(?:\.md)?|CONTRIBUTING\.md|package\.json|tsconfig\.json|Cargo\.toml|pyproject\.toml|go\.mod)$/.test(
        f,
      )
    )
      selected.add(f);
  const needles = scope.changedFiles
    .flatMap((f) => [basename(f).replace(/\.[^.]+$/, ''), ...f.split('/').slice(-2, -1)])
    .filter((s) => s.length > 3)
    .slice(0, 30);
  for (const f of files) {
    if (selected.size >= 80) break;
    if (selected.has(f)) continue;
    const text = await readFile(safePath(join(directory, 'head'), f), 'utf8');
    if (needles.some((n) => text.includes(n))) selected.add(f);
  }
  let packet = '',
    reads = 0,
    bytes = 0;
  const omitted: string[] = [];
  for (const f of selected) {
    const text = await readFile(safePath(join(directory, 'head'), f), 'utf8');
    if (reads >= 80 || bytes + Buffer.byteLength(text) > 256 * 1024) {
      omitted.push(f);
      continue;
    }
    reads++;
    bytes += Buffer.byteLength(text);
    packet += `\n--- head:${f} ---\n${text
      .split('\n')
      .map((l, i) => `${i + 1}: ${l}`)
      .join('\n')}\n`;
  }
  return { packet, omitted, reads, bytes };
}
