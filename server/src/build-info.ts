import type { Store } from './database.js';
import type { BuildInfo } from '../../shared/operations.js';
export type { BuildInfo } from '../../shared/operations.js';

export function getBuildInfo(store: Store, env = process.env): BuildInfo {
  const sha = env.BUILD_SHA?.trim() || '';
  const time = env.BUILD_TIME?.trim() || '';
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(time) ? Date.parse(time) : NaN;
  const versions: Array<[string, number]> = [];
  for (const row of store.db.prepare("SELECT key, payload FROM config WHERE key GLOB 'schema.*' ORDER BY key").all()) {
    const version = String(row.payload);
    if (/^\d+$/.test(version) && Number.isSafeInteger(Number(version))) {
      versions.push([String(row.key).slice('schema.'.length), Number(version)]);
    }
  }
  return {
    sha: /^[a-f0-9]{7,64}$/i.test(sha) ? sha : 'dev',
    time: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    schema: Object.fromEntries(versions),
  };
}
