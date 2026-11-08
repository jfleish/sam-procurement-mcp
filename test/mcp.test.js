import assert from 'node:assert/strict';
import { request } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDemo } from '../src/demo.js';
import { createHttpMcp } from '../src/http.js';
import { createIntelligence } from '../src/intelligence.js';
import { createServer } from '../src/server.js';
import { createCredentials } from '../src/credentials.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

async function start(transport) {
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError ?? false, false, JSON.stringify(result.content));
  assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
  return result.structuredContent;
}

test('stdio demo supports discovery, bid research, public entity lookup and persistent pipeline', { timeout: 30_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'sam-mcp-test-'));
  const transport = () => new StdioClientTransport({
    command: process.execPath, args: [cli, '--demo'], env: { SAM_MCP_HOME: home }, stderr: 'pipe'
  });
  let client;
  t.after(async () => {
    await client?.close();
    await rm(home, { recursive: true, force: true });
  });
  client = await start(transport());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), [
    'procurement_status', 'search_opportunities', 'get_opportunity', 'search_contract_awards',
    'analyze_contract_market', 'research_opportunity', 'lookup_public_entity', 'search', 'fetch',
    'save_pipeline_notice', 'list_pipeline', 'check_pipeline_notice', 'remove_pipeline_notice'
  ]);
  for (const tool of tools) assert(!Object.keys(tool.inputSchema.properties).some((name) => /credential|key/i.test(name) && name !== 'keyword'));
  assert(tools.some((tool) => tool.name === 'research_opportunity' && tool.annotations.readOnlyHint));
  assert(tools.some((tool) => tool.name === 'save_pipeline_notice' && !tool.annotations.readOnlyHint));
  assert.equal((await call(client, 'procurement_status')).samOpportunityAccess, 'synthetic');
  const invalid = await client.callTool({ name: 'get_opportunity', arguments: { noticeId: '../../secret' } });
  assert.equal(invalid.isError, true);

  const result = await call(client, 'search_opportunities', {
    naics: '541512', openOnly: true, limit: 1, profile: { pscCodes: ['da01'], states: ['va'] }
  });
  assert.equal(result.totalSourceMatches, 2);
  assert.equal(result.nextPage, 2);
  const [notice] = result.notices;
  assert.equal(notice.fit.score, 100);
  const next = await call(client, 'search_opportunities', { naics: '541512', page: 2, limit: 1 });
  assert.notEqual(next.notices[0].noticeId, notice.noticeId);
  const args = { noticeId: notice.noticeId };
  const detail = await call(client, 'get_opportunity', args);
  assert.match(detail.description.text, /separate price volume/);
  const search = await call(client, 'search', { query: 'cloud' });
  assert.equal((await call(client, 'fetch', { id: search.results[0].id })).id, search.results[0].id);
  const awards = await call(client, 'search_contract_awards', { naics: '541512' });
  assert(awards.awards.length);
  assert.equal((await call(client, 'analyze_contract_market', { naics: '541512' })).coverage.matchingAwards, 4);
  const brief = await call(client, 'research_opportunity', args);
  assert.match(brief.description.text, /separate price volume/);
  assert.equal(brief.relatedAwards.leadingRecipients[0].recipient, 'Demo Systems LLC');
  const entity = await call(client, 'lookup_public_entity', { uei: brief.relatedAwards.leadingRecipients[0].uei });
  assert.equal(entity.records[0].registrationStatus, 'Active');
  const prompts = await client.listPrompts();
  assert.equal(prompts.prompts[0].name, 'bid_review');
  assert.match((await client.getPrompt({ name: 'bid_review', arguments: args })).messages[0].content.text, /bid\/no-bid/);

  assert.equal((await call(client, 'save_pipeline_notice', args)).saved, true);
  await client.close();
  client = await start(transport());
  assert.equal((await call(client, 'list_pipeline')).notices[0].noticeId, notice.noticeId);
  assert.equal((await call(client, 'check_pipeline_notice', args)).status, 'no_detected_change');
  assert.equal((await call(client, 'remove_pipeline_notice', args)).removed, true);
  assert.equal((await call(client, 'remove_pipeline_notice', args)).removed, false);
  assert.equal((await call(client, 'list_pipeline')).totalSaved, 0);
});

test('Streamable HTTP handles parallel requests and rejects cross-origin and rebinding requests', { timeout: 15_000 }, async (t) => {
  const adapters = createDemo();
  const app = { ...adapters, demo: true, intelligence: createIntelligence({ ...adapters, demo: true }) };
  const server = createHttpMcp(() => createServer(app));
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  const { port } = server.address();
  const url = new URL(`http://127.0.0.1:${port}/mcp`);
  let client;
  t.after(async () => {
    await client?.close();
    await new Promise((resolve) => server.close(resolve));
  });
  client = await start(new StreamableHTTPClientTransport(url));
  const { tools } = await client.listTools();
  assert(tools.every((tool) => tool.annotations.readOnlyHint && !tool.name.includes('pipeline')));
  const [search, market] = await Promise.all([
    call(client, 'search', { query: 'cloud' }),
    call(client, 'analyze_contract_market', { naics: '541512' })
  ]);
  assert.equal(search.results.length, 2);
  assert.equal(market.coverage.awardsAnalyzed, 4);
  const document = await call(client, 'fetch', { id: search.results[0].id });
  assert.match(document.title, /^\[Demo\]/);
  assert.equal(document.metadata.mode, 'demo');
  const post = (headers, body = '{}') => new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(await post({ Origin: 'https://evil.invalid' }), 403);
  assert.equal(await post({ Host: `evil.invalid:${port}` }), 403);
  assert.equal(await post({}, '{'), 400);
  assert.equal(await post({}, JSON.stringify('x'.repeat(140 * 1024))), 413);
});

test('a malformed SAM.gov credential leaves the server usable and is never echoed', async (t) => {
  const invalidKey = 'invalid!test!value';
  const client = await start(new StdioClientTransport({
    command: process.execPath, args: [cli], env: { SAM_GOV_API_KEY: invalidKey, SAM_MCP_DEMO: 'false' }, stderr: 'pipe'
  }));
  t.after(() => client.close());
  const status = await call(client, 'procurement_status');
  assert.equal(status.awardAccess, 'public_api');
  assert.equal(status.samOpportunityAccess, 'setup_required');
  assert.match(status.samSetupError, /invalid format/);
  const failure = await client.callTool({ name: 'search_opportunities', arguments: { title: 'cloud' } });
  assert(failure.isError);
  assert.doesNotMatch(JSON.stringify({ failure, status }), /invalid!test!value/);
});

test('running Windows stdio server sees a secure key save and removal without restart', {
  skip: process.platform !== 'win32', timeout: 30_000
}, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'sam-mcp-key-test-'));
  let client;
  t.after(async () => {
    await client?.close();
    await rm(home, { recursive: true, force: true });
  });
  const synthetic = 'synthetic_win32_key_test';
  client = await start(new StdioClientTransport({
    command: process.execPath, args: [cli], stderr: 'pipe',
    env: { SAM_MCP_HOME: home, SAM_MCP_DEMO: 'false', SAM_GOV_API_KEY: '' }
  }));
  assert.equal((await call(client, 'procurement_status')).samConnectionStatus, 'missing_key');
  const vault = createCredentials(home, { env: {} });
  await vault.save(synthetic, async () => {});
  let configured;
  for (let attempt = 0; attempt < 20; attempt++) {
    configured = await call(client, 'procurement_status');
    if (configured.samCredentialSource === 'Windows DPAPI') break;
    await delay(250);
  }
  assert.equal(configured.samCredentialSource, 'Windows DPAPI');
  assert.equal(configured.samConnectionStatus, 'unverified');
  assert(!JSON.stringify(configured).includes(synthetic));
  await vault.remove();
  assert.equal((await call(client, 'procurement_status')).samConnectionStatus, 'missing_key');
});
