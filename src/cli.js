#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { once } from 'node:events';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, version } from './server.js';
import { createHttpMcp } from './http.js';
import { createRequester, UserError } from './net.js';
import { createSam } from './sam.js';
import { createAwards } from './awards.js';
import { createDemo } from './demo.js';
import { createIntelligence } from './intelligence.js';
import { createPipeline, dataDirectory } from './storage.js';
import { accountUrl, createCredentials } from './credentials.js';

const HELP = `Federal Procurement Intelligence

  sam-procurement-mcp [--demo]                     Start the local stdio MCP server
  sam-procurement-mcp setup                        Validate and securely save or replace your SAM.gov key
  sam-procurement-mcp validate-key                 Validate the current SAM.gov credential
  sam-procurement-mcp doctor [--demo] [--live]       Check setup and optionally contact data sources
  sam-procurement-mcp serve-http [--demo] [--port 3847]
                                                  Start a read-only MCP endpoint on 127.0.0.1
  sam-procurement-mcp forget-key                   Remove the local SAM.gov credential
  sam-procurement-mcp --version                    Show the installed version
`;

function promptForKey() {
  if (!process.stdin.isTTY) {
    throw new UserError('Open a local terminal and run sam-procurement-mcp setup. The key prompt requires an interactive terminal.');
  }
  const muted = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const prompt = createInterface({ input: process.stdin, output: muted, terminal: true, historySize: 0 });
  process.stderr.write('SAM.gov public API key (input hidden): ');
  return new Promise((resolve) => {
    prompt.once('close', () => {
      process.stdin.unref?.();
      process.stderr.write('\n');
      resolve('');
    });
    prompt.once('SIGINT', () => prompt.close());
    prompt.question('', (answer) => {
      resolve(answer.trim());
      prompt.close();
    });
  });
}

async function doctor(app, live) {
  const { awards, demo, sam, intelligence, home } = app;
  console.log(`Federal Procurement Intelligence ${version}\nMode: ${demo ? 'synthetic demo' : 'live'}\nLocal data: ${home}`);
  const status = demo ? null : await sam.status(live);
  console.log(`SAM.gov: ${demo ? 'synthetic demo' : status.samConnectionStatus}`);
  if (status?.samCredentialSource) console.log(`Credential source: ${status.samCredentialSource}`);
  if (status?.samSetupError) console.error(status.samSetupError);
  console.log(`USAspending: ${demo ? 'synthetic demo' : 'public, no key required'}`);
  if (!live) return;
  if (status?.samSetupError) process.exitCode = 1;
  if (demo) {
    await intelligence.search({ naics: '541512', limit: 1 });
    console.log('SAM.gov demo check passed.');
  }
  await awards({ naics: '541512' }, new Date(), { limit: 1 });
  console.log(`USAspending: ${demo ? 'demo check passed' : 'request succeeded'}`);
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' }, demo: { type: 'boolean' },
      live: { type: 'boolean' }, port: { type: 'string' } }
  });
  const [command = 'stdio'] = positionals;
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(version);
    return;
  }
  if (positionals.length > 1 || !['stdio', 'serve-http', 'doctor', 'setup', 'validate-key', 'forget-key'].includes(command) ||
      (values.live && command !== 'doctor') || (values.port !== undefined && command !== 'serve-http')) {
    throw new UserError('Unknown command or option combination. Run with --help.');
  }
  const home = dataDirectory();
  const credentials = createCredentials(home);
  const request = createRequester();
  const liveSam = createSam(request, credentials.read);
  if (command === 'setup') {
    console.log(`Get a personal public API key from SAM.gov Account Details.\n${accountUrl}`);
    console.log(`Setup validates the key before saving it with ${credentials.storageName}.`);
    const key = await promptForKey();
    if (!key) throw new UserError('Setup canceled.');
    await credentials.save(key, (candidate) => liveSam.verify({ key: candidate }));
    console.log('SAM.gov accepted the key. It is saved securely for your next SAM.gov request.');
    if (process.env.SAM_GOV_API_KEY?.trim()) {
      console.log('Remove the active SAM_GOV_API_KEY environment override to use the newly saved key.');
    }
    return;
  }
  if (command === 'validate-key') {
    const status = await liveSam.status(true);
    if (status.samSetupError) throw new UserError(status.samSetupError);
    console.log(`SAM.gov accepted the credential from ${status.samCredentialSource}.`);
    return;
  }
  if (command === 'forget-key') {
    await credentials.remove();
    console.log('Removed the local SAM.gov key. Public USAspending tools remain available.');
    if (process.env.SAM_GOV_API_KEY?.trim()) console.log('The SAM_GOV_API_KEY environment override is still active.');
    return;
  }

  const demo = Boolean(values.demo || /^(1|true)$/i.test(process.env.SAM_MCP_DEMO ?? ''));
  const adapters = demo ? createDemo() : { sam: liveSam, awards: createAwards(request) };
  const intelligence = createIntelligence({ ...adapters, demo });
  const app = { home, demo, ...adapters, intelligence };
  if (command === 'doctor') return doctor(app, values.live);

  if (command === 'serve-http') {
    const portText = values.port ?? '3847';
    const port = Number(portText);
    if (!/^\d{1,5}$/.test(portText) || port < 1024 || port > 65535) {
      throw new UserError('Choose a port between 1024 and 65535.');
    }
    const http = createHttpMcp(() => createServer(app));
    http.maxConnections = 32;
    const listening = once(http, 'listening');
    http.listen(port, '127.0.0.1');
    await listening;
    console.error(`Federal Procurement Intelligence listening at http://127.0.0.1:${port}/mcp (${demo ? 'demo' : 'read-only'})`);
    return;
  }
  const server = createServer({ ...app, pipeline: createPipeline(home, demo) });
  await server.connect(new StdioServerTransport());
}

try {
  await main();
} catch (error) {
  const message = error instanceof UserError ? error.message :
    error.code === 'EADDRINUSE' ? 'Port is already in use. Choose another with --port.' :
    error.code?.startsWith('ERR_PARSE_ARGS') ? 'Invalid arguments. Run with --help.' :
    'Could not start or access local data. Check file permissions and run with --help.';
  console.error(`sam-procurement-mcp: ${message}`);
  process.exitCode = 1;
}
