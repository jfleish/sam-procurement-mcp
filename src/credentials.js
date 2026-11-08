import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { UserError } from './net.js';
import { atomicWrite, optional } from './storage.js';

const service = 'sam-procurement-mcp';
export const accountUrl = 'https://sam.gov/workspace/profile/account-details';

export function validateKeyFormat(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{10,256}$/.test(key)) {
    throw new UserError('Enter the personal public API key from SAM.gov Account Details.', 'invalid_format');
  }
}

function run(executable, args, input = '') {
  return new Promise((resolve) => {
    const child = execFile(executable, args, {
      windowsHide: true, timeout: 10_000, maxBuffer: 16_384, env: { ...process.env, SAM_GOV_API_KEY: '' }
    },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout: stdout.trim(), stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function storageError(message) {
  return new UserError(message, 'storage_unavailable');
}

function windowsVault(home, execute) {
  const path = join(home, 'sam-api-key.dpapi');
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  async function crypt(script, input) {
    const { code, stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); " + script
    ], input);
    if (code !== 0 || !stdout) {
      throw storageError('Windows could not access the protected SAM.gov key. Run setup as the same Windows user that runs your MCP client.');
    }
    return stdout;
  }
  return {
    name: 'Windows DPAPI',
    async read() {
      const encrypted = await optional(() => readFile(path, 'utf8'));
      if (encrypted === null) return null;
      return crypt("$b=[Convert]::FromBase64String($v); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'); [Console]::Write([Text.Encoding]::UTF8.GetString($p));", encrypted);
    },
    async save(key) {
      const encrypted = await crypt("$b=[Text.Encoding]::UTF8.GetBytes($v); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'); [Console]::Write([Convert]::ToBase64String($p));", key);
      await atomicWrite(home, path, encrypted + '\n');
    },
    remove: () => rm(path, { force: true })
  };
}

function desktopVault(home, platform, execute) {
  const id = createHash('sha256').update(home).digest('hex');
  if (platform === 'darwin') {
    const identity = ['-s', service, '-a', id];
    async function keychain(args, input, allowMissing = false) {
      const { code, stdout } = await execute('/usr/bin/security', args, input);
      if (allowMissing && code === 44) return null; // errSecItemNotFound, truncated to an exit code
      if (code !== 0) throw storageError('Could not access macOS Keychain. Unlock the login keychain and retry.');
      return stdout;
    }
    return {
      name: 'macOS Keychain',
      read: () => keychain(['find-generic-password', '-w', ...identity], '', true),
      // Interactive mode reads one command from a pipe, so the key stays out of process arguments.
      save: (key) => keychain(['-q', '-i'], `add-generic-password -U ${identity.join(' ')} -w "${key}"\n`),
      remove: () => keychain(['delete-generic-password', ...identity], '', true)
    };
  }
  if (platform === 'linux') {
    const identity = ['service', service, 'profile', id];
    async function secretTool(args, input, allowMissing = false) {
      const { code, stdout, stderr } = await execute('/usr/bin/secret-tool', [...args, ...identity], input);
      if (allowMissing && code === 1 && !stdout && !stderr) return null;
      if (code !== 0) {
        throw storageError('Could not access Linux Secret Service. Install secret-tool and unlock your desktop keyring, then retry.');
      }
      return stdout;
    }
    return {
      name: 'Linux Secret Service',
      read: () => secretTool(['lookup'], '', true),
      save: (key) => secretTool(['store', '--label=SAM Procurement MCP'], key),
      remove: () => secretTool(['clear'], '', true)
    };
  }
  const unavailable = async () => { throw storageError('This operating system has no supported secure key store.'); };
  return { name: 'secure storage', read: unavailable, save: unavailable, remove: unavailable };
}

export function createCredentials(home, { platform = process.platform, execute = run, env = process.env } = {}) {
  const legacy = join(home, 'sam-api-key');
  const vault = platform === 'win32' ? windowsVault(home, execute) : desktopVault(home, platform, execute);
  return {
    storageName: vault.name,
    async read() {
      const supplied = env.SAM_GOV_API_KEY?.trim();
      if (supplied) {
        try {
          validateKeyFormat(supplied);
        } catch {
          throw new UserError('SAM_GOV_API_KEY has an invalid format. Remove the override or supply a personal public API key.', 'invalid_format');
        }
        return { key: supplied, source: 'environment' };
      }
      try {
        const key = await vault.read();
        if (key !== null) {
          validateKeyFormat(key);
          return { key, source: vault.name };
        }
        if (await optional(() => stat(legacy))) {
          throw new UserError('An older plaintext key file exists. Run sam-procurement-mcp setup to validate and save the key securely.', 'migration_required');
        }
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw storageError('Could not read the local SAM.gov credential. Check access to the data directory and run setup again.');
      }
      throw new UserError('SAM.gov needs a personal public API key. Run sam-procurement-mcp setup in a terminal.', 'missing_key');
    },
    async save(key, verify) {
      validateKeyFormat(key);
      await verify(key);
      try {
        await vault.save(key);
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw storageError('Could not save the protected SAM.gov key. Check write access to the local data directory.');
      }
      try {
        await rm(legacy, { force: true });
      } catch {
        throw storageError('The secure key was saved. Delete the old sam-api-key plaintext file from the local data directory manually.');
      }
    },
    async remove() {
      await rm(legacy, { force: true });
      await vault.remove();
    }
  };
}
