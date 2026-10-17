import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadConfig(overrides: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
  return import('./config.js');
}

describe('п.35: worker без minioadmin-дефолта в production', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('production + пустые S3-креды → падаем при старте', async () => {
    await expect(
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/marketplace',
        S3_ACCESS_KEY_ID: '',
        S3_SECRET_ACCESS_KEY: '',
      })
    ).rejects.toThrow(/S3_ACCESS_KEY_ID is required in production/);
  });

  it('production + явный minioadmin → падаем при старте', async () => {
    await expect(
      loadConfig({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/marketplace',
        S3_ACCESS_KEY_ID: 'minioadmin',
        S3_SECRET_ACCESS_KEY: 'minioadmin',
      })
    ).rejects.toThrow(/S3_ACCESS_KEY_ID is required in production/);
  });

  it('development: minioadmin остаётся локальным дефолтом', async () => {
    const mod = await loadConfig({ NODE_ENV: 'development', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '' });
    expect(mod.env.S3_ACCESS_KEY_ID).toBe('minioadmin');
    expect(mod.env.S3_SECRET_ACCESS_KEY).toBe('minioadmin');
    expect(mod.isProd).toBe(false);
  });
});
