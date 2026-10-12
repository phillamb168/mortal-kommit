import { spawn } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Runtime } from './capabilities.js';
import { modelEnv } from './models.js';
import { promptUsageRecord } from './telemetry.js';

export function validSessionTitle(title: unknown, root: string) {
  return typeof title === 'string' && title.endsWith(` · ${root.slice(0, 8)}`);
}
export function restrictedSession(params: any, runtime: Runtime, file: string) {
  if (!validSessionTitle(params?._meta?.sessionTitle, runtime.rootId))
    throw new Error('Only the registered match thread can create a review session');
  return {
    cwd: join(runtime.directory, 'model-work'),
    mcpServers: [
      {
        name: 'mortal',
        command: process.execPath,
        args: [join(dirname(fileURLToPath(import.meta.url)), 'capabilities.js'), file],
        env: [],
      },
    ],
    _meta: {
      sessionTitle: params._meta.sessionTitle,
      systemPrompt: params._meta.systemPrompt,
      claudeCode: {
        options: {
          tools: [],
          allowedTools: ['mcp__mortal__*'],
          settingSources: [],
          settings: { disableAllHooks: true },
          hooks: {},
          agents: {},
          additionalDirectories: [],
        },
      },
    },
    ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
  };
}
export async function proxy(file: string) {
  const runtime: Runtime = JSON.parse(readFileSync(file, 'utf8'));
  const env = modelEnv(runtime.config);
  mkdirSync(join(runtime.directory, 'model-work'), { recursive: true });
  // Isolate Codex configuration while reusing the selected Work OAuth identity.
  const authHome = join(runtime.directory, 'codex-profile');
  mkdirSync(authHome, { recursive: true, mode: 0o700 });
  const auth = join(runtime.config.profiles.codexHome, 'auth.json');
  if (existsSync(auth) && !existsSync(join(authHome, 'auth.json')))
    symlinkSync(auth, join(authHome, 'auth.json'));
  env.CODEX_HOME = authHome;
  env.INITIAL_AGENT_MODE = 'read-only';
  env.CODEX_PATH = runtime.config.executables.codex;
  env.CODEX_CONFIG = JSON.stringify({
    sandbox_mode: 'read-only',
    approval_policy: 'never',
    features: { shell_tool: false, multi_agent: false, apps: false, plugins: false, hooks: false },
    web_search: 'disabled',
  });
  const child = spawn(process.execPath, [runtime.adapter], {
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map<any, string>(),
    sessions = new Set<string>(),
    turns = new Map<string, number>();
  const binding = (sessionId: string, active: boolean) => {
    let bindings: any[] = [];
    try {
      bindings = JSON.parse(readFileSync(runtime.bindingsFile, 'utf8'));
    } catch {}
    const b = bindings.find((b) => b.sessionId === sessionId);
    if (b) b.active = active;
    else
      bindings.push({
        agent: runtime.agent,
        sessionId,
        rootId: runtime.rootId,
        matchId: runtime.matchId,
        active,
      });
    writeFileSync(runtime.bindingsFile, JSON.stringify(bindings), { mode: 0o600 });
  };
  const reply = (id: any, error: string) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: error } }) + '\n',
    );
  const upstream = createInterface({ input: process.stdin });
  upstream.on('line', (line) => {
    try {
      const m = JSON.parse(line);
      if (m.method === 'session/new') {
        m.params = restrictedSession(m.params, runtime, file);
        pending.set(m.id, 'new');
      }
      if (['session/load', 'session/fork', 'session/resume'].includes(m.method))
        throw new Error('Cross-review session reuse is disabled');
      if (
        m.method === 'session/set_config_option' &&
        m.params?.configId === 'mode' &&
        !['read-only', 'dontAsk', 'default'].includes(m.params.value)
      )
        throw new Error('Review permissions cannot be expanded');
      if (m.method === 'session/set_mode') throw new Error('Review permissions are fixed');
      if (m.method === 'session/prompt' && !sessions.has(m.params?.sessionId))
        throw new Error('Unbound review session');
      if (m.method === 'session/prompt') {
        pending.set(m.id, `prompt:${m.params.sessionId}`);
        turns.set(m.params.sessionId, (turns.get(m.params.sessionId) ?? 0) + 1);
        binding(m.params.sessionId, true);
      }
      child.stdin.write(JSON.stringify(m) + '\n');
    } catch (e) {
      try {
        reply(JSON.parse(line).id, String(e));
      } catch {}
    }
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const m = JSON.parse(line);
      if (pending.get(m.id) === 'new' && m.result?.sessionId) {
        sessions.add(m.result.sessionId);
        pending.delete(m.id);
        binding(m.result.sessionId, false);
      }
      if (pending.get(m.id)?.startsWith('prompt:')) {
        const sessionId = pending.get(m.id)!.slice(7);
        const usage = promptUsageRecord(
          runtime.agent,
          runtime.matchId,
          sessionId,
          turns.get(sessionId)!,
          m.result,
          Date.now(),
        );
        if (usage)
          try {
            appendFileSync(
              join(runtime.directory, `${runtime.agent}.usage.jsonl`),
              JSON.stringify(usage) + '\n',
              { mode: 0o600 },
            );
          } catch {
            process.stderr.write('Mortal Kommit could not persist adapter usage.\n');
          }
        binding(sessionId, false);
        pending.delete(m.id);
      }
      if (m.method?.startsWith('fs/') || m.method?.startsWith('terminal/')) {
        child.stdin.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: m.id,
            error: {
              code: -32000,
              message:
                'Use the bounded snapshot tools; filesystem and terminal capabilities are disabled.',
            },
          }) + '\n',
        );
        return;
      }
      process.stdout.write(line + '\n');
    } catch {}
  });
  upstream.on('close', () => child.stdin.end());
  child.on('exit', (code) => process.exit(code ?? 1));
  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
    setTimeout(() => process.exit(0), 500).unref();
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  proxy(process.argv[2]).catch((e) => {
    process.stderr.write(String(e) + '\n');
    process.exit(1);
  });
