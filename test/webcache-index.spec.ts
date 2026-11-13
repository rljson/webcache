// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { IoMem } from '@rljson/io';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  WebcacheEntry,
  webcacheEntriesTableCfg,
  WebcacheIndex,
} from '../src/index.ts';

describe('WebcacheIndex', () => {
  let io: IoMem;
  let now: number;
  let index: WebcacheIndex;

  const draft = (overrides: Partial<WebcacheEntry> = {}) =>
    WebcacheIndex.exampleDraft(overrides);

  beforeEach(async () => {
    io = new IoMem();
    await io.init();
    await io.isReady();
    now = 1_000;
    index = await WebcacheIndex.open(io, { nodeId: 'node-a', clock: () => now });
  });

  describe('open(io, options)', () => {
    it('creates the entries table, and opens an existing one again', async () => {
      expect(await io.tableExists(WebcacheIndex.table)).toBe(true);
      await WebcacheIndex.open(io, { nodeId: 'node-a' });
      expect(await index.all()).toEqual([]);
    });
  });

  describe('write(entry)', () => {
    it('stamps the node and the time, never twice the same time', async () => {
      const first = await index.write(draft({ state: 'downloading' }));
      const second = await index.write(draft({ state: 'cached' }));
      expect(first).toEqual({ ...draft({ state: 'downloading' }), at: 1_000, nodeId: 'node-a' });
      expect(second.at).toBe(1_001);
    });
  });

  describe('latest(keyHash)', () => {
    it('answers the newest row of a key', async () => {
      await index.write(draft({ state: 'downloading' }));
      now = 2_000;
      const cached = await index.write(draft({ state: 'cached' }));
      await index.write(draft({ keyHash: 'other', state: 'pinned' }));
      expect(await index.latest(cached.keyHash)).toEqual(cached);
    });

    it('answers undefined for a key it never saw', async () => {
      expect(await index.latest('unknown')).toBeUndefined();
    });
  });

  describe('all()', () => {
    it('answers the newest row of every key', async () => {
      await index.write(draft({ keyHash: 'a', state: 'downloading' }));
      const a = await index.write(draft({ keyHash: 'a', state: 'cached' }));
      const b = await index.write(draft({ keyHash: 'b', state: 'removed' }));
      expect(await index.all()).toEqual([a, b]);
    });
  });

  describe('rowsOf(rljson)', () => {
    it('answers no rows for a result without the table', () => {
      expect(WebcacheIndex.rowsOf({})).toEqual([]);
    });
  });

  describe('newest(rows)', () => {
    it('takes the latest time, and of equal times the later node', () => {
      const early = WebcacheIndex.exampleEntry({ at: 1, nodeId: 'b' });
      const late = WebcacheIndex.exampleEntry({ at: 2, nodeId: 'a' });
      const tie = WebcacheIndex.exampleEntry({ at: 2, nodeId: 'c' });
      expect(WebcacheIndex.newest([early, late])).toEqual(late);
      expect(WebcacheIndex.newest([tie, late])).toEqual(tie);
      expect(WebcacheIndex.newest([late, tie])).toEqual(tie);
      expect(WebcacheIndex.newest([])).toBeUndefined();
    });
  });

  describe('query(keyHash)', () => {
    it('is the read a peer answers', () => {
      expect(WebcacheIndex.query('k')).toEqual({
        table: 'webcacheEntries',
        where: { keyHash: 'k' },
      });
    });
  });

  describe('isLive(entry)', () => {
    it('is true for cached and pinned entries only', () => {
      const states = ['downloading', 'cached', 'pinned', 'failed', 'removed'];
      expect(
        states.map((state) =>
          WebcacheIndex.isLive(
            WebcacheIndex.exampleEntry({ state: state as never }),
          ),
        ),
      ).toEqual([false, true, true, false, false]);
      expect(WebcacheIndex.isLive(undefined)).toBe(false);
    });
  });

  describe('webcacheEntriesTableCfg', () => {
    it('is a shared components table keyed like the index', () => {
      expect(webcacheEntriesTableCfg.key).toBe(WebcacheIndex.table);
      expect(webcacheEntriesTableCfg.type).toBe('components');
      expect(webcacheEntriesTableCfg.columns.map((c) => c.key)).toEqual([
        '_hash',
        'keyHash',
        'key',
        'state',
        'blobId',
        'size',
        'contentType',
        'consumer',
        'source',
        'fetchedAt',
        'at',
        'nodeId',
      ]);
    });
  });

  describe('example()', () => {
    it('opens an index over a fresh in-memory store', async () => {
      const example = await WebcacheIndex.example();
      expect(await example.all()).toEqual([]);
    });
  });
});
