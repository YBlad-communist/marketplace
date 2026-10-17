import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * П.22 аудита: в getObjectBuffer/verifyImageObject ContentLength проверяется
 * через HeadObject ДО скачивания объекта — гигантский файл не тянем в память.
 * SDK замокан, чтобы фиксировать порядок вызовов S3-операций.
 */
const state = vi.hoisted(() => ({
  calls: [] as string[],
  headContentLength: 0,
  headExists: true,
}));

vi.mock('@aws-sdk/client-s3', () => {
  class HeadObjectCommand {
    constructor(public input: unknown) {}
  }
  class GetObjectCommand {
    constructor(public input: unknown) {}
  }
  class PutObjectCommand {
    constructor(public input: unknown) {}
  }
  class DeleteObjectCommand {
    constructor(public input: unknown) {}
  }
  class S3Client {
    constructor(_config: unknown) {}
    async send(cmd: { constructor: { name: string } }) {
      const name = cmd.constructor.name;
      state.calls.push(name);
      if (name === 'HeadObjectCommand') {
        if (!state.headExists) {
          throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
        }
        return { ContentType: 'image/webp', ContentLength: state.headContentLength };
      }
      if (name === 'GetObjectCommand') {
        return {
          Body: (async function* () {
            yield Buffer.from('RIFF____WEBPVP8 fake-body');
          })(),
        };
      }
      return {};
    }
  }
  return { S3Client, HeadObjectCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand };
});

import { getObjectBuffer, verifyImageObject } from '../src/lib/s3.js';

beforeEach(() => {
  state.calls = [];
  state.headExists = true;
  state.headContentLength = 0;
});

describe('п.22: HeadObject-проверка размера до скачивания', () => {
  it('verifyImageObject: объект больше лимита отклоняется по HeadObject, без GetObject', async () => {
    state.headContentLength = 10_000;
    await expect(verifyImageObject('images/precheck-big.webp', 1000)).rejects.toThrow('превышает лимит');
    expect(state.calls).toEqual(['HeadObjectCommand', 'DeleteObjectCommand']);
  });

  it('getObjectBuffer: превышение лимита — отказ ещё до скачивания', async () => {
    state.headContentLength = 5_000;
    await expect(getObjectBuffer('images/precheck-limit.webp', 100)).rejects.toThrow('превышает лимит');
    expect(state.calls).toEqual(['HeadObjectCommand']);
  });

  it('getObjectBuffer: отсутствующий объект виден по HeadObject, Get не выполняется', async () => {
    state.headExists = false;
    await expect(getObjectBuffer('images/precheck-none.webp', 100)).resolves.toBeNull();
    expect(state.calls).toEqual(['HeadObjectCommand']);
  });

  it('getObjectBuffer: при валидном размере скачивание идёт после HeadObject', async () => {
    state.headContentLength = 20;
    const buf = await getObjectBuffer('images/precheck-ok.webp', 100);
    expect(buf).not.toBeNull();
    expect(state.calls).toEqual(['HeadObjectCommand', 'GetObjectCommand']);
  });
});
