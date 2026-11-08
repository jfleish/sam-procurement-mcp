import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer as reservePort } from 'node:net';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const temp = await mkdtemp(join(await realpath(tmpdir()), 'sam-mcp-release-'));
const relation = relative(await realpath(root), temp);
const dist = join(root, 'dist');
const npm = process.env.npm_execpath;

function run(script, args) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: temp, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }
  });
}

function stdio(args, env = {}) {
  return new StdioClientTransport({
    command: process.execPath, args, cwd: temp, stderr: 'pipe',
    env: { SAM_MCP_HOME: join(temp, 'user-data'), NODE_PATH: '', NODE_OPTIONS: '', ...env }
  });
}

async function withClient(transport, workflow) {
  const client = new Client({ name: 'release-verifier', version: pkg.version });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, pkg.version);
    await workflow(client);
  } finally {
    await client.close();
  }
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, `${name}: ${result.content?.[0]?.text ?? 'tool failed'}`);
  return result.structuredContent;
}

async function demoWorkflow(client) {
  assert.equal((await client.listTools()).tools.length, 13);
  const status = await call(client, 'procurement_status');
  assert.equal(status.samOpportunityAccess, 'synthetic');
  const search = await call(client, 'search_opportunities', {
    naics: '541512', openOnly: true, profile: { states: ['VA'], pscCodes: ['DA01'] }
  });
  const [notice] = search.notices;
  assert.equal(notice.fit.score, 100);
  const args = { noticeId: notice.noticeId };
  const brief = await call(client, 'research_opportunity', args);
  assert.match(brief.description.text, /separate price volume/);
  const leader = brief.relatedAwards.leadingRecipients[0];
  const entity = await call(client, 'lookup_public_entity', { uei: leader.uei });
  assert.equal(entity.records[0].legalBusinessName, leader.recipient);
  await call(client, 'save_pipeline_notice', args);
  assert.equal((await call(client, 'check_pipeline_notice', args)).status, 'no_detected_change');
  assert.equal((await call(client, 'remove_pipeline_notice', args)).removed, true);
}

async function verifyHttp(cli) {
  const socket = reservePort();
  const listening = once(socket, 'listening');
  socket.listen(0, '127.0.0.1');
  await listening;
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));

  const child = spawn(process.execPath, [cli, 'serve-http', '--demo', '--port', String(port)], {
    cwd: temp, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }
  });
  const closed = once(child, 'close');
  try {
    const [message] = await once(child.stderr, 'data', { signal: AbortSignal.timeout(15_000) });
    assert.match(message.toString(), /listening at http:\/\/127\.0\.0\.1:/);
    const url = new URL(`http://127.0.0.1:${port}/mcp`);
    await withClient(new StreamableHTTPClientTransport(url), async (client) => {
      const { tools } = await client.listTools();
      assert(tools.every((tool) => tool.annotations.readOnlyHint && !tool.name.includes('pipeline')));
      const { results } = await call(client, 'search', { query: 'cloud' });
      const record = await call(client, 'fetch', { id: results[0].id });
      assert.equal(record.url, results[0].url);
      assert.match(record.text, /separate price volume/);
    });
  } finally {
    child.kill();
    await closed;
  }
  console.log('Installed npm package passed loopback HTTP discovery and search/fetch.');
}

async function liveWorkflow(client) {
  const segment = { naics: '541512', psc: 'DA01', from: '2024-10-01', to: '2025-09-30' };
  const market = await call(client, 'analyze_contract_market', { ...segment, sampleSize: 10 });
  assert.equal(market.source, 'USAspending');
  assert.equal(market.coverage.awardsAnalyzed, 10);
  assert(market.coverage.matchingAwards >= 10);
  const sample = market.examples.find((row) => row.awardId && row.recipientUei);
  assert(sample, 'Expected a sampled award with a PIID and recipient UEI.');
  const exact = await call(client, 'search_contract_awards', {
    ...segment, awardId: sample.awardId, recipient: sample.recipientUei
  });
  assert(exact.awards.some((row) => row.generatedId === sample.generatedId));
  assert(exact.awards.every((row) => row.awardId === sample.awardId));
  const recent = await call(client, 'search_contract_awards', {
    ...segment, recipient: sample.recipientUei, sort: 'recent', limit: 5
  });
  assert(recent.awards.length);
  assert(recent.awards.every((row, i) =>
    row.signedDate >= segment.from && row.signedDate <= segment.to &&
    (i === 0 || row.signedDate <= recent.awards[i - 1].signedDate)));
  console.log(`Live USAspending market, exact PIID/UEI, and signing-date search passed (${market.coverage.matchingAwards} market matches).`);

  const status = await call(client, 'procurement_status');
  if (!status.samKeyConfigured) {
    assert(!process.env.SAM_GOV_API_KEY?.trim(), status.samSetupError);
    console.log('Skipped authenticated SAM.gov checks because SAM_GOV_API_KEY was not supplied.');
    return;
  }
  const search = await call(client, 'search_opportunities', { naics: '541512', limit: 10 });
  assert(search.notices.length, 'Expected at least one SAM.gov result for the live smoke test.');
  const { noticeId, postedDate } = search.notices[0];
  const args = { noticeId, postedDate: postedDate ?? undefined };
  const notice = await call(client, 'get_opportunity', args);
  assert.equal(notice.notice.noticeId, noticeId);
  assert.equal(notice.descriptionError, null);
  const brief = await call(client, 'research_opportunity', args);
  assert.equal(brief.notice.noticeId, noticeId);
  const entity = await call(client, 'lookup_public_entity', { uei: sample.recipientUei });
  assert.equal(entity.uei, sample.recipientUei);
  console.log('Authenticated SAM.gov opportunity search, notice detail, bid research and public entity request passed.');
}

try {
  assert(isAbsolute(relation) || relation.startsWith('..' + sep), 'Release verification needs a temp directory outside the checkout.');
  const archive = join(dist, `${pkg.name}-${pkg.version}.tgz`);
  const installed = join(temp, 'npm');
  const cache = join(temp, 'empty-npm-cache');
  run(npm, ['install', '--prefix', installed, '--cache', cache, '--offline', '--ignore-scripts',
    '--omit=dev', '--no-audit', '--no-fund', archive]);
  const installedCli = join(installed, 'node_modules', pkg.name, pkg.bin[pkg.name]);
  assert.equal(run(npm, ['exec', '--prefix', installed, '--cache', cache, '--offline',
    '--', pkg.name, '--version']).trim(), pkg.version);
  await withClient(stdio([installedCli, '--demo']), demoWorkflow);
  console.log('npm tarball installed offline from an empty cache and passed the demo workflow.');
  await verifyHttp(installedCli);

  const extensionPath = join(temp, 'Claude Desktop Extension');
  const files = unzipSync(await readFile(join(dist, 'sam-procurement-mcp.mcpb')));
  for (const [name, data] of Object.entries(files)) {
    assert(!/[:\\]/.test(name) && name.split('/').every((part) => part && part !== '.' && part !== '..'),
      'Unexpected path in desktop bundle.');
    const path = join(extensionPath, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
  const manifest = JSON.parse(await readFile(join(extensionPath, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.manifest_version, '0.3');
  assert.equal(manifest.server.type, 'node');
  assert.equal(manifest.user_config.sam_api_key.sensitive, true);
  assert.deepEqual(manifest.server.mcp_config, {
    command: 'node', args: ['${__dirname}/' + manifest.server.entry_point],
    env: { SAM_GOV_API_KEY: '${user_config.sam_api_key}', SAM_MCP_DEMO: '${user_config.demo}' }
  });
  await withClient(stdio([join(extensionPath, manifest.server.entry_point)], {
    SAM_GOV_API_KEY: '', SAM_MCP_DEMO: 'true'
  }), demoWorkflow);
  console.log('Desktop bundle unpacked outside the checkout and passed the demo workflow.');

  if (process.argv.includes('--live')) {
    const env = { SAM_MCP_DEMO: 'false', SAM_GOV_API_KEY: process.env.SAM_GOV_API_KEY ?? '' };
    await withClient(stdio([installedCli], env), liveWorkflow);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
