import { spawn } from 'node:child_process';
import { chmod, cp, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const LABEL = 'com.mathreader.codex-gateway';
const xml = (value) => String(value).replace(/[<>&"']/g, (c) => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
}[c]));
const shellQuote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.stderr.on('data', (data) => { output += data; });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output.trim())
      : reject(new Error(`${command} failed (${code}): ${output.slice(-2000)}`)));
  });
}

async function exists(path) {
  try { await stat(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// launchd must be able to read the runtime, working directory and logs without
// Documents/Desktop privacy permissions. Keep its entire installation here.
export async function installMacService(config) {
  if (process.platform !== 'darwin') throw new Error('install-service requires macOS.');
  const base = join(homedir(), 'Library', 'Application Support', 'math-reader-codex');
  const runtime = join(base, 'runtime');
  const state = join(base, 'state');
  const agents = join(homedir(), 'Library', 'LaunchAgents');
  const plist = join(agents, `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  const service = `${domain}/${LABEL}`;
  await mkdir(base, { recursive: true, mode: 0o700 });
  await mkdir(agents, { recursive: true });

  const origin = await run('git', ['remote', 'get-url', 'origin'], config.gatewayDirectory);
  if (!await exists(runtime)) {
    await run('git', ['clone', '--', origin, runtime], base);
  } else {
    const installedOrigin = await run('git', ['remote', 'get-url', 'origin'], runtime);
    if (installedOrigin !== origin) throw new Error('The installed gateway belongs to a different repository.');
    if (await run('git', ['status', '--porcelain', '--untracked-files=no'], runtime)) {
      throw new Error('The installed gateway has local changes. Preserve them before reinstalling.');
    }
  }

  // Reinstalling the launcher leaves a running managed service alone. Before
  // migrating an older installation, require its generation/login to be idle.
  const tokenFile = await exists(join(state, 'gateway-token')) ? join(state, 'gateway-token') : config.tokenFile;
  if (await exists(tokenFile)) {
    try {
      const token = (await readFile(tokenFile, 'utf8')).trim();
      const response = await fetch(`http://127.0.0.1:${config.port}/v1/status`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('A gateway is running with a different access token; its service was left unchanged.');
      const status = await response.json();
      const installedDirectory = await run('/usr/bin/plutil', ['-extract', 'WorkingDirectory', 'raw', '-o', '-', plist]).catch(() => '');
      if (installedDirectory === join(runtime, 'gateway')) {
        await installMacLauncher(base, plist, service, domain);
        process.stdout.write('Gateway launcher installed; the running service was preserved.\n');
        return;
      }
      if (status.requests?.active !== 0 || status.login?.status === 'pending') {
        throw new Error('Wait for the active gateway requests or ChatGPT authorization to finish, then run install-service again.');
      }
    } catch (error) {
      if (error.cause?.code !== 'ECONNREFUSED') throw error;
    }
  }

  await run('git', ['pull', '--ff-only'], runtime);
  const npm = process.env.npm_execpath;
  await run(npm ? process.execPath : 'npm',
    npm ? [npm, 'ci', '--no-audit', '--no-fund'] : ['ci', '--no-audit', '--no-fund'], join(runtime, 'gateway'));

  // Homebrew's stable symlink survives Node upgrades that remove the Cellar
  // version directory returned by process.execPath.
  const pathNode = await run('/usr/bin/which', ['node']).catch(() => process.execPath);
  const node = await realpath(pathNode) === await realpath(process.execPath) ? pathNode : process.execPath;
  const environment = {
    PATH: [dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('MATH_READER_GATEWAY_'))),
    MATH_READER_GATEWAY_STATE_DIR: state,
  };
  environment.MATH_READER_GATEWAY_TOKEN_FILE = join(state, 'gateway-token');
  const servicePlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(join(runtime, 'gateway', 'cli.mjs'))}</string><string>start</string></array>
<key>WorkingDirectory</key><string>${xml(join(runtime, 'gateway'))}</string>
<key>EnvironmentVariables</key><dict>${Object.entries(environment).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(state, 'gateway.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(state, 'gateway-error.log'))}</string>
</dict></plist>`;
  await installMacLauncher(base, plist, service, domain);
  const previousPlist = await exists(plist) ? await readFile(plist) : null;
  if (previousPlist) await writeFile(join(base, 'previous-launch-agent.plist'), previousPlist, { mode: 0o600 });
  const loaded = await run('/bin/launchctl', ['print', service]).then(() => true, () => false);
  if (loaded) await run('/bin/launchctl', ['bootout', service]);
  try {
    // Move a complete copy into place. A failed copy cannot leave an apparently
    // installed state directory with only part of the user's credentials.
    if (!await exists(state) && await exists(config.stateDirectory)) {
      const temporaryState = join(base, `state-migration-${process.pid}`);
      await cp(config.stateDirectory, temporaryState, { recursive: true, errorOnExist: true, force: false });
      await rename(temporaryState, state);
    }
    await mkdir(state, { recursive: true, mode: 0o700 });
    await chmod(state, 0o700);
    if (!await exists(join(state, 'gateway-token')) && await exists(config.tokenFile)) {
      await cp(config.tokenFile, join(state, 'gateway-token'), { errorOnExist: true, force: false });
    }
    await writeFile(plist, servicePlist, { mode: 0o600 });
    await run('/bin/launchctl', ['enable', service]);
    await run('/bin/launchctl', ['bootstrap', domain, plist]);
  } catch (error) {
    if (previousPlist) {
      await writeFile(plist, previousPlist, { mode: 0o600 });
      if (loaded) await run('/bin/launchctl', ['bootstrap', domain, plist]).catch(() => {});
    }
    throw error;
  }
  process.stdout.write(`Gateway service installed. Token file: ${join(state, 'gateway-token')}\n`);
}

export async function installMacLauncher(base, plist, service, domain) {
  const app = join(base, 'math-reader-codex.app');
  // The URL carries no commands, paths, token or login data. An existing process
  // is left running, so opening the launcher cannot interrupt a generation.
  const command = `/bin/launchctl enable ${shellQuote(service)}; ` +
    `/bin/launchctl print ${shellQuote(service)} >/dev/null 2>&1 || ` +
    `/bin/launchctl bootstrap ${shellQuote(domain)} ${shellQuote(plist)}; ` +
    `/bin/launchctl kickstart ${shellQuote(service)}`;
  const script = `on run
  do shell script ${JSON.stringify(command)}
end run
on open location address
  if address is "math-reader-codex://gateway/start" then
    do shell script ${JSON.stringify(command)}
  end if
end open location`;
  await run('/usr/bin/osacompile', ['-o', app, '-e', script]);
  const info = join(app, 'Contents', 'Info.plist');
  await run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'com.mathreader.codex-gateway-launcher', info]);
  await run('/usr/bin/plutil', ['-replace', 'CFBundleName', '-string', 'math-reader-codex', info]);
  await run('/usr/bin/plutil', ['-replace', 'LSUIElement', '-bool', 'true', info]);
  await run('/usr/bin/plutil', ['-replace', 'CFBundleURLTypes', '-json', JSON.stringify([
    { CFBundleURLName: 'com.mathreader.codex-gateway-launcher', CFBundleURLSchemes: ['math-reader-codex'] },
  ]), info]);
  await run('/usr/bin/codesign', ['--force', '--sign', '-', app]);
  await run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', app]);
}
