import { describe, expect, it } from 'vitest';
import { deriveOutputKeys } from '../src/services/imageService.js';

/**
 * Регрессия «потери данных»: итоговые ключи процессинга НЕ живут под raw/ —
 * cleanupOrphanedUploads удаляет всё под raw/ старше 48ч и снёс бы готовые
 * фото. До фикса deriveOutputKeys сохранял директорию исходника
 * (raw/x.jpg -> raw/x.webp), а для webp-исходника fullKey совпадал с
 * ключом загрузки — deleteObject(исходник) удалял готовый файл.
 */
describe('deriveOutputKeys', () => {
  it('jpg из raw/ попадает в images/, без raw/ в итоге', () => {
    const { fullKey, thumbKey } = deriveOutputKeys('raw/AbC123.jpg');
    expect(fullKey).toBe('images/AbC123.webp');
    expect(thumbKey).toBe('images/AbC123_thumb.webp');
    expect(fullKey.startsWith('raw/')).toBe(false);
    expect(thumbKey.startsWith('raw/')).toBe(false);
  });

  it('webp-исходник: итоговые ключи отличаются от исходного (не удаляем готовое)', () => {
    const source = 'raw/AbC123.webp';
    const { fullKey, thumbKey } = deriveOutputKeys(source);
    expect(fullKey).toBe('images/AbC123.webp');
    expect(thumbKey).toBe('images/AbC123_thumb.webp');
    expect(source).not.toBe(fullKey);
    expect(source).not.toBe(thumbKey);
  });

  it('legacy-ключ listings/ также переносится в images/', () => {
    const { fullKey } = deriveOutputKeys('listings/old-photo.jpeg');
    expect(fullKey).toBe('images/old-photo.webp');
  });

  it('png с расширением в верхнем регистре', () => {
    const { fullKey, thumbKey } = deriveOutputKeys('raw/PHOTO.PNG');
    expect(fullKey).toBe('images/PHOTO.webp');
    expect(thumbKey).toBe('images/PHOTO_thumb.webp');
  });
});
