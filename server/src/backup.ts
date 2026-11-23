import { randomUUID } from 'node:crypto';
import { copyFile, link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';

function snapshotWorker(source: string | null, target: string): Promise<void> {
  return new Promise((resolveWorker, reject) => {
    const worker = new Worker(new URL('./backup-worker.mjs', import.meta.url), {
      workerData: { source, target },
      execArgv: [],
      env: {},
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code === 0) resolveWorker();
      else reject(new Error('备份工作线程异常退出'));
    });
  });
}

// Stage beside the destination. Linking publishes the completed file atomically and never overwrites.
async function publish(destination: string, createDirectory: boolean, write: (partial: string) => Promise<void>): Promise<void> {
  const target = resolve(destination);
  const dir = dirname(target);
  if (createDirectory) await mkdir(dir, { recursive: true, mode: 0o700 });
  const partial = join(dir, `.${basename(target)}.${randomUUID()}.partial`);
  const handle = await open(partial, 'wx', 0o600);
  try {
    await write(partial);
    await handle.sync();
    await link(partial, target);
    const directory = await open(dir, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await handle.close();
    await unlink(partial);
  }
}

export function backupDatabase(db: DatabaseSync, destination: string): Promise<void> {
  const source = db.location();
  return publish(destination, true, async partial => {
    // An in-memory database cannot be reopened by another thread.
    if (!source) await backup(db, partial);
    await snapshotWorker(source, partial);
  });
}

export function copyBackup(source: string, destination: string): Promise<void> {
  return publish(destination, false, async partial => {
    await copyFile(source, partial);
    await snapshotWorker(null, partial);
  });
}

export function backupName(owner: string, now: Date): string {
  return `pricepatrol-${owner}-${now.toISOString().replace(/[-:.]/g, '')}-${randomUUID()}.sqlite`;
}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const backupSuffix = `\\d{8}T\\d{9}Z-${uuid}\\.sqlite`;

// Hold an OS-released SQLite writer lock while reclaiming, writing and rotating in this directory.
// The lock file stays empty. Keeping its inode also lets cooperating processes share a mounted destination.
export async function withBackupDirectory(directory: string, owner: string, createDirectory: boolean, work: () => Promise<void>): Promise<void> {
  if (createDirectory) await mkdir(directory, { recursive:true, mode:0o700 });
  const lockPath = join(directory, `.pricepatrol-${owner}.lock`);
  const existing = await lstat(lockPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing && (!existing.isFile() || existing.size !== 0)) throw Error('备份锁文件不可用');
  const lock = new DatabaseSync(lockPath);
  try {
    // No data is written to this database and contention must not block the service thread.
    lock.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=MEMORY; BEGIN IMMEDIATE');
    const prefix = `.pricepatrol-${owner}-`;
    const staging = new RegExp(`^${backupSuffix}\\.${uuid}\\.partial$`);
    for (const entry of await readdir(directory, { withFileTypes:true })) {
      if (entry.isFile() && entry.name.startsWith(prefix) && staging.test(entry.name.slice(prefix.length))) {
        await unlink(join(directory, entry.name));
      }
    }
    await work();
  } finally {
    lock.close();
  }
}

export async function ownedBackups(directory: string, owner: string): Promise<string[]> {
  const prefix = `pricepatrol-${owner}-`;
  const suffix = new RegExp(`^${backupSuffix}$`);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter(entry => entry.isFile() && entry.name.startsWith(prefix) && suffix.test(entry.name.slice(prefix.length)))
      .map(entry => entry.name).sort().reverse();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function rotateBackups(directory: string, owner: string, keep: number, latest: string): Promise<void> {
  const files = await ownedBackups(directory, owner);
  for (const name of files.filter(file => file !== latest).slice(keep - 1)) {
    await unlink(join(directory, name));
  }
}
