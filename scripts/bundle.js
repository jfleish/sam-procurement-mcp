import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
await mkdir(dist, { recursive: true });
const stage = await mkdtemp(join(await realpath(dist), 'release-stage-'));

function run(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: stage, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Build command failed with status ${result.status}.`);
}

try {
  for (const name of ['src', 'package.json', 'package-lock.json', 'manifest.json', 'README.md', 'LICENSE']) {
    await cp(join(root, name), join(stage, name), { recursive: true });
  }
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== pkg.version) throw new Error('Manifest and npm package versions must match.');
  run(process.env.npm_execpath, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  run(process.env.npm_execpath, ['pack', '--ignore-scripts', '--silent', '--pack-destination', dist]);
  // MCPB is a ZIP with a root manifest and a self-contained server.
  const files = Object.create(null);
  const entries = await readdir(stage, { recursive: true, withFileTypes: true });
  entries.sort((a, b) => `${a.parentPath}/${a.name}`.localeCompare(`${b.parentPath}/${b.name}`));
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(stage, path).split(sep).join('/');
    if (name === 'package-lock.json' || name === 'node_modules/.package-lock.json' || name.includes('/.bin/')) continue;
    files[name] = await readFile(path);
  }
  await writeFile(join(dist, 'sam-procurement-mcp.mcpb'), zipSync(files, { mtime: new Date(1980, 0, 1) }));
  console.log('sam-procurement-mcp.mcpb');
} finally {
  await rm(stage, { recursive: true, force: true });
}
