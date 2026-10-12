import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
import { Config } from '../src/backend/config.js';
import { validSignedEvent } from '../src/backend/buzz.js';
import { authorizeReviewRequester } from '../src/backend/membership.js';
import { Coordinator } from '../src/backend/coordinator.js';
import { Store } from '../src/backend/store.js';
import { git } from '../src/backend/process.js';

const channel = '11111111-1111-4111-8111-111111111111';
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mk-members-'));
  const owner = generateSecretKey(),
    human = generateSecretKey(),
    bot = generateSecretKey();
  const pk = getPublicKey(human),
    botPk = getPublicKey(bot),
    ownerPk = getPublicKey(owner);
  const oldDirectory = process.env.MORTAL_KOMMIT_DATA_DIR,
    oldKey = process.env.MORTAL_KOMMIT_OWNER_KEY;
  process.env.MORTAL_KOMMIT_DATA_DIR = directory;
  process.env.MORTAL_KOMMIT_OWNER_KEY = Buffer.from(owner).toString('hex');
  const memberFile = join(directory, 'members.json'),
    sentFile = join(directory, 'sent.jsonl'),
    cli = join(directory, 'buzz-fixture.cjs');
  await writeFile(
    memberFile,
    JSON.stringify([
      { pubkey: pk, role: 'member' },
      { pubkey: botPk, role: 'bot' },
      { pubkey: ownerPk, role: 'owner' },
    ]),
  );
  await writeFile(
    cli,
    `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
if(args[2]==='channels'&&args[3]==='members')process.stdout.write(fs.readFileSync(path.join(__dirname,'members.json')));
else if(args[2]==='messages'&&args[3]==='send'){const content=fs.readFileSync(0,'utf8');fs.appendFileSync(path.join(__dirname,'sent.jsonl'),JSON.stringify({args,content})+'\\n');console.log(JSON.stringify({event_id:'fixture-reply'}));}
else process.exit(2);
`,
    { mode: 0o755 },
  );
  const profile = (content: unknown = {}, tags: string[][] = [], key = human) =>
    finalizeEvent({ kind: 0, created_at: 100, tags, content: JSON.stringify(content) }, key);
  const state = { profiles: [profile()] as Event[], status: 200, queries: 0 };
  let relay = '';
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const auth = JSON.parse(
        Buffer.from(req.headers.authorization!.replace(/^Nostr /, ''), 'base64').toString('utf8'),
      );
      assert.ok(validSignedEvent(auth));
      assert.equal(auth.pubkey, ownerPk);
      assert.equal(auth.kind, 27235);
      assert.ok(auth.tags.some((t: string[]) => t[0] === 'u' && t[1] === `${relay}/query`));
      assert.ok(auth.tags.some((t: string[]) => t[0] === 'method' && t[1] === 'POST'));
      assert.ok(
        auth.tags.some(
          (t: string[]) =>
            t[0] === 'payload' && t[1] === createHash('sha256').update(body).digest('hex'),
        ),
      );
      assert.ok(auth.tags.some((t: string[]) => t[0] === 'nonce'));
      const [filter] = JSON.parse(body);
      assert.deepEqual(filter.kinds, [0]);
      assert.equal(filter.limit, 1);
      assert.equal(filter.authors.length, 1);
      state.queries++;
      res.writeHead(state.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.profiles));
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  relay = `http://127.0.0.1:${address.port}`;
  const defaults = Config.parse({});
  const config = Config.parse({
    relay,
    channelId: channel,
    ownerPubkey: ownerPk,
    fighters: { claude: 'a'.repeat(64), codex: 'b'.repeat(64) },
    repos: { api: '/registered/api' },
    executables: { ...defaults.executables, buzz: cli },
  });
  const store = new Store(directory),
    coordinator = new Coordinator(store, () => 'http://127.0.0.1:1/#session=viewer');
  coordinator.config = config;
  clearInterval(coordinator.timer);
  coordinator.tick = async () => {};
  const event = (
    content = '!review --repo api',
    key = human,
    tags: string[][] = [['h', channel]],
    kind = 9,
  ) => finalizeEvent({ kind, created_at: 101, tags, content }, key);
  const members = async (rows: unknown) => writeFile(memberFile, JSON.stringify(rows));
  const sent = async () => {
    try {
      return (await readFile(sentFile, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((s) => JSON.parse(s));
    } catch {
      return [];
    }
  };
  const close = async () => {
    coordinator.close();
    store.close();
    await new Promise<void>((r) => server.close(() => r()));
    for (const [name, value] of [
      ['MORTAL_KOMMIT_DATA_DIR', oldDirectory],
      ['MORTAL_KOMMIT_OWNER_KEY', oldKey],
    ])
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    await rm(directory, { recursive: true, force: true });
  };
  return {
    directory,
    owner,
    human,
    bot,
    pk,
    botPk,
    ownerPk,
    state,
    profile,
    config,
    coordinator,
    store,
    event,
    members,
    sent,
    close,
  };
}

test('every human channel role can request reviews; optional missing profile is supported', async () => {
  const f = await fixture();
  try {
    for (const role of ['owner', 'admin', 'member', 'guest']) {
      await f.members([{ pubkey: f.pk, role }]);
      assert.equal(await authorizeReviewRequester(f.config, f.event()), true);
    }
    f.state.profiles = [];
    assert.equal(await authorizeReviewRequester(f.config, f.event()), true);
  } finally {
    await f.close();
  }
});

test('bot membership, profile bots, delegated identities and the configured fighters cannot request reviews', async () => {
  const f = await fixture();
  try {
    assert.equal(await authorizeReviewRequester(f.config, f.event(undefined, f.bot)), false);
    f.state.profiles = [f.profile({ bot: true })];
    assert.equal(await authorizeReviewRequester(f.config, f.event()), false);
    f.state.profiles = [f.profile({ bot: false }, [['auth', f.ownerPk, '', 'owner-attestation']])];
    assert.equal(await authorizeReviewRequester(f.config, f.event()), false);
    f.state.profiles = [f.profile({ bot: false })];
    assert.equal(
      await authorizeReviewRequester(
        f.config,
        f.event(undefined, f.human, [
          ['h', channel],
          ['auth', f.ownerPk],
        ]),
      ),
      false,
    );
    f.config.fighters!.claude = f.pk;
    assert.equal(await authorizeReviewRequester(f.config, f.event()), false);
    assert.equal(f.state.queries, 2);
  } finally {
    await f.close();
  }
});

test('fresh membership rejects outsiders, removed members, forged messages and ambiguous channels', async () => {
  const f = await fixture();
  try {
    assert.equal(await authorizeReviewRequester(f.config, f.event()), true);
    await f.members([]);
    assert.equal(await authorizeReviewRequester(f.config, f.event()), false);
    await f.members([{ pubkey: f.pk, role: 'member' }]);
    assert.equal(
      await authorizeReviewRequester(f.config, { ...f.event(), sig: '0'.repeat(128) }),
      false,
    );
    assert.equal(
      await authorizeReviewRequester(
        f.config,
        f.event(undefined, f.human, [['h', 'another-channel']]),
      ),
      false,
    );
    assert.equal(
      await authorizeReviewRequester(
        f.config,
        f.event(undefined, f.human, [
          ['h', channel],
          ['h', 'another-channel'],
        ]),
      ),
      false,
    );
    assert.equal(f.state.queries, 1);
  } finally {
    await f.close();
  }
});

test('identity lookup failures and malformed or forged profiles never authorize a request', async () => {
  const f = await fixture();
  try {
    f.state.status = 503;
    await assert.rejects(authorizeReviewRequester(f.config, f.event()), /HTTP 503/);
    f.state.status = 200;
    f.state.profiles = [{ ...f.profile(), sig: '0'.repeat(128) }];
    await assert.rejects(authorizeReviewRequester(f.config, f.event()), /invalid signed events/);
    f.state.profiles = [f.profile({ bot: 'false' })];
    await assert.rejects(authorizeReviewRequester(f.config, f.event()), /malformed/);
    f.state.profiles = [f.profile({}, [], f.bot)];
    await assert.rejects(authorizeReviewRequester(f.config, f.event()), /ambiguous/);
    await f.members([{ pubkey: f.pk, role: 'unknown' }]);
    await assert.rejects(authorizeReviewRequester(f.config, f.event()));
  } finally {
    await f.close();
  }
});

test('human kickoff is queued once across simultaneous deliveries and retains signed requester provenance', async () => {
  const f = await fixture();
  try {
    const event = f.event();
    await Promise.all([f.coordinator.observe(event), f.coordinator.observe(event)]);
    await f.coordinator.observe(event);
    assert.equal(f.store.list().length, 1);
    assert.equal(f.state.queries, 1);
    assert.equal((await f.sent()).length, 1);
    assert.match((await f.sent())[0].content, /Review queued/);
    const [request] = f.store.records('request');
    assert.deepEqual(request.requestEvent, JSON.parse(JSON.stringify(event)));
    assert.ok(validSignedEvent(request.requestEvent));
    assert.equal(request.repo, '/registered/api');
    assert.equal(request.rootId, event.id);
    const [audit] = f.store.records('command');
    assert.equal(audit.pubkey, f.pk);
    assert.equal(audit.status, 'accepted');
    const resumed = new Coordinator(f.store, () => 'http://127.0.0.1:1/');
    resumed.config = f.config;
    clearInterval(resumed.timer);
    resumed.tick = async () => {};
    try {
      await resumed.observe(event);
      assert.equal(f.state.queries, 1);
      assert.equal(f.store.list().length, 1);
    } finally {
      resumed.close();
    }
    const second = f.event('!review --repo api --base main', f.human, [['h', channel]], 40002);
    await f.coordinator.observe(second);
    assert.equal(f.store.list().length, 2);
    assert.notEqual(f.store.list()[0].rootId, f.store.list()[1].rootId);
  } finally {
    await f.close();
  }
});

test('bots and nonmembers cannot trigger models or replies; denied events cannot be replayed after admission', async () => {
  const f = await fixture();
  try {
    const bot = f.event(undefined, f.bot);
    await f.coordinator.observe(bot);
    await f.members([]);
    const outside = f.event();
    await f.coordinator.observe(outside);
    await f.members([{ pubkey: f.pk, role: 'member' }]);
    await f.coordinator.observe(outside);
    assert.equal(f.store.list().length, 0);
    assert.equal(f.store.records('request').length, 0);
    assert.equal((await f.sent()).length, 0);
    assert.equal(f.state.queries, 0);
  } finally {
    await f.close();
  }
});

test('lookup outages can recover on redelivery and queued membership is rechecked before preparation', async () => {
  const f = await fixture();
  try {
    const event = f.event();
    f.state.status = 503;
    await f.coordinator.observe(event);
    assert.equal(f.store.hasRecord(`command:${event.id}`), false);
    assert.equal(f.store.list().length, 0);
    assert.match(f.coordinator.warning!, /membership could not be verified/);
    f.state.status = 200;
    await f.coordinator.observe(event);
    assert.equal(f.store.list().length, 1);
    assert.equal(f.coordinator.warning, null);
    await f.members([]);
    await assert.rejects(
      f.coordinator.launch(f.store.list()[0]),
      /no longer an eligible human member/,
    );
    assert.equal((await f.sent()).length, 1);
  } finally {
    await f.close();
  }
});

test('teammates are limited to registered repos and one request per new topic', async () => {
  const f = await fixture();
  try {
    await f.coordinator.observe(f.event('!review --repo /private/path'));
    assert.equal(f.store.list().length, 0);
    assert.match((await f.sent())[0].content, /alias is not registered/);
    await f.coordinator.observe(
      f.event('!review --repo api', f.human, [
        ['h', channel],
        ['e', 'c'.repeat(64), '', 'root'],
      ]),
    );
    assert.equal(f.store.list().length, 0);
    assert.match((await f.sent())[1].content, /new ARENA topic/);
    await f.coordinator.observe(f.event('!review --repo api --shell rm'));
    assert.equal(f.store.list().length, 0);
    assert.match((await f.sent())[2].content, /Use !review/);
  } finally {
    await f.close();
  }
});

test('teammate MR requests must match a registered project before GitLab API calls can run', async () => {
  const f = await fixture();
  try {
    await git(f.directory, 'init', '-b', 'main');
    await git(f.directory, 'remote', 'add', 'origin', 'git@gitlab.example.test:team/api.git');
    f.config.repos.api = f.directory;
    await f.coordinator.observe(
      f.event('!review --repo api --mr https://other.example.test/team/api/-/merge_requests/7'),
    );
    assert.equal(f.store.list().length, 0);
    assert.match((await f.sent())[0].content, /does not match the registered repository/);
    const request = f.event(
      '!review --mr <https://gitlab.example.test/team/api/-/merge_requests/7>',
    );
    await f.coordinator.observe(request);
    assert.equal(f.store.list().length, 1);
    assert.equal(f.store.records('request')[0].repo, f.directory);
    assert.equal(
      f.store.records('request')[0].mr,
      'https://gitlab.example.test/team/api/-/merge_requests/7',
    );
    assert.equal(f.store.records('request')[0].requestEvent.content, request.content);
  } finally {
    await f.close();
  }
});

test('teammate MR requests discover a registered checkout through the configured GitLab SSH host', async () => {
  const f = await fixture(),
    oldPath = process.env.PATH;
  try {
    await git(f.directory, 'init', '-b', 'main');
    await git(f.directory, 'remote', 'add', 'origin', 'git@gitlab-ssh.example.test:team/api.git');
    f.config.repos.api = f.directory;
    await writeFile(
      join(f.directory, 'glab'),
      `#!${process.execPath}\nconst args=process.argv.slice(2);if(JSON.stringify(args)!==JSON.stringify(['config','get','ssh_host','--host','gitlab.example.test','--global']))process.exit(2);console.log('gitlab-ssh.example.test');\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${f.directory}:${oldPath}`;
    await f.coordinator.observe(
      f.event('!review --mr https://gitlab.example.test/team/api/-/merge_requests/7'),
    );
    assert.equal(f.store.list().length, 1);
    assert.equal(f.store.records('request')[0].repo, f.directory);
    await f.coordinator.observe(
      f.event(
        '!review --repo api --mr https://gitlab.example.test/another/team/api/-/merge_requests/7',
      ),
    );
    assert.equal(f.store.list().length, 1);
    assert.match((await f.sent())[1].content, /does not match the registered repository/);
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    await f.close();
  }
});

test('human GitHub PR kickoff selects the registered target and rejects foreign targets', async () => {
  const f = await fixture();
  try {
    await git(f.directory, 'init', '-b', 'main');
    await git(f.directory, 'remote', 'add', 'origin', 'git@github.com:team/api.git');
    f.config.repos.api = f.directory;
    await f.coordinator.observe(
      f.event('!review --repo api --pr https://github.com/outsider/api/pull/7'),
    );
    assert.equal(f.store.list().length, 0);
    assert.match((await f.sent())[0].content, /does not match the registered repository/);
    const event = f.event('!review --pr <https://github.com/team/api/pull/7>');
    await f.coordinator.observe(event);
    assert.equal(f.store.list().length, 1);
    assert.equal(f.store.records('request')[0].pr, 'https://github.com/team/api/pull/7');
    assert.equal(f.store.records('request')[0].repo, f.directory);
    await f.coordinator.observe(event);
    assert.equal(f.store.list().length, 1);
  } finally {
    await f.close();
  }
});
