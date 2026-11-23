import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Store } from './database.js';
import { hashPassword } from './security.js';

const ADMIN_HASH_KEY = 'admin.hash';
export const ADMIN_PASSWORD_MIN_LENGTH = 10;
export const ADMIN_PASSWORD_MAX_LENGTH = 200;
const SETUP_TOKEN_MIN_LENGTH = 32;
export const SETUP_TOKEN_MAX_LENGTH = 256;

export function hasAdminPassword(store: Store): boolean {
  return Boolean(store.getConfig(ADMIN_HASH_KEY, ''));
}

export async function initializeAdminPassword(store: Store, password: string): Promise<boolean> {
  const hash = await hashPassword(password);
  const result = store.db.prepare(`
    INSERT INTO config(key, payload) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload WHERE config.payload = '""'
  `).run(ADMIN_HASH_KEY, JSON.stringify(hash));
  return result.changes === 1;
}

async function readSetupToken(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('初始化令牌文件必须是普通文件');
    await file.chmod(0o600);
    const token = (await file.readFile('utf8')).trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('初始化令牌文件格式无效');
    return token;
  } finally {
    await file.close();
  }
}

async function loadOrCreateSetupToken(dataDir: string): Promise<string> {
  const path = join(dataDir, '.setup-token');
  try {
    return await readSetupToken(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const token = randomBytes(32).toString('base64url');
  const stagingPath = join(dataDir, `.setup-token-${randomBytes(12).toString('hex')}.tmp`);
  const stagingFile = await open(stagingPath, 'wx', 0o600);
  try {
    await stagingFile.chmod(0o600);
    await stagingFile.writeFile(`${token}\n`, 'utf8');
    await stagingFile.sync();
    // Publish the complete file atomically and preserve the winner of a concurrent startup.
    await link(stagingPath, path);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return await readSetupToken(path);
  } finally {
    await stagingFile.close();
    await unlink(stagingPath);
  }
}

export async function prepareBootstrap(store: Store, dataDir: string, env = process.env): Promise<string | undefined> {
  if (hasAdminPassword(store)) return;
  if (env.ADMIN_PASSWORD) {
    if (env.ADMIN_PASSWORD.length < ADMIN_PASSWORD_MIN_LENGTH || env.ADMIN_PASSWORD.length > ADMIN_PASSWORD_MAX_LENGTH) {
      throw new Error(`ADMIN_PASSWORD 必须为 ${ADMIN_PASSWORD_MIN_LENGTH}–${ADMIN_PASSWORD_MAX_LENGTH} 个字符`);
    }
    await initializeAdminPassword(store, env.ADMIN_PASSWORD);
    return;
  }

  const setupToken = env.SETUP_TOKEN?.trim();
  if (setupToken) {
    if (setupToken.length < SETUP_TOKEN_MIN_LENGTH || setupToken.length > SETUP_TOKEN_MAX_LENGTH) {
      throw new Error(`SETUP_TOKEN 必须为 ${SETUP_TOKEN_MIN_LENGTH}–${SETUP_TOKEN_MAX_LENGTH} 个字符`);
    }
    return setupToken;
  }
  if (env.NODE_ENV === 'production') return loadOrCreateSetupToken(dataDir);
}
