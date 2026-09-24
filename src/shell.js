/**
 * Just enough POSIX shell parsing for the Bash guard: split a command line
 * into simple commands and find the files each one writes. It is a heuristic,
 * not an interpreter — the goal is that the obvious ways to write a file
 * (redirects, tee, sed -i, cp/mv, rm, bash -c "...") are all visible to the
 * same rules the Write/Edit guard applies.
 */

const SEPARATORS = new Set([';', '&&', '||', '|', '&', '\n']);

/**
 * @param {string} input
 * @returns {{type: 'word'|'op', value: string}[]}
 */
export function tokenize(input) {
  const s = String(input ?? '');
  /** @type {{type: 'word'|'op', value: string}[]} */
  const out = [];
  let word = '';
  let inWord = false;
  const flush = () => {
    if (inWord) out.push({ type: 'word', value: word });
    word = '';
    inWord = false;
  };

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '\n') { i += 1; continue; } // line continuation
      word += s[i + 1]; inWord = true; i += 1; continue;
    }
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      word += end === -1 ? s.slice(i + 1) : s.slice(i + 1, end);
      inWord = true;
      i = end === -1 ? s.length : end;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < s.length && s[j] !== '"'; j += 1) {
        if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) { word += s[j + 1]; j += 1; } else word += s[j];
      }
      inWord = true;
      i = j;
      continue;
    }
    if (ch === '#' && !inWord) {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl - 1;
      continue;
    }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      flush();
      const two = s.slice(i, i + 2);
      if (two === '&&' || two === '||') { out.push({ type: 'op', value: two }); i += 1; continue; }
      if (two === '&>') {
        const three = s.slice(i, i + 3);
        out.push({ type: 'op', value: three === '&>>' ? '>>' : '>' });
        i += three === '&>>' ? 2 : 1;
        continue;
      }
      out.push({ type: 'op', value: ch });
      continue;
    }
    if (ch === '>' || ch === '<') {
      // A bare fd number glued to the operator ("2>") belongs to the operator.
      if (inWord && /^\d+$/.test(word)) { word = ''; inWord = false; } else flush();
      if (ch === '<') {
        if (s.slice(i, i + 2) === '<<') { out.push({ type: 'op', value: '<<' }); i += 1; } else out.push({ type: 'op', value: '<' });
        continue;
      }
      if (s[i + 1] === '&') { i += 2; while (i < s.length && /[\d-]/.test(s[i])) i += 1; i -= 1; continue; } // 2>&1: fd dup, no file
      if (s[i + 1] === '>') { out.push({ type: 'op', value: '>>' }); i += 1; } else if (s[i + 1] === '|') { out.push({ type: 'op', value: '>' }); i += 1; } else out.push({ type: 'op', value: '>' });
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { flush(); continue; }
    word += ch;
    inWord = true;
  }
  flush();
  return out;
}

/**
 * Split tokens into simple commands; redirect targets are pulled out.
 * @returns {{words: string[], redirects: string[]}[]}
 */
export function simpleCommands(input) {
  const cmds = [];
  let cur = { words: [], redirects: [] };
  const toks = tokenize(input);
  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    if (t.type === 'op' && SEPARATORS.has(t.value)) {
      if (cur.words.length || cur.redirects.length) cmds.push(cur);
      cur = { words: [], redirects: [] };
    } else if (t.type === 'op' && (t.value === '>' || t.value === '>>')) {
      const next = toks[i + 1];
      if (next?.type === 'word') { cur.redirects.push(next.value); i += 1; }
    } else if (t.type === 'op' && (t.value === '<' || t.value === '<<')) {
      if (toks[i + 1]?.type === 'word') i += 1; // input only
    } else if (t.type === 'word') {
      cur.words.push(t.value);
    }
  }
  if (cur.words.length || cur.redirects.length) cmds.push(cur);
  return cmds;
}

const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'time', 'xargs', 'nice']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

/** Drop `FOO=bar`, `env -u X`, `sudo` and friends in front of the real program. */
export function stripPrefix(words) {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) { i += 1; continue; }
    if (w === 'env') {
      i += 1;
      while (words[i] !== undefined && (words[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]))) {
        if (words[i] === '-u' || words[i] === '--unset') i += 1;
        i += 1;
      }
      continue;
    }
    if (WRAPPERS.has(w)) { i += 1; continue; }
    break;
  }
  return words.slice(i);
}

const operands = (args) => args.filter((a) => !a.startsWith('-') || a === '-');

/** Files a single simple command writes, by program. */
function programTargets(words) {
  const [prog0, ...args] = stripPrefix(words);
  if (!prog0) return [];
  const prog = prog0.split('/').pop();

  if (SHELLS.has(prog)) {
    const c = args.indexOf('-c');
    return c !== -1 && args[c + 1] !== undefined ? bashWriteTargets(args[c + 1]) : [];
  }
  switch (prog) {
    case 'tee': return operands(args);
    case 'sed':
    case 'perl': {
      const inPlace = args.some((a) => /^(-i|--in-place)/.test(a) || (prog === 'perl' && /^-\w*i/.test(a)));
      if (!inPlace) return [];
      const hasScriptFlag = args.some((a) => a === '-e' || a === '-f' || a === '--expression');
      const ops = [];
      for (let k = 0; k < args.length; k += 1) {
        const a = args[k];
        if (a === '-e' || a === '-f' || a === '--expression') { k += 1; continue; }
        if (a.startsWith('-')) continue;
        ops.push(a);
      }
      return hasScriptFlag ? ops : ops.slice(1);
    }
    case 'cp':
    case 'mv':
    case 'install':
    case 'ln':
    case 'rsync': {
      const ops = operands(args);
      const t = args.indexOf('-t');
      if (t !== -1 && args[t + 1]) return [args[t + 1]];
      return ops.length > 1 ? [ops[ops.length - 1]] : [];
    }
    case 'rm':
    case 'rmdir':
    case 'touch':
    case 'truncate':
    case 'mkdir':
    case 'chmod':
    case 'unlink':
    case 'shred':
      return operands(args).filter((a) => !/^\d+$/.test(a) && !/^[ugoa]*[+-=][rwxX]+$/.test(a));
    case 'dd':
      return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
    default:
      return [];
  }
}

/**
 * Every path the command line would write to, as written (unresolved).
 * @param {string} command
 * @returns {string[]}
 */
export function bashWriteTargets(command) {
  const out = [];
  for (const cmd of simpleCommands(command)) {
    out.push(...cmd.redirects);
    out.push(...programTargets(cmd.words));
  }
  return [...new Set(out.filter((p) => p && p !== '/dev/null' && p !== '-' && !p.startsWith('/dev/')))];
}

/** The command line with quoting removed and whitespace collapsed, for substring rules. */
export function canonicalCommand(command) {
  return simpleCommands(command)
    .map((c) => [...c.words, ...c.redirects.map((r) => `> ${r}`)].join(' '))
    .join(' ; ')
    .toLowerCase();
}

/**
 * The `timc` subcommands a command line invokes (via `timc`, `bin/timc`, or `node …/cli.js`).
 * @returns {{sub: string, args: string[]}[]}
 */
export function timcInvocations(command) {
  const found = [];
  const scan = (cmdLine) => {
    for (const cmd of simpleCommands(cmdLine)) {
      const words = stripPrefix(cmd.words);
      const prog = (words[0] ?? '').split('/').pop();
      if (SHELLS.has(prog)) {
        const c = words.indexOf('-c');
        if (c !== -1 && words[c + 1] !== undefined) scan(words[c + 1]);
        continue;
      }
      let rest = null;
      if (prog === 'timc' || prog === 'timc.cmd') rest = words.slice(1);
      else if ((prog === 'node' || prog === 'npx') && words.slice(1).some((w) => /(^|\/)(cli\.js|timc)$/.test(w))) {
        const at = words.findIndex((w, k) => k > 0 && /(^|\/)(cli\.js|timc)$/.test(w));
        rest = words.slice(at + 1);
      }
      if (rest) {
        const sub = rest.find((w) => !w.startsWith('-')) ?? '';
        found.push({ sub, args: rest });
      }
    }
  };
  scan(command);
  return found;
}
