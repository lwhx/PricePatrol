import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { prepareBootstrap } from '../src/bootstrap.js';
// Windows does not map POSIX modes: a 0o600 request surfaces as 0o666 there.
const privateFileMode = process.platform === 'win32' ? 0o666 : 0o600;
import { Store } from '../src/database.js';
import { verifyPassword } from '../src/security.js';

let store: Store;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'pricepatrol-bootstrap-'));
  store = new Store(':memory:', 'a'.repeat(64));
});

afterEach(async () => {
  store.close();
  await rm(dataDir, { recursive: true, force: true });
});

it('persists a shared, private setup token across production restarts', async () => {
  const env = { NODE_ENV: 'production' };
  const [first, second] = await Promise.all([
    prepareBootstrap(store, dataDir, env),
    prepareBootstrap(store, dataDir, env),
  ]);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(second).toBe(first);

  const path = join(dataDir, '.setup-token');
  expect((await readFile(path, 'utf8')).trim()).toBe(first);
  expect((await stat(path)).mode & 0o777).toBe(privateFileMode);
  await chmod(path, 0o644);
  expect(await prepareBootstrap(store, dataDir, env)).toBe(first);
  expect((await stat(path)).mode & 0o777).toBe(privateFileMode);
});

it('prioritizes the supplied setup token without writing it to disk', async () => {
  const setupToken = 'unit-test-only-bootstrap-token-value';
  expect(await prepareBootstrap(store, dataDir, { NODE_ENV: 'production', SETUP_TOKEN: setupToken })).toBe(setupToken);
  await expect(stat(join(dataDir, '.setup-token'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects weak custom setup tokens before opening production setup', async () => {
  await expect(prepareBootstrap(store, dataDir, { NODE_ENV: 'production', SETUP_TOKEN: 'too-short' })).rejects.toThrow(/SETUP_TOKEN/);
  await expect(stat(join(dataDir, '.setup-token'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('preseeds the admin password without replacing it on later starts', async () => {
  const password = 'original-test-password';
  const env = { NODE_ENV: 'production', ADMIN_PASSWORD: password, SETUP_TOKEN: 'unit-test-only-bootstrap' };
  expect(await prepareBootstrap(store, dataDir, env)).toBeUndefined();
  const hash = store.getConfig('admin.hash', '');
  expect(hash).not.toBe(password);
  expect(await verifyPassword(password, hash)).toBe(true);
  expect(await prepareBootstrap(store, dataDir, { ...env, ADMIN_PASSWORD: 'short' })).toBeUndefined();
  expect(store.getConfig('admin.hash', '')).toBe(hash);
  await expect(stat(join(dataDir, '.setup-token'))).rejects.toMatchObject({ code: 'ENOENT' });
});
