import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

const csp = buildCsp({
  nonce: 'abc123',
  apiOrigin: 'https://rinokru.com',
  s3Origin: 'https://s3.rinokru.com',
});

function directive(policy: string, name: string): string {
  return (
    policy
      .split('; ')
      .find((d) => d.startsWith(`${name} `)) ?? ''
  );
}

describe('п.34: прод-CSP Next (nonce через middleware)', () => {
  it("script-src без 'unsafe-inline", () => {
    const scriptSrc = directive(csp, 'script-src');
    expect(scriptSrc).toContain("script-src 'self' 'nonce-abc123'");
    expect(scriptSrc).not.toContain('unsafe-inline');
  });

  it("img-src без wildcard-схем http:/https:, только self/data/blob и домен S3", () => {
    const imgSrc = directive(csp, 'img-src');
    expect(imgSrc).toContain("'self'");
    expect(imgSrc).toContain('data:');
    expect(imgSrc).toContain('blob:');
    expect(imgSrc).toContain('s3.rinokru.com');
    // голые схемы-источники ("http:" / "https:" целиком) запрещены
    expect(imgSrc).not.toMatch(/(?:^| )(?:http|https):(?: |$)/);
  });

  it('connect-src без localhost/127.0.0.1 и http://, WS-.origin выводится', () => {
    const connectSrc = directive(csp, 'connect-src');
    expect(connectSrc).toContain('https://rinokru.com');
    expect(connectSrc).toContain('wss://rinokru.com');
    expect(connectSrc).toContain('https://s3.rinokru.com');
    expect(connectSrc).not.toContain('localhost');
    expect(connectSrc).not.toContain('127.0.0.1');
    expect(connectSrc).not.toContain('http://');
  });

  it('неправильный прод-конфиг (HTTP API на localhost) отбрасывается из connect-src', () => {
    const bad = buildCsp({ nonce: 'n', apiOrigin: 'http://localhost:4000', s3Origin: 'http://127.0.0.1:9000' });
    const connectSrc = directive(bad, 'connect-src');
    expect(connectSrc).not.toContain('localhost');
    expect(connectSrc).not.toContain('127.0.0.1');
    expect(connectSrc).not.toContain('http://');
    expect(connectSrc).toContain("'self'");
  });

  it('есть базовые директивы безопасности', () => {
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('nonce-abc123');
  });
});
