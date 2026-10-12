import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/backend/process.js';
import { parsePr, githubRemoteMatches, validateSelection } from '../src/backend/forge.js';
import { resolveScope, snapshots } from '../src/backend/repository.js';
import { capability, type Runtime } from '../src/backend/capabilities.js';
import { parseReviewCommand, ReviewRequest } from '../src/backend/coordinator.js';
import { newMatch } from '../src/core/battle.js';
import { markdown } from '../src/backend/export.js';

const url = 'https://github.example.test/team/api/pull/18';
test('GitHub URLs and remote identities fail closed and accept Enterprise and forks via the target', () => {
  assert.deepEqual(parsePr(url + '#discussion_r123'), {
    host: 'github.example.test',
    project: 'team/api',
    number: '18',
    url,
  });
  for (const bad of [
    'http://github.com/a/b/pull/1',
    'https://user:pass@github.com/a/b/pull/1',
    'https://github.com/a/b/pull/0',
    'https://github.com/a/b/pull/1/files',
    'https://github.com/a%2fb/c/pull/1',
    url + '?token=private',
    'https://github.com/a/b/issues/1',
  ])
    assert.throws(() => parsePr(bad));
  for (const origin of [
    'git@github.example.test:Team/API.git',
    'https://github.example.test/team/api.git',
    'ssh://git@github.example.test/team/api',
  ])
    assert.ok(githubRemoteMatches(origin, 'github.example.test', 'team/api'));
  for (const origin of [
    'git@evilgithub.example.test:team/api.git',
    'git@github.example.test:another/team/api.git',
    'git@github.example.test:fork/api.git',
  ])
    assert.equal(githubRemoteMatches(origin, 'github.example.test', 'team/api'), false);
  assert.throws(() => validateSelection({ mr: 'x', pr: url }), /exactly one/);
  assert.throws(() => validateSelection({ base: 'main', pr: url }), /exactly one/);
  assert.throws(() => ReviewRequest.parse({ repo: '/tmp/repo', base: 'main', pr: url }));
});
test('GitHub channel commands accept autolinks and reject conflicting scopes', () => {
  assert.deepEqual(parseReviewCommand(`!review --pr <${url}> --token-budget 80000`), {
    '--pr': url,
    '--token-budget': '80000',
  });
  assert.deepEqual(parseReviewCommand(`!review --repo api --pr ${url}`), {
    '--repo': 'api',
    '--pr': url,
  });
  for (const command of [
    `!review --pr ${url} --mr ${url}`,
    `!review --pr ${url} --base main`,
    `!review --pr ${url} --pr ${url}`,
    `!review --repo api --token-budget 99999999999999999`,
  ])
    assert.throws(() => parseReviewCommand(command));
});

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'mk-github-')),
    repo = join(temp, 'repo'),
    remote = join(temp, 'remote.git'),
    bin = join(temp, 'bin'),
    oldPath = process.env.PATH;
  await mkdir(repo);
  await mkdir(bin);
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Test');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'app.ts'), 'export const value = 1;\n');
  await writeFile(join(repo, 'caller.ts'), 'import { value } from "./app";\nconsole.log(value);\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');
  const base = await git(repo, 'rev-parse', 'HEAD');
  await git(temp, 'init', '--bare', remote);
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'checkout', '-b', 'feature');
  await writeFile(join(repo, 'app.ts'), 'export const value = 2;\n');
  await git(repo, 'commit', '-am', 'PR change');
  const head = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'push', 'origin', 'HEAD:refs/pull/18/head');
  await git(repo, 'checkout', 'main');
  await writeFile(join(repo, 'target-only.ts'), 'unrelated target change\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'target advanced');
  const target = await git(repo, 'rev-parse', 'HEAD');
  await git(repo, 'push', 'origin', 'main');
  const origin = 'git@github.example.test:team/api.git';
  await git(repo, 'remote', 'set-url', 'origin', origin);
  await writeFile(join(repo, 'app.ts'), 'uncommitted user edit\n');
  const info = {
    number: 18,
    title: 'Pinned fork PR',
    body: 'PR description',
    base: { sha: target, ref: 'main', repo: { full_name: 'team/api' } },
    head: {
      sha: head,
      ref: 'feature',
      repo: { full_name: 'contributor/api', clone_url: 'https://untrusted.invalid/must-not-fetch' },
    },
  };
  const state: any = {
    info,
    again: info,
    conversation: [{ id: 1, body: 'General discussion' }],
    reviews: [{ id: 2, body: 'Review summary', state: 'CHANGES_REQUESTED', commit_id: head }],
    inline: [
      { id: 3, body: 'Relevant inline', path: 'app.ts', line: 1, commit_id: head },
      { id: 4, body: 'Unrelated inline', path: 'elsewhere.ts', line: 1 },
      { id: 5, body: 'Old inline', path: 'app.ts', line: null, original_line: 1, commit_id: base },
    ],
  };
  const stateFile = join(temp, 'responses.json'),
    log = join(temp, 'api.jsonl'),
    count = join(temp, 'count');
  const save = () => writeFile(stateFile, JSON.stringify(state));
  await save();
  await writeFile(
    join(bin, 'gh'),
    `#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),state=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)})),path=args.at(-1);
if(args[0]!=='api'||args[1]!=='--hostname'||args[2]!=='github.example.test'||args[3]!=='--method'||args[4]!=='GET')process.exit(2);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
if(state.fail){console.error('HTTP 403 forbidden');process.exit(1);}
let result;if(path.includes('/issues/'))result=state.conversation;else if(path.includes('/reviews?'))result=state.reviews;else if(path.includes('/comments?'))result=state.inline;else{let n=0;try{n=Number(fs.readFileSync(${JSON.stringify(count)}));}catch{}fs.writeFileSync(${JSON.stringify(count)},String(n+1));result=n?state.again:state.info;}
if(path.includes('page=2')&&!state.repeat)result=[];
console.log(JSON.stringify(result));`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, 'git'),
    `#!${process.execPath}
const {spawnSync}=require('node:child_process'),args=process.argv.slice(2).map(a=>a===${JSON.stringify(origin)}&&process.argv.includes('fetch')?${JSON.stringify(remote)}:a);
const r=spawnSync('git',args,{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(oldPath)}}});process.exit(r.status??1);`,
    { mode: 0o755 },
  );
  process.env.PATH = `${bin}:${oldPath}`;
  return {
    temp,
    repo,
    base,
    head,
    target,
    state,
    save,
    log,
    close: async () => {
      process.env.PATH = oldPath;
      await rm(temp, { recursive: true, force: true });
    },
  };
}
test('fork PRs pin merge-base and head, preserve checkout, gather discussion and expose surrounding source', async () => {
  const f = await fixture();
  try {
    const refs = await git(f.repo, 'show-ref'),
      status = await git(f.repo, 'status', '--porcelain=v1');
    const result = await resolveScope(f.repo, join(f.temp, 'match'), { pr: url });
    const { scope, gitDir } = result;
    assert.equal(scope.mode, 'pr');
    assert.equal(scope.head, f.head);
    assert.equal(scope.base, f.base);
    assert.notEqual(scope.base, f.target);
    assert.equal(scope.pr?.start, f.target);
    assert.equal(scope.pr?.target, 'main');
    assert.equal(scope.commits.length, 1);
    assert.deepEqual(scope.changedFiles, ['app.ts']);
    assert.match(scope.pr!.discussion, /General discussion/);
    assert.match(scope.pr!.discussion, /Review summary/);
    assert.match(scope.pr!.discussion, /Relevant inline/);
    assert.match(scope.pr!.discussion, /"outdated":true/);
    assert.doesNotMatch(scope.pr!.discussion, /Unrelated inline/);
    assert.equal(await git(f.repo, 'show-ref'), refs);
    assert.equal(await git(f.repo, 'status', '--porcelain=v1'), status);
    assert.equal(await readFile(join(f.repo, 'app.ts'), 'utf8'), 'uncommitted user edit\n');
    const directory = join(f.temp, 'match');
    await snapshots(gitDir, scope, join(directory, 'snapshot'));
    const runtime = { directory } as Runtime;
    assert.match(
      await capability(runtime, 'snapshot_read', { revision: 'head', file: 'caller.ts' }),
      /import.*value/,
    );
    assert.match(
      await capability(runtime, 'snapshot_search', { revision: 'head', text: 'console.log' }),
      /caller.ts:2/,
    );
    assert.match(
      await capability(runtime, 'snapshot_read', { revision: 'head', file: 'app.ts' }),
      /value = 2/,
    );
    const m = newMatch('pr-fixture', 'PR');
    m.scope = scope;
    assert.match(markdown(m), /GitHub PR: https:\/\/github.example.test\/team\/api\/pull\/18/);
  } finally {
    await f.close();
  }
});
test('GitHub requests cannot call the API for a mismatched repository', async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      resolveScope(f.repo, join(f.temp, 'mismatch'), { pr: url.replace('/team/', '/someone/') }),
      /does not match/,
    );
    await assert.rejects(readFile(f.log));
  } finally {
    await f.close();
  }
});
test('GitHub rejects stale fetches and a force push or retarget during discussion reads', async () => {
  for (const change of [
    'fetch-head',
    'fetch-base',
    'final-head',
    'final-base',
    'retarget',
  ] as const) {
    const f = await fixture();
    try {
      const copy = structuredClone(f.state.info);
      if (change === 'fetch-head') copy.head.sha = f.base;
      else if (change === 'fetch-base') copy.base.sha = f.base;
      else if (change === 'final-head') copy.head.sha = f.base;
      else if (change === 'final-base') copy.base.sha = f.base;
      else copy.base.ref = 'other';
      if (change.startsWith('fetch')) f.state.info = copy;
      else f.state.again = copy;
      await f.save();
      await assert.rejects(resolveScope(f.repo, join(f.temp, 'changed'), { pr: url }), /changed/);
    } finally {
      await f.close();
    }
  }
});
test('GitHub discussion is bounded, paginated and omissions are explicit', async () => {
  const f = await fixture();
  try {
    f.state.conversation = Array.from({ length: 100 }, (_, id) => ({ id, body: 'x'.repeat(1000) }));
    f.state.repeat = true;
    f.state.info.body = 'a'.repeat(40000);
    await f.save();
    const { scope } = await resolveScope(f.repo, join(f.temp, 'bounded'), { pr: url });
    assert.ok(Buffer.byteLength(scope.pr!.discussion) <= 64000);
    assert.ok(Buffer.byteLength(scope.pr!.description) <= 32000);
    assert.match(scope.warnings.join('\n'), /pagination capped/);
    assert.match(scope.warnings.join('\n'), /over-budget/);
    assert.match(scope.warnings.join('\n'), /description truncated/);
    const calls = (await readFile(f.log, 'utf8')).trim().split('\n');
    assert.equal(calls.length, 14);
  } finally {
    await f.close();
  }
});
test('GitHub auth errors and malformed API results fail explicitly', async () => {
  for (const kind of ['auth', 'malformed']) {
    const f = await fixture();
    try {
      if (kind === 'auth') f.state.fail = true;
      else f.state.info.head.sha = 'not-a-sha';
      await f.save();
      await assert.rejects(
        resolveScope(f.repo, join(f.temp, 'bad'), { pr: url }),
        kind === 'auth' ? /gh auth status --hostname/ : /pattern/,
      );
    } finally {
      await f.close();
    }
  }
});
test('GitHub secret-like PR prose is excluded from reviewer context', async () => {
  const f = await fixture();
  try {
    f.state.info.body = 'access_token = "' + 'a'.repeat(32) + '"';
    f.state.inline = [
      { id: 1, body: 'password = "' + 'b'.repeat(32) + '"', path: 'app.ts', line: 1 },
    ];
    await f.save();
    const { scope } = await resolveScope(f.repo, join(f.temp, 'secret'), { pr: url });
    assert.match(scope.pr!.description, /Omitted/);
    assert.match(scope.pr!.discussion, /Omitted/);
    assert.match(scope.warnings.join('\n'), /secret-like/);
  } finally {
    await f.close();
  }
});
