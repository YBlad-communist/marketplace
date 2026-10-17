import { describe, expect, it } from 'vitest';
import { assertProductionEnvSafety, env } from '../src/config.js';

const secure = {
  NODE_ENV: 'production',
  COOKIE_SECURE: true,
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  S3_ACCESS_KEY_ID: 'prod-access-key',
  S3_SECRET_ACCESS_KEY: 'prod-secret-key',
  YOOKASSA_INSECURE_WEBHOOKS: false,
};

describe('п.33: production падает при старте на девском окружении', () => {
  it('COOKIE_SECURE !== true → ошибка', () => {
    expect(() => assertProductionEnvSafety({ ...secure, COOKIE_SECURE: false })).toThrow(/COOKIE_SECURE/);
    expect(() => assertProductionEnvSafety({ ...secure, COOKIE_SECURE: undefined })).toThrow(/COOKIE_SECURE/);
  });

  it('JWT-секреты с CHANGE_ME → ошибка', () => {
    expect(() =>
      assertProductionEnvSafety({ ...secure, JWT_ACCESS_SECRET: 'CHANGE_ME_'.padEnd(48, 'x') })
    ).toThrow(/CHANGE_ME/);
    expect(() =>
      assertProductionEnvSafety({ ...secure, JWT_REFRESH_SECRET: 'CHANGE_ME_'.padEnd(48, 'x') })
    ).toThrow(/CHANGE_ME/);
  });

  it('S3-креды = minioadmin или пустые → ошибка (п.35)', () => {
    expect(() => assertProductionEnvSafety({ ...secure, S3_ACCESS_KEY_ID: 'minioadmin' })).toThrow(/S3_ACCESS_KEY_ID/);
    expect(() => assertProductionEnvSafety({ ...secure, S3_SECRET_ACCESS_KEY: 'minioadmin' })).toThrow(/S3_SECRET_ACCESS_KEY/);
    expect(() => assertProductionEnvSafety({ ...secure, S3_ACCESS_KEY_ID: '' })).toThrow(/S3_ACCESS_KEY_ID/);
  });

  it('YOOKASSA_INSECURE_WEBHOOKS=true → ошибка', () => {
    expect(() => assertProductionEnvSafety({ ...secure, YOOKASSA_INSECURE_WEBHOOKS: true })).toThrow(
      /YOOKASSA_INSECURE_WEBHOOKS/
    );
  });

  it('безопасное production-окружение проходит', () => {
    expect(() => assertProductionEnvSafety(secure)).not.toThrow();
  });

  it('в development/test guard не применяется', () => {
    expect(() =>
      assertProductionEnvSafety({ ...secure, NODE_ENV: 'development', COOKIE_SECURE: false })
    ).not.toThrow();
    expect(() =>
      assertProductionEnvSafety({ ...secure, NODE_ENV: 'test', S3_ACCESS_KEY_ID: 'minioadmin' })
    ).not.toThrow();
  });
});

describe('п.33: адрес слушания API', () => {
  it('HOST по умолчанию 127.0.0.1 (наружу только nginx)', () => {
    // В тестовом окружении HOST не задан — должен падать на дефолт.
    if (!process.env.HOST) {
      expect(env.HOST).toBe('127.0.0.1');
    }
  });
});
