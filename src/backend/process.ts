import { spawn, type ChildProcess } from 'node:child_process';
export const owned = new Set<ChildProcess>();
export function terminate(child: ChildProcess) {
  try {
    if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}
export function run(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    max?: number;
    timeout?: number;
  } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    owned.add(child);
    let output = '',
      error = '',
      size = 0,
      failed = false;
    const fail = (e: Error) => {
      if (failed) return;
      failed = true;
      terminate(child);
      reject(e);
    };
    const timer = setTimeout(
      () => fail(new Error(`${command} timed out`)),
      options.timeout ?? 60000,
    );
    child.stdout!.on('data', (chunk) => {
      size += chunk.length;
      if (size > (options.max ?? 8 * 1024 * 1024))
        fail(new Error(`${command} output exceeds bounded limit`));
      else output += chunk.toString();
    });
    child.stderr!.on('data', (chunk) => {
      error = (error + chunk.toString()).slice(-12000);
    });
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      owned.delete(child);
      if (failed) return;
      if (code === 0) resolve(output);
      else reject(new Error(`${command} exited ${code}: ${error || output.slice(-2000)}`));
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(options.input ?? '');
  });
}
export function stopOwned() {
  for (const child of owned) terminate(child);
  owned.clear();
}
const gitArgs = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'diff.external=',
  '-c',
  'protocol.ext.allow=never',
];
export async function git(cwd: string, ...args: string[]) {
  return (await run('git', [...gitArgs, ...args], { cwd, timeout: 90000 })).trimEnd();
}
