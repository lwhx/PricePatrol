import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';

const text = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const root = text('docker-compose.yaml');
const deploy = text('deploy/compose.yaml');
const envExample = text('.env.example');
const deployEnv = text('deploy/.env.example');

it('keeps the published image and data volume named pricepatrol everywhere', () => {
  expect(envExample).toContain('IMAGE=ghcr.io/lwhx/pricepatrol:latest');
  expect(envExample).not.toMatch(/^IMAGE=pricepatrol:local$/m);
  expect(envExample).toContain('DATA_VOLUME=pricepatrol-data');
  expect(deployEnv).toContain('IMAGE=ghcr.io/lwhx/pricepatrol:latest');
  expect(deployEnv).toContain('DATA_VOLUME=pricepatrol-data');
  for (const file of [root, deploy]) {
    expect(file).toContain('name: pricepatrol');
    expect(file).toContain('pricepatrol-data:/app/data');
    expect(file).toContain('name: ${DATA_VOLUME:-pricepatrol-data}');
    expect(file).toContain('${ENCRYPTION_KEY:?');
    expect(file).toContain('image: ${IMAGE:-ghcr.io/lwhx/pricepatrol:latest}');
    expect(file).toContain('pull_policy: always');
    expect(file).not.toMatch(/^\s+build:/m);
  }
});

it('lets a server run from deploy/ files alone without a source checkout', () => {
  // The deploy file must never build: the image already contains web/dist and server code.
  expect(deploy).not.toMatch(/^\s+build:/m);
  expect(deploy).not.toContain('dockerfile');
  expect(deploy).toContain('image: ${IMAGE:-ghcr.io/lwhx/pricepatrol:latest}');
  // Both entry points must agree on the container port and data directory.
  for (const file of [root, deploy]) {
    expect(file).toContain('DATA_DIR: /app/data');
    expect(file).toContain('"6300:3000"');
    expect(file).not.toContain('"${BIND_ADDRESS:-127.0.0.1}');
    expect(file).not.toContain('${APP_PORT:-3000}');
    expect(file).toContain('/api/auth/status');
  }
});
