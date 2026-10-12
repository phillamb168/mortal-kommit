import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../src/backend/process.js';
import {
  resolveScope,
  snapshots,
  safePath,
  parseMr,
  containsSecret,
  excluded,
  remoteMatches,
  gitlabRemoteMatches,
} from '../src/backend/repository.js';

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'mk-git-')),
    repo = join(temp, 'repo'),
    remote = join(temp, 'remote.git');
  await mkdir(repo);
  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Mortal Kommit Test');
  await git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'app.ts'), 'export const value = 1;\n');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial');
  await git(temp, 'init', '--bare', remote);
  await git(repo, 'remote', 'add', 'origin', remote);
  await git(repo, 'push', '-u', 'origin', 'main');
  return { temp, repo, remote };
}
async function commit(repo: string, text: string) {
  await writeFile(join(repo, 'app.ts'), text);
  await git(repo, 'add', 'app.ts');
  await git(repo, 'commit', '-m', text.trim());
  return git(repo, 'rev-parse', 'HEAD');
}
test('default selects only unpublished commits, refreshes upstream, and preserves dirty checkout', async () => {
  const { temp, repo } = await fixture();
  try {
    await git(repo, 'checkout', '-b', 'feature');
    await commit(repo, 'published feature\n');
    await git(repo, 'push', '-u', 'origin', 'feature');
    const sha = await commit(repo, 'unpublished fix\n');
    await writeFile(join(repo, 'app.ts'), 'dirty work\n');
    const before = await git(repo, 'status', '--porcelain=v1');
    const refs = await git(repo, 'show-ref');
    const { scope } = await resolveScope(repo, join(temp, 'match'));
    assert.equal(scope.commits.length, 1);
    assert.equal(scope.commits[0].sha, sha);
    assert.equal(scope.dirty, true);
    assert.equal(await git(repo, 'status', '--porcelain=v1'), before);
    assert.equal(await git(repo, 'show-ref'), refs);
    assert.equal(await readFile(join(repo, 'app.ts'), 'utf8'), 'dirty work\n');
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test('missing upstream and empty range require explicit handling', async () => {
  const { temp, repo } = await fixture();
  try {
    await assert.rejects(resolveScope(repo, join(temp, 'empty')), /Empty review range/);
    await git(repo, 'checkout', '-b', 'no-upstream');
    await commit(repo, 'local change\n');
    await assert.rejects(resolveScope(repo, join(temp, 'missing')), /No upstream/);
    const { scope } = await resolveScope(repo, join(temp, 'explicit'), { base: 'main' });
    assert.equal(scope.mode, 'base');
    assert.equal(scope.commits.length, 1);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test('stale remote information is refreshed and divergence requires explicit base', async () => {
  const { temp, repo, remote } = await fixture();
  try {
    const second = join(temp, 'second');
    await git(temp, 'clone', remote, second);
    await git(second, 'checkout', 'main');
    await git(second, 'config', 'user.name', 'Test');
    await git(second, 'config', 'user.email', 'test@example.invalid');
    await commit(second, 'remote change\n');
    await git(second, 'push', 'origin', 'main');
    await commit(repo, 'local change\n');
    await assert.rejects(resolveScope(repo, join(temp, 'diverged')), /diverged/);
    await git(repo, 'remote', 'set-url', 'origin', join(temp, 'missing.git'));
    await assert.rejects(resolveScope(repo, join(temp, 'stale')), /Cannot refresh upstream/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test('snapshots omit credentials and symlinks and use immutable committed content', async () => {
  const { temp, repo } = await fixture();
  try {
    await writeFile(join(repo, '.env'), 'PASSWORD=do-not-copy');
    await writeFile(join(repo, 'credential.ts'), 'const secret = "abcdefghijklmnopqrstuv123456";');
    await symlink('/etc/passwd', join(repo, 'outside'));
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'sensitive fixture');
    const { scope, gitDir } = await resolveScope(repo, join(temp, 'match'), { base: 'HEAD~1' });
    const omitted = await snapshots(gitDir, scope, join(temp, 'snap'));
    assert.ok(omitted.some((p) => p.includes('.env')));
    assert.ok(omitted.some((p) => p.includes('credential.ts')));
    assert.ok(omitted.some((p) => p.includes('outside')));
    assert.equal(
      await readFile(join(temp, 'snap/head/app.ts'), 'utf8'),
      'export const value = 1;\n',
    );
    assert.throws(() => safePath(join(temp, 'snap'), '../outside'));
    assert.throws(() => safePath(join(temp, 'snap'), '/etc/passwd'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test('self-hosted MR URLs and secret filters are validated', () => {
  assert.deepEqual(parseMr('https://gitlab.example.test/team/sub/project/-/merge_requests/18'), {
    host: 'gitlab.example.test',
    project: 'team/sub/project',
    iid: '18',
  });
  assert.throws(() => parseMr('https://user:pass@gitlab.com/a/-/merge_requests/1'));
  assert.ok(containsSecret('-----BEGIN PRIVATE KEY-----'));
  assert.ok(excluded('services/foo/.env.production'));
  assert.ok(!excluded('src/auth.ts'));
});

test('MR remote matching compares the entire host and project, including SSH syntax', () => {
  for (const remote of [
    'https://gitlab.example.test/team/sub/project.git',
    'git@gitlab.example.test:team/sub/project.git',
    'ssh://git@gitlab.example.test/team/sub/project.git',
  ])
    assert.ok(remoteMatches(remote, 'gitlab.example.test', 'team/sub/project'));
  assert.equal(
    remoteMatches(
      'https://evilgitlab.example.test/team/sub/project.git',
      'gitlab.example.test',
      'team/sub/project',
    ),
    false,
  );
  assert.equal(
    remoteMatches(
      'https://gitlab.example.test/another/team/sub/project.git',
      'gitlab.example.test',
      'team/sub/project',
    ),
    false,
  );
});

test('separate GitLab SSH hosts require an explicit trusted mapping and the exact project', () => {
  const host = 'gitlab.example.test',
    sshHost = 'gitlab-ssh.example.test',
    project = 'team/sub/project';
  for (const remote of [`git@${sshHost}:${project}.git`, `ssh://git@${sshHost}/${project}.git`]) {
    assert.equal(remoteMatches(remote, host, project), false);
    assert.equal(remoteMatches(remote, host, project, sshHost), true);
  }
  for (const remote of [
    `https://${sshHost}/${project}.git`,
    `git@evil${sshHost}:${project}.git`,
    `git@${sshHost}:another/${project}.git`,
  ])
    assert.equal(remoteMatches(remote, host, project, sshHost), false);
  assert.equal(
    remoteMatches(`ssh://git@${sshHost}:2222/${project}.git`, host, project, sshHost),
    false,
  );
  assert.equal(
    remoteMatches(`ssh://git@${sshHost}:2222/${project}.git`, host, project, `${sshHost}:2222`),
    true,
  );
});

test('GitLab SSH alias lookup uses only the requested host in global glab config and fails closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mk-ssh-host-')),
    oldPath = process.env.PATH;
  try {
    const configFile = join(directory, 'ssh-host');
    await writeFile(configFile, 'gitlab-ssh.example.test\n');
    await writeFile(
      join(directory, 'glab'),
      `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);if(JSON.stringify(args)!==JSON.stringify(['config','get','ssh_host','--host','gitlab.example.test','--global']))process.exit(2);process.stdout.write(fs.readFileSync(${JSON.stringify(configFile)}));\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${directory}:${oldPath}`;
    assert.equal(
      await gitlabRemoteMatches(
        'git@gitlab-ssh.example.test:team/api.git',
        'gitlab.example.test',
        'team/api',
      ),
      true,
    );
    assert.equal(
      await gitlabRemoteMatches(
        'git@gitlab-ssh.example.test:another/team/api.git',
        'gitlab.example.test',
        'team/api',
      ),
      false,
    );
    assert.equal(
      await gitlabRemoteMatches(
        'https://gitlab-ssh.example.test/team/api.git',
        'gitlab.example.test',
        'team/api',
      ),
      false,
    );
    await writeFile(configFile, '');
    assert.equal(
      await gitlabRemoteMatches(
        'git@gitlab-ssh.example.test:team/api.git',
        'gitlab.example.test',
        'team/api',
      ),
      false,
    );
    await writeFile(configFile, 'gitlab-ssh.example.test/unexpected-path');
    await assert.rejects(
      gitlabRemoteMatches(
        'git@gitlab-ssh.example.test:team/api.git',
        'gitlab.example.test',
        'team/api',
      ),
      /Invalid SSH hostname/,
    );
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('GitLab MR selection pins exact revisions and includes bounded relevant discussion', async () => {
  const { temp, repo, remote } = await fixture();
  const oldEnv = { ...process.env };
  try {
    const base = (await git(repo, 'rev-parse', 'HEAD')).trim();
    const head = (await commit(repo, 'MR change\n')).trim();
    await git(repo, 'push', 'origin', 'HEAD:refs/merge-requests/18/head');
    const origin = 'https://gitlab.example.test/team/sub/project.git',
      sshOrigin = 'git@gitlab-ssh.example.test:team/sub/project.git';
    await git(repo, 'remote', 'set-url', 'origin', origin);
    const bin = join(temp, 'bin');
    await mkdir(bin);
    const glab = join(bin, 'glab');
    const info = {
      title: 'Pinned fixture MR',
      description: 'Review description',
      target_branch: 'main',
      diff_refs: { base_sha: base, head_sha: head, start_sha: base },
    };
    const script = `#!/usr/bin/env node\nconst path=process.argv.at(-1); if(process.argv[2]==='config'){if(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['config','get','ssh_host','--host','gitlab.example.test','--global']))process.exit(2);console.log('gitlab-ssh.example.test');} else if(path.includes('/discussions?')) console.log(JSON.stringify([{notes:[{id:1,body:'Relevant review',position:{new_path:'app.ts',new_line:1}},{id:2,body:'Unrelated',position:{new_path:'other.ts'}},{id:3,body:'System',system:true}]}])); else if(path.includes('/merge_requests/'))console.log(${JSON.stringify(JSON.stringify(info))}); else console.log(JSON.stringify({ssh_url_to_repo:${JSON.stringify(sshOrigin)}}));\n`;
    await writeFile(glab, script, { mode: 0o755 });
    await writeFile(
      join(bin, 'git'),
      `#!/usr/bin/env node\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2).map(a=>${JSON.stringify([origin, sshOrigin])}.includes(a)&&process.argv.includes('fetch')?${JSON.stringify(remote)}:a);const r=spawnSync('git',args,{stdio:'inherit',env:{...process.env,PATH:${JSON.stringify(oldEnv.PATH)}}});process.exit(r.status??1);\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}:${oldEnv.PATH}`;
    const { scope } = await resolveScope(repo, join(temp, 'mr'), {
      mr: 'https://gitlab.example.test/team/sub/project/-/merge_requests/18',
    });
    assert.equal(scope.head, head);
    assert.equal(scope.base, base);
    assert.equal(scope.mode, 'mr');
    assert.equal(scope.mr?.target, 'main');
    assert.equal(scope.mr?.description, 'Review description');
    assert.match(scope.mr!.discussion, /Relevant review/);
    assert.doesNotMatch(scope.mr!.discussion, /Unrelated|System/);
    assert.equal(scope.commits.length, 1);
    assert.match(scope.warnings.join('\n'), /2 system, unrelated/);
    await git(repo, 'remote', 'set-url', 'origin', sshOrigin);
    const separateHost = await resolveScope(repo, join(temp, 'mr-ssh'), {
      mr: 'https://gitlab.example.test/team/sub/project/-/merge_requests/18',
    });
    assert.equal(separateHost.scope.head, head);
    assert.equal(separateHost.scope.base, base);
    assert.equal(await git(repo, 'remote', 'get-url', 'origin'), sshOrigin);
    const changedInfo = JSON.stringify(
      JSON.stringify({ ...info, diff_refs: { ...info.diff_refs, head_sha: base } }),
    );
    await writeFile(glab, script.replace(JSON.stringify(JSON.stringify(info)), changedInfo), {
      mode: 0o755,
    });
    await assert.rejects(
      resolveScope(repo, join(temp, 'changed'), {
        mr: 'https://gitlab.example.test/team/sub/project/-/merge_requests/18',
      }),
      /MR head changed/,
    );
  } finally {
    for (const key of ['PATH', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'])
      if (oldEnv[key] === undefined) delete process.env[key];
      else process.env[key] = oldEnv[key];
    await rm(temp, { recursive: true, force: true });
  }
});
