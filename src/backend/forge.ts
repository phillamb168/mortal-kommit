import { run } from './process.js';

export function parseMr(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('MR URL must use HTTP(S)');
  const m = url.pathname.match(/^\/(.+)\/-\/merge_requests\/(\d+)\/?$/);
  if (!m || url.username || url.password) throw new Error('Expected a GitLab merge-request URL');
  return { host: url.host, project: decodeURIComponent(m[1]), iid: m[2] };
}
export function remoteMatches(remote: string, host: string, project: string, sshHost?: string) {
  try {
    const normalized = remote.replace(/^([^@/]+@)?([^:/]+):(?=[^/])/, 'ssh://$1$2/');
    const url = new URL(normalized);
    const allowedHost =
      url.host.toLowerCase() === host.toLowerCase() ||
      (url.protocol === 'ssh:' && !!sshHost && url.host.toLowerCase() === sshHost.toLowerCase());
    return (
      ['https:', 'http:', 'ssh:'].includes(url.protocol) &&
      allowedHost &&
      decodeURIComponent(url.pathname)
        .replace(/^\//, '')
        .replace(/\/$/, '')
        .replace(/\.git$/, '') === project
    );
  } catch {
    return false;
  }
}
export async function gitlabRemoteMatches(remote: string, host: string, project: string) {
  if (remoteMatches(remote, host, project)) return true;
  // The operator's global glab config is the authority for a separate SSH host.
  // Do not guess aliases, trust MR text, or read repository-local configuration.
  const sshHost = (
    await run('glab', ['config', 'get', 'ssh_host', '--host', host, '--global'], {
      timeout: 10000,
      max: 4096,
    }).catch(() => '')
  ).trim();
  if (!sshHost) return false;
  try {
    const url = new URL(`ssh://${sshHost}`);
    if (url.host.toLowerCase() !== sshHost.toLowerCase()) throw new Error();
  } catch {
    throw new Error('Invalid SSH hostname in the global glab configuration');
  }
  return remoteMatches(remote, host, project, sshHost);
}

export function parsePr(value: string) {
  const url = new URL(value);
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    !match ||
    match.slice(1, 3).some((s) => s === '.' || s === '..')
  )
    throw new Error(
      'Expected an HTTPS GitHub pull-request URL: https://github.com/owner/repo/pull/123',
    );
  return {
    host: url.host,
    project: `${match[1]}/${match[2]}`,
    number: match[3],
    url: `https://${url.host}/${match[1]}/${match[2]}/pull/${match[3]}`,
  };
}
export function githubRemoteMatches(remote: string, host: string, project: string) {
  // GitHub owner/repository names are case-insensitive. Host aliases are not guessed.
  return remoteMatches(remote.toLowerCase(), host.toLowerCase(), project.toLowerCase());
}
export interface ReviewSelection {
  base?: string;
  mr?: string;
  pr?: string;
}
export function validateSelection(options: ReviewSelection) {
  if ([options.base, options.mr, options.pr].filter((v) => v !== undefined).length > 1)
    throw new Error('Choose exactly one review scope: --base, --mr, or --pr.');
  if (options.mr !== undefined) parseMr(options.mr);
  if (options.pr !== undefined) parsePr(options.pr);
}
export async function reviewRemoteMatches(remote: string, options: ReviewSelection) {
  validateSelection(options);
  if (options.pr) {
    const p = parsePr(options.pr);
    return githubRemoteMatches(remote, p.host, p.project);
  }
  if (options.mr) {
    const p = parseMr(options.mr);
    return gitlabRemoteMatches(remote, p.host, p.project);
  }
  return true;
}
