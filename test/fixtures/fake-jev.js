// A stand-in for Jev's /v1/systemone endpoint, run as its own process so the
// CLI (spawned synchronously by the tests) can reach it. Prints the port, then
// appends every request it receives to the log file given as argv[2].
import http from 'node:http';
import fs from 'node:fs';

const log = process.argv[2];

function answer(name, q, state) {
  // Quote questions are judged on the user's words only, not on the claim.
  const s = String(state?.what_the_user_actually_wrote ?? JSON.stringify(state)).toLowerCase();
  if (q.type === 'noul') {
    if (name === 'supports') return { type: 'noul', noul: /not sure|hmm|wait|no\b/.test(s) ? 0.03 : /maybe/.test(s) ? 0.5 : 0.96 };
    if (name === 'vertical') return { type: 'noul', noul: /repository|layer/.test(s) ? 0.08 : 0.9 };
    if (name === 'exercises') return { type: 'noul', noul: /--version|build/.test(s) ? 0.1 : 0.9 };
    return { type: 'noul', noul: 0.5 };
  }
  if (name === 'kind') return { type: 'choice', choice: /not sure|hmm/.test(s) ? 'unsure' : 'approves', confidence: 0.9 };
  if (name === 'track') {
    if (/ledger/.test(s)) return { type: 'choice', choice: 'high_risk', confidence: 0.92 };
    if (/refund/.test(s)) return { type: 'choice', choice: 'trivial', confidence: 0.99 }; // never allowed to lower
    return { type: 'choice', choice: 'standard', confidence: 0.4 };
  }
  return { type: q.type };
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    fs.appendFileSync(log, `${JSON.stringify({ url: req.url, auth: req.headers.authorization, body: parsed })}\n`);
    const answers = Object.fromEntries(Object.entries(parsed.questions ?? {}).map(([k, q]) => [k, answer(k, q, parsed.state)]));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'fake-1', model: `${parsed.model}-test`, provider: 'TypeSafe', answers, usage: { cost: 0.00002 } }));
  });
});
server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
