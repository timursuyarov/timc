import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const CLI = path.join(ROOT, 'src', 'cli.js');
const TMP = path.join(ROOT, 'test', '.tmp');

/**
 * Run the CLI exactly as a shell (or a hook) would. By default it is the
 * user's own terminal; `agent: true` runs it the way Claude Code's Bash tool
 * does (CLAUDECODE=1), where user decisions need --quote.
 */
export function timc(cwd, args, { stdin = '', agent = false, env: extra = {} } = {}) {
  const env = { ...process.env, NO_COLOR: '1', TIMC_DEBUG: '1' };
  delete env.CLAUDECODE;
  delete env.OPENROUTER_API_KEY;
  delete env.TYPESAFE_API_KEY;
  if (agent) env.CLAUDECODE = '1';
  Object.assign(env, extra);
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    input: stdin,
    windowsHide: true,
    env,
  });
  return { code: res.status, out: res.stdout ?? '', err: res.stderr ?? '', json: tryJson(res.stdout) };
}

function tryJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function git(cwd, args) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return (res.stdout ?? '').trim();
}

/** A throwaway code repository with one commit, so HEAD exists. */
export function makeRepo(name) {
  const dir = path.join(TMP, `${name}-${process.pid}-${Math.abs(hash(name))}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'index.js'), 'export const one = 1;\n');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --version' } }, null, 2));
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture']);
  return dir;
}

export function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ }
}

export function readEvents(dir) {
  const f = path.join(dir, '.timc', 'runtime', 'events.ndjson');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

export function eventTypes(dir) {
  return readEvents(dir).map((e) => e.type);
}

/**
 * A PostToolUse payload shaped like the real hook input.
 * @param {string} command
 * @param {{cwd?: string, failed?: boolean}} [opts]
 */
export function bashHookPayload(command, { cwd, failed = false } = {}) {
  return JSON.stringify({
    session_id: 'test-session',
    cwd,
    hook_event_name: failed ? 'PostToolUseFailure' : 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_test',
    tool_input: { command },
    tool_output: 'ok',
  });
}

/**
 * @param {string} filePath
 * @param {{cwd?: string, agentId?: string}} [opts]
 */
export function bashGuardPayload(command, { cwd, agentId = undefined } = {}) {
  return JSON.stringify({
    session_id: 'test-session',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_use_id: 'toolu_test',
    agent_id: agentId,
    tool_input: { command },
  });
}

export function promptPayload(prompt, { cwd } = {}) {
  return JSON.stringify({ session_id: 'test-session', cwd, hook_event_name: 'UserPromptSubmit', prompt, prompt_id: 'p-1' });
}

export function writeHookPayload(filePath, { cwd, agentId = undefined } = {}) {
  return JSON.stringify({
    session_id: 'test-session',
    cwd,
    hook_event_name: 'PreToolUse',
    tool_name: 'Write',
    tool_use_id: 'toolu_test',
    agent_id: agentId,
    agent_type: agentId ? 'backend-implementer' : undefined,
    tool_input: { file_path: filePath },
  });
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
