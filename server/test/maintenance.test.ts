import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/database.js';
import { MaintenanceService } from '../src/maintenance.js';
import { backupName, copyBackup, ownedBackups, withBackupDirectory } from '../src/backup.js';

const key = 'maintenance-unittest-key-kept-separately';
const teardown: Array<() => Promise<void>> = [];
afterEach(async () => { while (teardown.length) await teardown.pop()!(); });

async function temporary() {
  const dir = await mkdtemp(join(tmpdir(), 'pricepatrol-maintenance-'));
  teardown.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function setup(dir: string, options: { backupDir?: string; backupCopyDir?: string } = {}) {
  const store = new Store(join(dir, 'monitor.sqlite'), key);
  const service = new MaintenanceService(store, { dataDir: dir, backupCopyDir: '', ...options });
  const close = async () => { await service.close(); store.close(); };
  teardown.push(close);
  return { store, service, close };
}
function seedHistory(store: Store) {
  const at = '2020-01-01T00:00:00.000Z';
  store.db.prepare('INSERT INTO shops (id,payload) VALUES (?,?)').run('shop', '{}');
  store.db.prepare('INSERT INTO runs(id,shop_id,created_at,payload) VALUES(?,?,?,?)')
    .run('old', 'shop', at, JSON.stringify({ id: 'old', finishedAt: at, status: 'success' }));
}
function inspect<T>(file: string, check: (db: DatabaseSync) => T) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return check(db); } finally { db.close(); }
}

it('adopts legacy retention, validates changes atomically and restores settings after reopening', async () => {
  const dir = await temporary();
  const { store, service, close } = setup(dir);
  expect(service.getSettings()).toEqual({
    retentionDays: 180, alertRetentionDays: 365, cleanupEnabled: false,
    backupsEnabled: true, backupIntervalHours: 24, backupKeep: 14,
  });
  store.setConfig('retentionDays', 730);
  expect(service.getSettings()).toMatchObject({ retentionDays: 730, alertRetentionDays: 730 });
  expect(() => service.updateSettings({ alertRetentionDays: 365, cleanupEnabled: true })).toThrow();
  expect(() => service.updateSettings({ backupKeep: 0 })).toThrow();
  expect(() => service.updateSettings({ backupDir: '/untrusted' } as never)).toThrow();
  expect(service.getSettings().cleanupEnabled).toBe(false);
  const saved = service.updateSettings({ retentionDays: 30, alertRetentionDays: 90, backupKeep: 2 });
  expect(store.getConfig('retentionDays', 0)).toBe(30);
  await close();
  expect(setup(dir).service.getSettings()).toEqual(saved);
});

it('creates an independently readable snapshot of committed WAL data without overwriting a published backup', async () => {
  const dir = await temporary();
  const { store } = setup(dir);
  const target = join(dir, 'one.sqlite');
  store.setConfig('wal-test', 'committed');
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.setConfig('wal-test', 'uncommitted');
    await store.backup(target);
    expect(inspect(target, db => db.prepare("SELECT payload FROM config WHERE key='wal-test'").get()?.payload)).toBe('"committed"');
  } finally { store.db.exec('ROLLBACK'); }
  const original = await readFile(target);
  store.setConfig('wal-test', 'changed');
  await expect(store.backup(target)).rejects.toThrow();
  expect(await readFile(target)).toEqual(original);
  expect((await stat(target)).mode & 0o777).toBe(0o600);
  expect((await readdir(dir)).some(name => name.startsWith('.one.sqlite.'))).toBe(false);
});

it('validates the copy before publication and rotates only completed files owned by this database', async () => {
  const dir = await temporary();
  const remote = join(dir, 'mounted-remote');
  await mkdir(remote);
  const local = join(dir, 'backups');
  const { service, store } = setup(dir, { backupCopyDir: remote });
  service.updateSettings({ backupKeep: 1 });
  await service.run('backup');
  const owner = store.getConfig('maintenance.owner', '');
  const [first] = await ownedBackups(local, owner);
  const unrelated = backupName(randomUUID(), new Date());
  const partial = '.' + first + '.partial';
  const linked = backupName(owner, new Date());
  const linkedStage = '.' + linked + '.' + randomUUID() + '.partial';
  const otherStage = '.' + unrelated + '.' + randomUUID() + '.partial';
  for (const destination of [local, remote]) {
    await writeFile(join(destination, unrelated), 'another database');
    await writeFile(join(destination, partial), 'an incomplete file');
    await writeFile(join(destination, otherStage), 'other staging');
    await symlink(join(destination, unrelated), join(destination, linked));
    await symlink(join(destination, unrelated), join(destination, linkedStage));
  }
  await service.run('backup');
  const files = await readdir(local);
  expect(files).toEqual(await readdir(remote));
  expect(files).not.toContain(first);
  expect(files).toEqual(expect.arrayContaining([unrelated, partial, linked, linkedStage, otherStage]));
  const completed = await ownedBackups(local, owner);
  expect(completed).toHaveLength(1);
  for (const destination of [local, remote]) {
    const current = join(destination, completed[0]);
    expect((await stat(current)).mode & 0o777).toBe(0o600);
    expect(inspect(current, db => db.prepare('PRAGMA integrity_check').get()?.integrity_check)).toBe('ok');
  }
  expect(await service.status()).toMatchObject({ backupCount: 1, backupCopyConfigured: true, backupError: null, copyError: null });
  const invalid = join(remote, 'corrupt.sqlite');
  await expect(copyBackup(join(local, unrelated), invalid)).rejects.toThrow();
  expect(await readdir(remote)).not.toContain('corrupt.sqlite');
});

it('runs opt-in cleanup only after a recoverable snapshot, including when scheduled backups are disabled', async () => {
  const dir = await temporary();
  const { store, service } = setup(dir);
  seedHistory(store);
  await service.tick();
  expect(store.getRun('old')).toBeDefined();
  expect((await service.status()).lastCleanupAt).toBeNull();
  service.updateSettings({ backupsEnabled: false, cleanupEnabled: true });
  const preview = service.preview();
  expect(preview.runs).toBe(1);
  await service.tick();
  expect(store.getRun('old')).toBeUndefined();
  const status = await service.status();
  expect(status).toMatchObject({ lastDeleted: preview.total, backupCount: 2, lastError: null });
  expect(status.databaseBytes).toBeGreaterThan(0);
  const latest = (await readdir(join(dir, 'backups'))).sort().at(-1)!;
  expect(inspect(join(dir, 'backups', latest), db => db.prepare("SELECT id FROM runs WHERE id='old'").get()?.id)).toBe('old');
  await service.tick();
  expect(await service.status()).toEqual(status);
  expect(() => service.preview('2999-01-01T00:00:00Z')).toThrow();
});

it.each(['local', 'copy'])('persists a %s failure, skips deletion and defers another automatic attempt across restart', async failed => {
  const dir = await temporary();
  const blocked = join(dir, 'private-host-path');
  await writeFile(blocked, 'invalid destination');
  const options = failed === 'local' ? { backupDir: blocked } : { backupCopyDir: blocked };
  const { service, store, close } = setup(dir, options);
  seedHistory(store);
  service.updateSettings({ cleanupEnabled: true });
  await expect(service.tick()).rejects.toThrow();
  expect(store.getRun('old')).toBeDefined();
  const status = await service.status();
  expect(status.lastError).toBeTruthy();
  expect(status[failed === 'local' ? 'backupError' : 'copyError']).toBeTruthy();
  expect(status.lastCleanupAt).toBeNull();
  expect(JSON.stringify(status)).not.toContain(blocked);
  await close();
  const reopened = setup(dir, options);
  await reopened.service.tick();
  expect(await reopened.service.status()).toEqual(status);
  await rm(blocked);
  await mkdir(blocked);
  expect(await reopened.service.cleanupBefore('2022-01-01T00:00:00Z')).toMatchObject({ deleted: 1 });
  expect((await reopened.service.status()).lastError).toBeNull();
});

it.each(['backups', 'copy'])('reclaims the interrupted %s staging file after process exit before retrying cleanup', async stage => {
  const dir = await temporary();
  const local = join(dir, 'backups'), remote = join(dir, 'copy');
  await mkdir(remote);
  const options = { backupCopyDir:remote };
  const fixture = setup(dir, options);
  seedHistory(fixture.store);
  fixture.store.db.exec('CREATE TABLE fixture_blob(data BLOB); INSERT INTO fixture_blob VALUES(zeroblob(2097152))');
  fixture.service.updateSettings({ cleanupEnabled:true, backupsEnabled:false, backupKeep:1 });
  await fixture.close();
  // Interrupt after real snapshot/copy validation and fsync, just before the atomic publication link.
  const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { dirname, join } from 'node:path';
    const [dataDir,key,stage]=process.argv.slice(1);
    const link=fs.link;
    fs.link=(from,to)=>{ if(dirname(to)===join(dataDir,stage)) process.exit(42); return link(from,to); };
    syncBuiltinESMExports();
    const {Store}=await import('./server/src/database.ts');
    const {MaintenanceService}=await import('./server/src/maintenance.ts');
    const store=new Store(join(dataDir,'monitor.sqlite'),key);
    await new MaintenanceService(store,{dataDir,backupCopyDir:join(dataDir,'copy')}).tick();
    process.exit(1);
  `;
  await expect(promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir, key, stage], { timeout:10_000 }))
    .rejects.toMatchObject({ code:42 });
  const { store, service } = setup(dir, options);
  const abandoned = (await readdir(join(dir,stage))).filter(name => name.endsWith('.partial'));
  expect(abandoned).toHaveLength(1);
  const partial = join(dir,stage,abandoned[0]!);
  expect((await stat(partial)).size).toBeGreaterThan(2 * 1024 * 1024);
  const interrupted = await service.status();
  expect(interrupted).toMatchObject({ running:false, backupCount:stage === 'copy' ? 1 : 0, lastCleanupAt:null });
  expect(interrupted[stage === 'copy' ? 'copyError' : 'backupError']).toContain('中断');
  await service.tick();
  expect((await service.status()).lastRunAt).toBe(interrupted.lastRunAt);
  expect(store.getRun('old')).toBeDefined();
  await service.run('all');
  expect(await service.status()).toMatchObject({ backupCount:1, lastError:null, lastDeleted:1 });
  await expect(stat(partial)).rejects.toMatchObject({ code:'ENOENT' });
  const owner = store.getConfig('maintenance.owner', '');
  for (const destination of [local, remote]) {
    expect((await readdir(destination)).filter(name => name.endsWith('.partial'))).toEqual([]);
    expect(await ownedBackups(destination, owner)).toHaveLength(1);
  }
});

it.each(['backups', 'copy'])('protects active %s staging from a second maintenance process', async stage => {
  const dir = await temporary();
  const destination = join(dir, stage), remote = join(dir, 'copy');
  await mkdir(remote);
  const { store, service } = setup(dir, { backupCopyDir:remote });
  seedHistory(store);
  const owner = store.getConfig('maintenance.owner', '');
  const active = join(destination, '.' + backupName(owner, new Date()) + '.' + randomUUID() + '.partial');
  await withBackupDirectory(destination, owner, true, async () => {
    await writeFile(active, 'active writer');
    const script = `
      import {join} from 'node:path';
      import {Store} from './server/src/database.ts';
      import {MaintenanceService} from './server/src/maintenance.ts';
      const [dataDir,key]=process.argv.slice(1);
      const store=new Store(join(dataDir,'monitor.sqlite'),key);
      const service=new MaintenanceService(store,{dataDir,backupCopyDir:join(dataDir,'copy')});
      try { await service.cleanupBefore(); }
      catch(error) { console.log(error.cause.errcode); }
      finally { await service.close(); store.close(); }
    `;
    const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, dir, key], { timeout:10_000 });
    expect(child.stdout.trim()).toBe('5'); // SQLITE_BUSY from the destination lock
    expect(await readFile(active,'utf8')).toBe('active writer');
    expect(store.getRun('old')).toBeDefined();
  });
  await expect(service.cleanupBefore()).resolves.toMatchObject({deleted:1});
  await expect(stat(active)).rejects.toMatchObject({code:'ENOENT'});
});

it('serializes overlapping manual and automatic work and waits for the accepted backup on close', async () => {
  const dir = await temporary();
  const { service } = setup(dir);
  service.kick('backup');
  expect(() => service.kick('backup')).toThrow('已有维护任务');
  await service.tick();
  await service.close();
  expect(await service.status()).toMatchObject({ running: false, backupCount: 1, lastError: null });
});

it('waits an hour after a failed attempt and observes the configured recurring backup interval', async () => {
  const dir = await temporary();
  const target = join(dir, 'backups');
  await writeFile(target, 'blocked');
  const { service } = setup(dir);
  service.updateSettings({ backupIntervalHours: 4 });
  vi.useFakeTimers({ toFake: ['Date'] });
  const start = Date.parse('2025-01-01T00:00:00Z');
  try {
    vi.setSystemTime(start);
    await expect(service.tick()).rejects.toThrow();
    await rm(target);
    vi.setSystemTime(start + 59 * 60_000);
    await service.tick();
    expect((await service.status()).backupCount).toBe(0);
    vi.setSystemTime(start + 60 * 60_000);
    await service.tick();
    expect((await service.status()).backupCount).toBe(1);
    vi.setSystemTime(start + 299 * 60_000);
    await service.tick();
    expect((await service.status()).backupCount).toBe(1);
    vi.setSystemTime(start + 300 * 60_000);
    await service.tick();
    expect((await service.status()).backupCount).toBe(2);
  } finally { vi.useRealTimers(); }
});

it('honors a disabled cleanup switch before the running automatic backup releases rows for deletion', async () => {
  const dir = await temporary();
  const { service, store } = setup(dir);
  seedHistory(store);
  service.updateSettings({ cleanupEnabled: true });
  const running = service.tick();
  service.updateSettings({ cleanupEnabled: false });
  await running;
  expect(store.getRun('old')).toBeDefined();
  expect(await service.status()).toMatchObject({ backupCount: 1, lastCleanupAt: null });
});
