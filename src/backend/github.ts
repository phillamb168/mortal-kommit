import { z } from 'zod';
import { git, run } from './process.js';
import { githubRemoteMatches, parsePr } from './forge.js';
import type { RemoteReview } from '../core/types.js';

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const revision = z.object({ sha, ref: z.string().min(1) });
const PullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  head: revision,
  base: revision.extend({ repo: z.object({ full_name: z.string() }) }),
});
const Comment = z.object({
  id: z.number().int(),
  body: z.string().nullable(),
  user: z.object({ login: z.string() }).nullable().optional(),
  path: z.string().optional(),
  line: z.number().int().nullable().optional(),
  original_line: z.number().int().nullable().optional(),
  commit_id: z.string().nullable().optional(),
  original_commit_id: z.string().nullable().optional(),
  in_reply_to_id: z.number().optional(),
  state: z.string().optional(),
});

/** Only the trusted origin is fetched. PR-provided fork URLs and merge commits are never used. */
export async function resolvePullRequest(root: string, gitDir: string, url: string) {
  const parsed = parsePr(url);
  const origin = await git(root, 'remote', 'get-url', 'origin').catch(() => '');
  if (!githubRemoteMatches(origin, parsed.host, parsed.project))
    throw new Error(
      'PR project does not match this registered repository origin. Register a clone of the target repository.',
    );
  const project = parsed.project.split('/').map(encodeURIComponent).join('/');
  const path = `repos/${project}/pulls/${parsed.number}`;
  const request = async (endpoint: string): Promise<unknown> => {
    try {
      return JSON.parse(
        await run(
          'gh',
          [
            'api',
            '--hostname',
            parsed.host,
            '--method',
            'GET',
            '-H',
            'Accept: application/vnd.github+json',
            endpoint,
          ],
          {
            cwd: root,
            max: 4 * 1024 * 1024,
            env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_DEBUG: '' },
          },
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          'GitHub CLI (gh) is required. Install gh, then run gh auth login --hostname ' +
            parsed.host,
        );
      throw new Error(
        `GitHub read failed. Check gh auth status --hostname ${parsed.host}, repository access, and rate limits. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const info = PullRequest.parse(await request(path));
  if (
    info.number !== Number(parsed.number) ||
    info.base.repo.full_name.toLowerCase() !== parsed.project.toLowerCase()
  )
    throw new Error('GitHub returned a different target repository or PR.');
  await git(gitDir, 'check-ref-format', `refs/heads/${info.base.ref}`);
  // refs/pull/N/head exists in the target repository even for fork PRs.
  await git(
    gitDir,
    'fetch',
    '--no-tags',
    '--no-write-fetch-head',
    origin,
    `refs/pull/${parsed.number}/head:refs/mk/pr-head`,
    `refs/heads/${info.base.ref}:refs/mk/target`,
  );
  const head = await git(gitDir, 'rev-parse', 'refs/mk/pr-head');
  const target = await git(gitDir, 'rev-parse', 'refs/mk/target');
  if (head !== info.head.sha || target !== info.base.sha)
    throw new Error('PR head or target changed while fetching. Retry for a consistent snapshot.');
  // The PR change is a three-dot comparison, not all differences against today's target tip.
  const bases = (await git(gitDir, 'merge-base', '--all', target, head))
    .split('\n')
    .filter(Boolean);
  if (bases.length !== 1)
    throw new Error('PR has no unique merge-base. Resolve its history before reviewing.');
  const base = bases[0];
  const changed = new Set(
    (await git(gitDir, 'diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', base, head))
      .split('\0')
      .filter(Boolean),
  );
  const warnings: string[] = [];
  let discussion = '',
    omitted = 0;
  // Conversation comments, submitted reviews, and inline review comments are separate GitHub resources.
  const streams = [
    ['conversation', `repos/${project}/issues/${parsed.number}/comments`],
    ['review', `${path}/reviews`],
    ['inline', `${path}/comments`],
  ] as const;
  for (const [kind, endpoint] of streams) {
    for (let page = 1; page <= 10; page++) {
      const rows = z.array(Comment).parse(await request(`${endpoint}?per_page=100&page=${page}`));
      for (const row of rows) {
        if (!row.body || (row.path && !changed.has(row.path))) {
          omitted++;
          continue;
        }
        const text = JSON.stringify({
          kind,
          id: row.id,
          author: row.user?.login ?? null,
          body: row.body,
          file: row.path,
          line: row.line ?? row.original_line,
          commit: row.commit_id ?? row.original_commit_id,
          replyTo: row.in_reply_to_id,
          state: row.state,
          outdated: kind === 'inline' ? row.line == null || row.commit_id !== head : undefined,
        });
        if (Buffer.byteLength(discussion + text + '\n') > 64000) {
          omitted++;
          continue;
        }
        discussion += text + '\n';
      }
      if (rows.length < 100) break;
      if (page === 10)
        warnings.push(
          `GitHub ${kind} discussion pagination capped at 10 pages; additional entries omitted.`,
        );
    }
  }
  if (omitted)
    warnings.push(`${omitted} empty, unrelated, or over-budget GitHub discussion entries omitted.`);
  warnings.push(
    'GitHub REST discussion does not expose thread resolution status; outdated inline comments are labeled and are not current-code evidence.',
  );
  const again = PullRequest.parse(await request(path));
  if (
    again.head.sha !== head ||
    again.head.ref !== info.head.ref ||
    again.base.sha !== target ||
    again.base.ref !== info.base.ref ||
    again.base.repo.full_name !== info.base.repo.full_name
  )
    throw new Error('PR revisions changed during preparation. Retry.');
  let description = info.body ?? '';
  if (Buffer.byteLength(description) > 32000) {
    description = Buffer.from(description).subarray(0, 32000).toString('utf8');
    warnings.push('PR description truncated at 32,000 bytes.');
  }
  const pr: RemoteReview = {
    url: parsed.url,
    title: info.title,
    description,
    discussion,
    target: info.base.ref,
    start: target,
  };
  return { head, base, pr, warnings };
}
