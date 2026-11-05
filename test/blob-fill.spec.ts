// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem, ContentId } from '@rljson/bs';
import { beforeEach, describe, expect, it } from 'vitest';

import { BlobFill } from '../src/index.ts';

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
};

describe('BlobFill', () => {
  let bs: BsMem;
  const parts = ['hello ', 'block ', 'world'].map((s) => Buffer.from(s));
  const whole = Buffer.concat(parts);
  const blobId = ContentId.of(whole);

  const fill = async (fill: BlobFill, count = parts.length, from = 0) => {
    for (const part of parts.slice(from, count)) {
      fill.append(await bs.setBlock(part));
    }
  };

  beforeEach(() => {
    bs = new BsMem();
  });

  describe('stream(range)', () => {
    it('streams blocks as they arrive, and ends with the blob', async () => {
      const f = new BlobFill(bs, whole.length);
      const reading = readAll(f.stream());
      expect(f.readers).toBe(1);
      await fill(f, 1);
      await new Promise((r) => setTimeout(r, 5));
      await fill(f, 3, 1);
      f.complete(blobId);
      expect(await reading).toEqual(whole);
      expect(f.readers).toBe(0);
    });

    it('streams a range of a filled blob, across blocks', async () => {
      const f = new BlobFill(bs, whole.length);
      await fill(f);
      f.complete(blobId);
      expect((await readAll(f.stream({ start: 3, end: 14 }))).toString()).toBe(
        'lo block wo',
      );
      expect((await readAll(f.stream({ start: 12 }))).toString()).toBe('world');
    });

    it('streams the rest of a fill of unknown size once it completes', async () => {
      const f = new BlobFill(bs, -1);
      const reading = readAll(f.stream({ start: 6 }));
      await fill(f);
      f.complete(blobId);
      expect((await reading).toString()).toBe('block world');
    });

    it('streams nothing for an empty range or one past the end', async () => {
      const f = await BlobFill.stored(bs, (await bs.setBlob(whole)).blobId);
      expect(await readAll(f.stream({ start: 4, end: 4 }))).toEqual(Buffer.alloc(0));
      expect(await readAll(f.stream({ start: 99 }))).toEqual(Buffer.alloc(0));
    });

    it('fails the stream when the fill fails', async () => {
      const f = new BlobFill(bs, whole.length);
      const reading = readAll(f.stream());
      await fill(f, 1);
      f.fail(new Error('Cloud gone'));
      await expect(reading).rejects.toThrow('Cloud gone');
      expect(f.readers).toBe(0);
    });

    it('counts a reader that cancels while it waits as gone once', async () => {
      const f = new BlobFill(bs, whole.length);
      const reader = f.stream().getReader();
      const waiting = reader.read().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 5));
      await reader.cancel();
      await fill(f);
      f.complete(blobId);
      await waiting;
      await new Promise((r) => setTimeout(r, 5));
      expect(f.readers).toBe(0);
    });

    it('counts a reader that cancels as gone', async () => {
      const f = new BlobFill(bs, whole.length);
      const reader = f.stream().getReader();
      await reader.cancel();
      expect(f.readers).toBe(0);
    });
  });

  describe('done()', () => {
    it('resolves with blob id and size once complete', async () => {
      const f = new BlobFill(bs, whole.length);
      await fill(f);
      f.complete(blobId);
      expect(await f.done()).toEqual({ blobId, size: whole.length });
      expect(f.isDone).toBe(true);
      expect(f.blobId).toBe(blobId);
    });

    it('rejects once failed, and stays failed', async () => {
      const f = new BlobFill(bs, whole.length);
      const done = f.done();
      f.fail(new Error('Size mismatch'));
      f.fail(new Error('again'));
      f.complete(blobId);
      await expect(done).rejects.toThrow('Size mismatch');
      expect(f.error?.message).toBe('Size mismatch');
      expect(f.isDone).toBe(false);
    });
  });

  describe('append(block)', () => {
    it('counts bytes and blocks in order', async () => {
      const f = new BlobFill(bs, -1);
      await fill(f, 2);
      expect(f.bytes).toBe(12);
      expect(f.blocks.map((b) => b.size)).toEqual([6, 6]);
      expect(f.expectedSize).toBe(-1);
    });

    it('fails after the fill ended', async () => {
      const f = new BlobFill(bs, -1);
      f.complete(blobId);
      expect(() => f.append({ blockId: 'x', size: 1 })).toThrow(
        'The fill already ended',
      );
    });
  });

  describe('stored(bs, blobId)', () => {
    it('is a complete fill of a stored blob', async () => {
      const { blobId: id } = await bs.setBlob(whole);
      const f = await BlobFill.stored(bs, id);
      expect(f.isDone).toBe(true);
      expect(f.bytes).toBe(whole.length);
      expect(await readAll(f.stream())).toEqual(whole);
    });
  });

  describe('example()', () => {
    it('is an empty fill of unknown size', () => {
      expect(BlobFill.example().bytes).toBe(0);
    });
  });
});
