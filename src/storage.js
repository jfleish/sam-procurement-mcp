import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { noticeId } from './inputs.js';
import { UserError } from './net.js';

export function dataDirectory(env = process.env) {
  if (env.SAM_MCP_HOME) return resolve(env.SAM_MCP_HOME);
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'sam-procurement-mcp');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'sam-procurement-mcp');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'sam-procurement-mcp');
}

export async function optional(read) {
  try {
    return await read();
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function atomicWrite(dir, file, text) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, text, { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
}

export function createPipeline(home, demo) {
  const dir = join(home, demo ? 'demo-pipeline' : 'pipeline');
  const file = (id) => join(dir, noticeId.parse(id) + '.json');
  async function read(id) {
    const content = await optional(() => readFile(file(id), 'utf8'));
    if (content === null) return null;
    try {
      const row = JSON.parse(content);
      if (row.notice?.noticeId === id && typeof row.capturedAt === 'string') return row;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    throw new UserError(`The local snapshot for ${id} is unreadable. Re-save the notice to replace it.`);
  }
  return {
    read,
    async list(page, limit) {
      const names = await optional(() => readdir(dir));
      const ids = (names ?? []).filter((name) => /^[a-f0-9]{32}\.json$/.test(name)).sort()
        .map((name) => name.slice(0, -5));
      const rows = await Promise.all(ids.slice((page - 1) * limit, page * limit).map(read));
      return { rows: rows.filter(Boolean), total: ids.length };
    },
    save(row) {
      return atomicWrite(dir, file(row.notice.noticeId), JSON.stringify(row) + '\n');
    },
    async remove(id) {
      try {
        await rm(file(id));
        return true;
      } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
    }
  };
}
