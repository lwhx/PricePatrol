// Opens dedicated SQLite connections so a long snapshot or integrity check cannot stall requests.
import { DatabaseSync } from 'node:sqlite';
import { workerData } from 'node:worker_threads';

const { source, target } = workerData;
if (source) {
  const live = new DatabaseSync(source, { readOnly: true });
  try {
    live.exec('PRAGMA busy_timeout=5000');
    live.prepare('VACUUM INTO ?').run(target);
  } finally {
    live.close();
  }
}

const snapshot = new DatabaseSync(target);
try {
  // Publish one self-contained database file, even when the source uses WAL.
  snapshot.exec('PRAGMA journal_mode=DELETE');
  const result = snapshot.prepare('PRAGMA integrity_check').all();
  if (result.length !== 1 || result[0].integrity_check !== 'ok') {
    throw new Error('备份完整性检查失败');
  }
} finally {
  snapshot.close();
}
