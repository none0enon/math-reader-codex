import { fork, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `npm start` runs this supervisor. It keeps the gateway process running and
// installs new gateway commits from the checkout's upstream branch, so later
// fixes take effect without anyone touching the gateway computer.
const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const RESTART_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];
const FIRST_UPDATE_CHECK_MS = 60_000;
const UPDATE_INTERVAL_MS = 10 * 60_000;
// A gateway that fails this soon after an update is rolled back.
const UPDATE_PROBATION_MS = 60_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function run(command, args, cwd, timeoutMs = 120_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${command} ${args.join(' ')} failed (${signal || `exit ${code}`}): ${output.trim().slice(-500)}`));
    });
  });
}

function npmCi(cwd) {
  // `npm start` exposes the npm CLI it runs under; fall back to npm on PATH.
  const args = ['ci', '--no-audit', '--no-fund'];
  const npm = process.env.npm_execpath;
  return npm ? run(process.execPath, [npm, ...args], cwd, 15 * 60_000) : run('npm', args, cwd, 15 * 60_000);
}

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', resolve));
}

// The gateway answers from its own event loop, so "idle, stopping now" is
// decided atomically there; no reply in time counts as busy.
function ask(child, type) {
  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      resolve(value);
    };
    const onMessage = (message) => {
      if (message?.type === `${type}:reply`) finish(message.accepted === true);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), 5_000);
    child.on('message', onMessage);
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
    else if (!child.connected) finish(false);
    else child.send({ type }, () => {});
  });
}

async function terminate(child, timeoutMs) {
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  await exited(child);
  clearTimeout(timer);
}

export async function supervise(config) {
  const log = (line) => process.stdout.write(`[supervisor] ${line}\n`);
  let lastNotice = '';
  const notice = (line) => {
    if (line !== lastNotice) log(line);
    lastNotice = line;
  };
  const git = (args) => run('git', args, config.gatewayDirectory);
  let child = null;
  let startedAt = 0;
  let failures = 0;
  let stopping = false;
  let updating = false;
  let probation = null;
  let updateTimer = null;
  // Upstream commits that failed to install or start are not retried.
  const rejected = new Set();

  async function rollback() {
    const { previous, target, lockChanged } = probation;
    probation = null;
    rejected.add(target);
    log(`Gateway ${target.slice(0, 7)} exited right after updating; returning to ${previous.slice(0, 7)}.`);
    await git(['reset', '--keep', previous]);
    if (lockChanged) await npmCi(config.gatewayDirectory);
  }

  function start() {
    startedAt = Date.now();
    const current = fork(CLI, ['serve'], { stdio: 'inherit' });
    child = current;
    current.once('exit', (code, signal) => {
      if (child !== current || stopping || updating) return;
      void (async () => {
        // A process killed from outside says nothing about the new version.
        if (probation && code && Date.now() - startedAt < UPDATE_PROBATION_MS) {
          await rollback().catch((error) => log(`Rollback failed: ${error.message}`));
        } else {
          probation = null;
          failures = Date.now() - startedAt > 5 * 60_000 ? 1 : failures + 1;
          const wait = RESTART_DELAYS_MS[Math.min(failures, RESTART_DELAYS_MS.length) - 1];
          log(`Gateway exited (${signal || `code ${code}`}); restarting in ${wait / 1000} s.`);
          await delay(wait);
        }
        if (!stopping && child === current) start();
      })();
    });
  }

  async function checkForUpdate() {
    try {
      await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    } catch {
      log('Auto-update is off: this directory is not a git checkout with an upstream branch.');
      return false;
    }
    await git(['fetch', '--quiet']);
    const [head, target] = (await git(['rev-parse', 'HEAD', '@{u}'])).split('\n');
    if (head === target || rejected.has(target)) return true;
    // Paths relative to gateway/; changes elsewhere in the repository are ignored.
    const changed = await git(['diff', '--name-only', '--relative', head, target]);
    if (!changed) return true;
    try {
      await git(['merge-base', '--is-ancestor', head, target]);
    } catch {
      notice('Auto-update skipped: this checkout has local commits.');
      return true;
    }
    if (await git(['status', '--porcelain', '--untracked-files=no'])) {
      notice('Auto-update skipped: this checkout has local changes.');
      return true;
    }
    // Install only while no generation or device-code sign-in is in progress.
    while (!stopping && !(await ask(child, 'idle'))) await delay(5_000);
    if (stopping) return false;
    log(`Updating the gateway to ${target.slice(0, 7)}.`);
    await git(['merge', '--ff-only', '--quiet', target]);
    const lockChanged = /^package(?:-lock)?\.json$/m.test(changed);
    if (lockChanged) {
      try {
        await npmCi(config.gatewayDirectory);
      } catch (error) {
        log(`Installing dependencies failed; staying on ${head.slice(0, 7)}. ${error.message}`);
        rejected.add(target);
        await git(['reset', '--keep', head]);
        await npmCi(config.gatewayDirectory).catch((restoreError) => log(`Restoring dependencies failed: ${restoreError.message}`));
        return true;
      }
    }
    probation = { previous: head, target, lockChanged };
    updating = true;
    try {
      // The gateway refuses while busy and keeps serving until it accepts.
      while (!stopping && !(await ask(child, 'restart'))) await delay(5_000);
      await exited(child);
    } finally {
      updating = false;
    }
    if (!stopping) start();
    return true;
  }

  function schedule(ms) {
    updateTimer = setTimeout(async () => {
      let again = true;
      try {
        again = await checkForUpdate();
      } catch (error) {
        notice(`Auto-update check failed: ${error.message}`);
      }
      if (again && !stopping) schedule(UPDATE_INTERVAL_MS);
    }, ms);
  }

  async function stop() {
    if (stopping) return;
    stopping = true;
    clearTimeout(updateTimer);
    // Ctrl+C reaches the gateway directly; a plain SIGTERM is forwarded.
    if (child) await terminate(child, 10_000);
    process.exit(0);
  }
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());

  start();
  if (process.env.MATH_READER_GATEWAY_AUTO_UPDATE === '0') {
    log('Auto-update is off (MATH_READER_GATEWAY_AUTO_UPDATE=0).');
  } else {
    log('Auto-update is on: new gateway commits from the upstream branch are installed while the gateway is idle.');
    schedule(FIRST_UPDATE_CHECK_MS);
  }
  await new Promise(() => {});
}
