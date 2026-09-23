// loads the plugin from this checkout in a headless claude session and fails when the engine refuses the hooks module.
// no credentials reach the session: the engine loads plugins and runs session.start before it needs auth, so the
// load is exercised and no model call is made. the session's own exit code is not the verdict, it always fails on auth.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = 'sift@inline';
// what the module registers under default options, only reachable if it loaded and its session.start ran
const tools = ['grade', 'judge', 'rank', 'status', 'watch', 'prune'].map((t) => `mcp__sift__${t}`);

function environment(home) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_') || k.startsWith('TYPESAFE_')) continue;
    env[k] = v;
  }
  return { ...env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' };
}

function events(stdout) {
  const out = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // non-json lines carry nothing the verdict reads
    }
  }
  return out;
}

function verdict(run, debug) {
  const failures = [];
  if (run.error) failures.push(`claude did not start: ${run.error.message}`);
  const init = events(run.stdout ?? '').find((e) => e.type === 'system' && e.subtype === 'init');
  if (!init) failures.push('no system/init event: the session never started');
  else {
    if (!(init.plugins ?? []).some((p) => p.source === plugin)) failures.push(`plugin ${plugin} is not in the session's plugins`);
    const server = (init.mcp_servers ?? []).find((s) => s.name === 'sift');
    if (server?.status !== 'connected') failures.push(`mcp server sift is ${server ? server.status : 'absent'}, so session.start did not register its tools`);
    const missing = tools.filter((t) => !(init.tools ?? []).includes(t));
    if (missing.length > 0) failures.push(`tools not registered: ${missing.join(', ')}`);
  }
  for (const line of debug.split('\n')) if (/\[ERROR\]/.test(line) && (line.includes(plugin) || line.includes(root) || /\bsift:/.test(line))) failures.push(`engine: ${line}`);
  for (const line of (run.stderr ?? '').split('\n')) if (/hooks module/.test(line)) failures.push(`stderr: ${line}`);
  return failures;
}

const home = mkdtempSync(join(tmpdir(), 'claude-load-smoke-'));
try {
  const debugFile = join(home, 'debug.log');
  const run = spawnSync(
    'claude',
    ['-p', '--plugin-dir', root, '--output-format', 'stream-json', '--verbose', '--debug-file', debugFile, 'Reply with the single word ok.'],
    { cwd: root, env: environment(home), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 },
  );
  const debug = existsSync(debugFile) ? readFileSync(debugFile, 'utf8') : '';
  const failures = verdict(run, debug);
  if (failures.length > 0) {
    console.error(`load smoke: FAIL (claude exit ${run.status}${run.signal ? `, signal ${run.signal}` : ''})`);
    for (const f of failures) console.error(`  ${f}`);
    process.exit(1);
  }
  console.log(`load smoke: ok, ${plugin} loaded and registered ${tools.join(', ')}`);
} finally {
  rmSync(home, { recursive: true, force: true });
}
