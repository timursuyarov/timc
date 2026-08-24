import fs from 'node:fs';
import path from 'node:path';
import { readText } from './io.js';
import { relPosix } from './paths.js';

const SKIP = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', '.vs', '.idea', '.timc', 'coverage', '.next', 'packages']);

/**
 * Deterministic stack detection — file markers only, no guessing and no LLM.
 * Commands are recorded as `unverified` until they have actually been run once.
 */
export function detectProject(codeRoot, { maxDepth = 3 } = {}) {
  const found = { csproj: [], sln: [], packageJson: [], migrations: [], compose: [], workflows: [], gomod: [], pyproject: [] };
  walk(codeRoot, 0);

  function walk(dir, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        if (e.name === 'Migrations') found.migrations.push(relPosix(codeRoot, abs));
        if (e.name === '.github') {
          const wf = path.join(abs, 'workflows');
          if (fs.existsSync(wf)) found.workflows.push(relPosix(codeRoot, wf));
          continue;
        }
        walk(abs, depth + 1);
        continue;
      }
      const rel = relPosix(codeRoot, abs);
      if (e.name.endsWith('.csproj')) found.csproj.push(rel);
      else if (e.name.endsWith('.sln')) found.sln.push(rel);
      else if (e.name === 'package.json') found.packageJson.push(rel);
      else if (/^docker-compose.*\.ya?ml$/.test(e.name)) found.compose.push(rel);
      else if (e.name === 'go.mod') found.gomod.push(rel);
      else if (e.name === 'pyproject.toml') found.pyproject.push(rel);
    }
  }

  const languages = [];
  if (found.csproj.length || found.sln.length) languages.push('csharp/dotnet');
  if (found.packageJson.length) languages.push('typescript/javascript');
  if (found.gomod.length) languages.push('go');
  if (found.pyproject.length) languages.push('python');

  const repos = submodules(codeRoot);
  const commands = {};
  const firstDotnet = found.sln[0] ?? found.csproj[0];
  if (firstDotnet) {
    const dir = path.posix.dirname(firstDotnet);
    const target = dir === '.' ? '' : ` ${dir}`;
    commands.build = `dotnet build${target}`;
    commands.test = `dotnet test${target}`;
  }
  const rootPkg = found.packageJson.find((p) => !p.includes('/'));
  if (rootPkg) {
    const pkg = JSON.parse(readText(path.join(codeRoot, rootPkg), '{}') ?? '{}');
    const scripts = pkg.scripts ?? {};
    if (scripts.build) commands.frontend_build = 'npm run build';
    if (scripts.test) commands.frontend_test = 'npm test';
    if (scripts.lint) commands.lint = 'npm run lint';
    if (scripts.typecheck) commands.typecheck = 'npm run typecheck';
    else if (fs.existsSync(path.join(codeRoot, 'tsconfig.json'))) commands.typecheck = 'npx tsc --noEmit';
  }

  const ruleFiles = [];
  for (const candidate of ['CLAUDE.md', 'AGENTS.md', '.claude/rules', '.cursorrules']) {
    const abs = path.join(codeRoot, candidate);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) {
      for (const f of walkShallow(abs, codeRoot)) ruleFiles.push(f);
    } else ruleFiles.push(candidate);
  }

  return {
    languages,
    repos,
    commands,
    migrations: found.migrations,
    ci: found.workflows,
    compose: found.compose,
    ruleFiles,
    conventionalCommits: usesConventionalCommits(codeRoot),
    markers: found,
  };
}

function walkShallow(dir, codeRoot, depth = 0, out = []) {
  if (depth > 2) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkShallow(abs, codeRoot, depth + 1, out);
    else if (e.name.endsWith('.md')) out.push(relPosix(codeRoot, abs));
  }
  return out;
}

function submodules(codeRoot) {
  const text = readText(path.join(codeRoot, '.gitmodules'), null);
  if (!text) return [];
  return [...text.matchAll(/^\s*path\s*=\s*(.+)$/gm)].map((m) => m[1].trim());
}

function usesConventionalCommits(codeRoot) {
  const log = readText(path.join(codeRoot, '.git', 'COMMIT_EDITMSG'), '') ?? '';
  return /^(feat|fix|chore|refactor|docs|test|perf|build|ci)(\(.+\))?!?:/m.test(log);
}
