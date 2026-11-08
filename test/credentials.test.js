import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentials } from '../src/credentials.js';

const first = 'synthetic_first_sam_key';
const next = 'synthetic_next_sam_key';
const accepted = async () => {};

test('Windows DPAPI protects persistence, migrates legacy storage, replaces and removes keys', {
  skip: process.platform !== 'win32', timeout: 30_000
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sam-vault-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const make = () => createCredentials(dir, { env: {} });
  const vault = make();
  const legacy = join(dir, 'sam-api-key');
  const protectedPath = join(dir, 'sam-api-key.dpapi');
  await assert.rejects(vault.read, { code: 'missing_key' });
  await writeFile(legacy, first);
  await assert.rejects(vault.read, { code: 'migration_required' });
  await vault.save(first, accepted);
  const ciphertext = await readFile(protectedPath, 'utf8');
  assert(!ciphertext.includes(first));
  await assert.rejects(() => readFile(legacy), { code: 'ENOENT' });
  assert.deepEqual(await make().read(), { key: first, source: 'Windows DPAPI' });
  await assert.rejects(() => vault.save(next, async () => { throw new Error('Validation failed'); }), /Validation failed/);
  assert.equal(await readFile(protectedPath, 'utf8'), ciphertext);
  await vault.save(next, accepted);
  assert.equal((await make().read()).key, next);
  await vault.remove();
  await vault.remove();
  await assert.rejects(make().read, { code: 'missing_key' });
  await assert.rejects(() => readFile(protectedPath), { code: 'ENOENT' });
});

for (const platform of ['darwin', 'linux']) {
  test(`${platform} vault sends a validated key only over a pipe and suppresses backend errors`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'sam-vault-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    let secret;
    let fail = false;
    const vault = createCredentials(dir, { platform, env: {}, execute: async (_bin, args, input) => {
      assert(!args.join(' ').includes(first));
      assert(!args.join(' ').includes(next));
      if (fail) return { code: 2, stdout: first, stderr: next };
      if (input?.includes(first)) secret = first;
      if (input?.includes(next)) secret = next;
      if (args[0].startsWith('delete') || args[0] === 'clear') secret = undefined;
      if (!secret) return { code: platform === 'darwin' ? 44 : 1, stdout: '', stderr: '' };
      return { code: 0, stdout: secret, stderr: '' };
    } });
    await assert.rejects(vault.read, { code: 'missing_key' });
    await vault.save(first, accepted);
    assert.equal((await vault.read()).key, first);
    await vault.save(next, accepted);
    assert.equal((await vault.read()).key, next);
    await vault.remove();
    await assert.rejects(vault.read, { code: 'missing_key' });
    fail = true;
    await assert.rejects(vault.read, (error) => error.code === 'storage_unavailable' &&
      !error.message.includes(first) && !error.message.includes(next));
  });
}
