// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { ContentId } from '@rljson/bs';
import { describe, expect, it } from 'vitest';

import { webcacheHubStores, WebcacheIndex } from '../src/index.ts';

describe('webcacheHubStores()', () => {
  it('gives a hub stores that pass the index and blobs through, keeping nothing', async () => {
    const { io, bs } = await webcacheHubStores();
    expect(await io.tableExists(WebcacheIndex.table)).toBe(true);

    await io.write({
      data: {
        webcacheEntries: {
          _type: 'components',
          _data: [{ ...WebcacheIndex.exampleEntry() }],
        },
      } as never,
    });
    expect(WebcacheIndex.rowsOf(await io.dumpTable({ table: WebcacheIndex.table }))).toEqual([]);

    const bytes = Buffer.from('relayed block');
    expect(await bs.setBlock(bytes)).toEqual({ blockId: ContentId.of(bytes), size: bytes.length });
    expect(await bs.blockExists(ContentId.of(bytes))).toBe(false);

    const blob = await bs.setBlob('relayed blob');
    expect(blob.blobId).toBe(ContentId.of(Buffer.from('relayed blob')));
    expect(await bs.blobExists(blob.blobId)).toBe(false);

    const blocks = [{ blockId: ContentId.of(bytes), size: bytes.length }];
    const stored = await bs.setBlobBlocks(ContentId.of(bytes), blocks);
    expect([stored.blobId, stored.size]).toEqual([ContentId.of(bytes), bytes.length]);
    expect(await bs.blobExists(ContentId.of(bytes))).toBe(false);
  });

  it('keeps the rows of other tables', async () => {
    const { io } = await webcacheHubStores();
    const cfg = { ...(await io.rawTableCfgs())[0] };
    expect(cfg).toBeDefined();
    await io.write({ data: {} as never });
    expect(await io.rowCount(WebcacheIndex.table)).toBe(0);
  });
});
