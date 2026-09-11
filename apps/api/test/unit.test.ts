import { describe, expect, it } from 'vitest';
import { moderateListingContent } from '../src/services/moderationService.js';
import { detectMime } from '../src/lib/s3.js';

describe('moderation service', () => {
  it('approves normal content', async () => {
    const d = await moderateListingContent({ title: 'iPhone 15', description: 'Продаю новый телефон' });
    expect(d.approve).toBe(true);
  });

  it('rejects prohibited content', async () => {
    const d = await moderateListingContent({ title: 'Спортивный инвентарь', description: 'Куплю наркотики недорого' });
    expect(d.approve).toBe(false);
  });
});

describe('s3 magic bytes detection', () => {
  it('detects JPEG', () => {
    const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    expect(detectMime(buf)).toBe('image/jpeg');
  });

  it('detects PNG', () => {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect(detectMime(buf)).toBe('image/png');
  });

  it('detects unknown binary as octet-stream', () => {
    const buf = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(detectMime(buf)).toBe('application/octet-stream');
  });
});
