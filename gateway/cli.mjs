#!/usr/bin/env node

import { spawn } from 'node:child_process';

import { CodexAppServer, publicAuth, requireChatgptAccount } from './app-server.mjs';
import {
  ensureRuntimeState,
  loadConfig,
  sanitizedCodexEnvironment,
} from './config.mjs';

async function runInteractive(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: 'inherit' });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.signal || `exit ${result.code ?? 'unknown'}`}).`,
    );
  }
}

async function readIsolatedStatus(config, { refreshToken = true } = {}) {
  const appServer = new CodexAppServer(config);
  try {
    await appServer.start();
    const account = await appServer.readAccount({ refreshToken });
    requireChatgptAccount(account);
    await appServer.request('account/rateLimits/read');
    return {
      ready: account?.type === 'chatgpt',
      auth: publicAuth(account),
      ...(account?.type === 'apiKey' ? { rejectedAuthType: 'apiKey' } : {}),
      codexHome: config.codexHome,
    };
  } finally {
    await appServer.stop();
  }
}

async function setup(config) {
  const state = await ensureRuntimeState(config);
  process.stdout.write(
    `${JSON.stringify(
      {
        stateDirectory: config.stateDirectory,
        codexHome: config.codexHome,
        tokenFile: config.tokenFile,
        tokenCreated: state.created,
      },
      null,
      2,
    )}\n`,
  );
}

async function login(config) {
  await ensureRuntimeState(config);
  const environment = sanitizedCodexEnvironment(process.env, config);
  await runInteractive(config.codexBin, ['login', '--device-auth'], {
    cwd: config.workspaceDirectory,
    env: environment,
  });
  const status = await readIsolatedStatus(config, { refreshToken: true });
  requireChatgptAccount(status.auth.type === 'chatgpt' ? status.auth : null);
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

async function main() {
  if (!process.versions.node || Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('This gateway requires Node.js 22 or later.');
  }
  const config = loadConfig();
  const command = process.argv[2] || 'start';
  switch (command) {
    case 'setup':
      await setup(config);
      break;
    case 'login':
      await login(config);
      break;
    case 'status':
      await ensureRuntimeState(config);
      process.stdout.write(`${JSON.stringify(await readIsolatedStatus(config), null, 2)}\n`);
      break;
    case 'start': {
      const { startGateway } = await import('./server.mjs');
      await startGateway(config);
      break;
    }
    default:
      throw new Error(`Unknown command: ${command}. Expected setup, login, start, or status.`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message || String(error)}\n`);
  process.exitCode = 1;
});
