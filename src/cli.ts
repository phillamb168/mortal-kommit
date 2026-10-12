import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig, saveConfig, dataDir, safeError } from './backend/config.js';
import { startServer, packageRoot } from './backend/server.js';
import { setupArena } from './backend/buzz.js';
import { Store } from './backend/store.js';
import { markdown } from './backend/export.js';
import { run } from './backend/process.js';
import { validateAssets } from './backend/assets.js';
import { validateSelection } from './backend/forge.js';
import { startTunnel } from './backend/tunnel.js';

const usage = `MORTAL KOMMIT — Buzz conducts the review. Watch the fight.\n\n  mortal-kommit                         Review unpublished commits\n  mortal-kommit --base <ref>             Review commits since merge-base\n  mortal-kommit --pr <GitHub URL>        Review a pinned pull request\n  mortal-kommit --mr <GitLab URL>        Review a pinned merge request\n  mortal-kommit --token-budget <n>       Set each fighter's token allowance\n  mortal-kommit --demo [--no-open]       Play the labeled deterministic demo\n  mortal-kommit arena setup              Provision the permanent ARENA pair\n  mortal-kommit arena start --background Start the local listener\n  mortal-kommit arena status|stop\n  mortal-kommit viewer url              Print the configured shared viewer link\n  mortal-kommit viewer rotate-key       Revoke old viewer links and print a new one\n  mortal-kommit repo add <alias> <path>   Register a repo for Buzz requests\n  mortal-kommit replay <match-id>\n  mortal-kommit export <match-id> --format md|json --output <file>\n  mortal-kommit assets validate [path]\n  mortal-kommit doctor\n  mortal-kommit tunnel [stop]            Start/stop an authenticated ngrok viewer\n\nArena requests: !review --repo <alias> [--base <ref>] or !review --mr <url> / --pr <url>\nConfiguration: ${join(dataDir(), 'config.json')}\nPermanent hosting: configure viewer.publicUrl, viewer.host, viewer.port or MORTAL_KOMMIT_PUBLIC_URL / MORTAL_KOMMIT_VIEWER_HOST / MORTAL_KOMMIT_VIEWER_PORT.\nToken allowance controls fatigue; it is not a provider spending cap.\n`;
async function service() {
  try {
    const data = JSON.parse(await readFile(join(dataDir(), 'service.json'), 'utf8'));
    const res = await fetch(`${data.base}/api/status`, {
      headers: { Authorization: `Bearer ${data.token}` },
      signal: AbortSignal.timeout(1000),
    });
    if (res.ok) return data;
  } catch {}
  return null;
}
async function ensure() {
  let s = await service();
  if (s) return s;
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_serve'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    s = await service();
    if (s) return s;
  }
  throw new Error(
    'Local service did not start. Run mortal-kommit arena start in the foreground for diagnostics.',
  );
}
async function request(s: any, path: string, value?: unknown) {
  const res = await fetch(`${s.base}${path}`, {
    method: value === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}
function arenaLink(s: any, id?: string) {
  const url = new URL(s.publicViewerUrl ?? `${s.base}/#session=${s.token}`);
  if (id) url.searchParams.set('match', id);
  return url.toString();
}
function open(url: string) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  spawn(cmd, process.platform === 'win32' ? ['/c', 'start', '', url] : [url], {
    stdio: 'ignore',
  }).on('error', () => {});
}
async function main() {
  const { values: v, positionals: p } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      base: { type: 'string' },
      mr: { type: 'string' },
      pr: { type: 'string' },
      'token-budget': { type: 'string' },
      demo: { type: 'boolean' },
      'no-open': { type: 'boolean' },
      background: { type: 'boolean' },
      format: { type: 'string' },
      output: { type: 'string' },
      port: { type: 'string' },
    },
  });
  if (v.help) {
    console.log(usage);
    return;
  }
  if (v.version) {
    console.log('0.1.0');
    return;
  }
  if (p[0] === '_serve' || (p[0] === 'arena' && p[1] === 'start' && !v.background)) {
    const s = await startServer(v.port ? Number(v.port) : 0);
    console.log(`ARENA listener: ${s.url}`);
    if (s.gateway)
      console.log(`Viewer listener: ${s.gateway.local}\nShared viewer: ${s.publicViewerUrl()}`);
    if (s.coordinator.warning) console.log(s.coordinator.warning);
    return;
  }
  if (p[0] === '_tunnel') {
    await startTunnel();
    return;
  }
  if (p[0] === 'tunnel') {
    let existing: any = null;
    try {
      existing = JSON.parse(await readFile(join(dataDir(), 'tunnel.json'), 'utf8'));
      process.kill(existing.pid, 0);
    } catch {
      existing = null;
    }
    if (p[1] === 'stop') {
      if (existing)
        await fetch(`${existing.local}/_local/stop`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${existing.control}` },
        });
      console.log('ngrok viewer tunnel stopped.');
      return;
    }
    if (readConfig().viewer)
      throw new Error(
        'A permanent viewer is configured. Use mortal-kommit viewer url, or set viewer to null before using ngrok.',
      );
    if (existing) {
      console.log(existing.url);
      return;
    }
    const s = await ensure();
    await request(s, '/api/demo', {});
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '_tunnel'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: process.env,
    });
    child.unref();
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        const t = JSON.parse(await readFile(join(dataDir(), 'tunnel.json'), 'utf8'));
        if (t.pid === child.pid) {
          console.log(t.url);
          return;
        }
      } catch {}
      if (child.exitCode !== null)
        throw new Error('ngrok could not start; check the diagnostic above.');
    }
    throw new Error('ngrok startup timed out.');
  }
  if (p[0] === 'arena') {
    if (p[1] === 'setup') {
      if (await service())
        throw new Error(
          'Stop the arena service before changing its identity configuration: mortal-kommit arena stop',
        );
      const c = await setupArena(readConfig());
      console.log(
        `ARENA configured: ${c.channelId}\nStart with mortal-kommit arena start --background`,
      );
      return;
    }
    if (p[1] === 'start') {
      const s = await ensure();
      console.log(arenaLink(s));
      return;
    }
    const s = await service();
    if (!s) {
      console.log('ARENA service is stopped.');
      return;
    }
    if (p[1] === 'stop') {
      await request(s, '/api/stop', {});
      console.log('ARENA service stopped.');
    } else console.log(JSON.stringify(await request(s, '/api/status'), null, 2));
    return;
  }
  if (p[0] === 'viewer') {
    if (p[1] && !['url', 'rotate-key'].includes(p[1]))
      throw new Error('Usage: mortal-kommit viewer url|rotate-key');
    const s = await service();
    if (!s) throw new Error('Start the ARENA service before accessing its viewer.');
    const result =
      p[1] === 'rotate-key'
        ? await request(s, '/api/viewer/rotate', {})
        : await request(s, '/api/viewer');
    if (!result.url) throw new Error('Configure viewer.publicUrl and restart ARENA first.');
    console.log(result.url);
    return;
  }
  if (p[0] === 'repo' && p[1] === 'add') {
    if (!p[2] || !p[3] || !/^[a-zA-Z0-9_-]+$/.test(p[2]))
      throw new Error('Usage: mortal-kommit repo add <alias> <path>');
    const path = resolve(p[3]);
    await run('git', ['rev-parse', '--show-toplevel'], { cwd: path });
    const config = readConfig();
    config.repos[p[2]] = path;
    saveConfig(config);
    console.log(
      `Registered ${p[2]} → ${path}. Restart an already-running service to load registration.`,
    );
    return;
  }
  if (p[0] === 'doctor') {
    const c = readConfig();
    const result: any = {
      node: process.version,
      configuration: join(dataDir(), 'config.json'),
      arenaChannel: c.channelId,
      ownerCredentialPresent: !!process.env.MORTAL_KOMMIT_OWNER_KEY,
      checks: {},
    };
    for (const [name, command, args, env] of [
      ['Buzz CLI', c.executables.buzz, ['--help'], process.env],
      ['Buzz harness', c.executables.harness, ['--help'], process.env],
      [
        'Codex Work authentication',
        c.executables.codex,
        ['login', 'status'],
        { ...process.env, CODEX_HOME: c.profiles.codexHome },
      ],
      [
        'Claude Work authentication',
        'claude',
        ['auth', 'status'],
        { ...process.env, CLAUDE_CONFIG_DIR: c.profiles.claudeConfig },
      ],
    ] as const) {
      try {
        const text = await run(command, [...args], { env, timeout: 10000 });
        result.checks[name] = name.startsWith('Claude')
          ? JSON.parse(text).loggedIn
            ? 'authenticated'
            : 'not authenticated'
          : name.startsWith('Codex')
            ? 'authenticated'
            : text.includes('Usage:')
              ? 'available'
              : 'check output';
      } catch (e) {
        result.checks[name] = safeError(e);
      }
    }
    for (const name of ['claudeAdapter', 'codexAdapter'] as const)
      result.checks[name] = await stat(c.executables[name])
        .then(() => 'installed')
        .catch(() => 'missing');
    for (const command of ['gh', 'glab']) {
      result.checks[`${command} (optional provider CLI)`] = await run(command, ['--version'], {
        timeout: 10000,
      })
        .then(() => 'installed; verify authentication for the review hostname separately')
        .catch(() => 'not installed; needed only for this provider');
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (p[0] === 'assets' && p[1] === 'validate') {
    console.log(
      JSON.stringify(
        await validateAssets(p[2] ? resolve(p[2]) : join(packageRoot(), 'assets')),
        null,
        2,
      ),
    );
    return;
  }
  if (p[0] === 'export') {
    const store = new Store(dataDir());
    const m = store.get(p[1]);
    store.close();
    if (!m) throw new Error('Match not found');
    const format = v.format ?? 'md';
    if (!['md', 'json'].includes(format)) throw new Error('Export format must be md or json');
    const text = format === 'md' ? markdown(m) : JSON.stringify(m, null, 2);
    if (v.output) {
      await writeFile(resolve(v.output), text);
      console.log(resolve(v.output));
    } else console.log(text);
    return;
  }
  validateSelection({ base: v.base, mr: v.mr, pr: v.pr });
  const budget = v['token-budget'] ? Number(v['token-budget']) : undefined;
  if (budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0))
    throw new Error('Token budget must be a positive integer');
  if (p.length && p[0] !== 'replay') throw new Error(`Unknown command ${p[0]}. Use --help.`);
  const s = await ensure();
  let match: any;
  if (v.demo) match = await request(s, '/api/demo', {});
  else if (p[0] === 'replay') match = await request(s, `/api/matches/${encodeURIComponent(p[1])}`);
  else
    match = await request(s, '/api/reviews', {
      repo: process.cwd(),
      base: v.base,
      mr: v.mr,
      pr: v.pr,
      tokenBudget: budget,
    });
  const url = arenaLink(s, match.id);
  console.log(`MORTAL KOMMIT${match.demo ? ' · SCRIPTED DEMO' : ''}\n${url}`);
  if (!v['no-open']) open(url);
  if (!match.demo && p[0] !== 'replay') {
    let displayed = false;
    while (['queued', 'scouting'].includes(match.status)) {
      await new Promise((r) => setTimeout(r, 700));
      match = await request(s, `/api/matches/${match.id}`);
      if (match.scope && !displayed) {
        console.log(
          `\nComparison: ${match.scope.comparison}\n${match.scope.commits.map((c: any) => `${c.sha.slice(0, 12)} ${c.subject}`).join('\n')}`,
        );
        for (const warning of match.scope.warnings) console.log(warning);
        displayed = true;
      }
    }
    if (match.status === 'failed') throw new Error(match.error);
    console.log(`Buzz review ${match.status}. The ARENA listener continues in the background.`);
  }
}
main().catch((e) => {
  console.error(safeError(e));
  process.exitCode = 1;
});
