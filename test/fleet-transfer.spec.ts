// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BlobBlock, BsMem, ContentId } from '@rljson/bs';
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { Fleet, FleetHolder, FleetTransfer, WebcacheIndex } from '../src/index.ts';

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<Buffer> => {
  const parts: Uint8Array[] = [];
  for await (const part of stream) parts.push(part);
  return Buffer.concat(parts);
};

describe('FleetTransfer', () => {
  const content = randomBytes(9 * 1024 * 1024);
  const blobId = ContentId.of(content);
  let stores: Map<string, BsMem>;
  let reads: string[];
  let broken: Set<string>;
  let brokenBlocks: Set<string>;
  let local: BsMem;

  // A fleet that reads blocks straight from the holders' stores.
  const fleet = {
    blobBlocks: async (holder: FleetHolder, id: string): Promise<BlobBlock[]> => {
      if (broken.has(holder.nodeId)) throw new Error(`${holder.nodeId} is gone`);
      return (stores.get(holder.nodeId) as BsMem).getBlobBlocks(id);
    },
    block: async (holder: FleetHolder, blockId: string): Promise<Buffer> => {
      reads.push(holder.nodeId);
      if (brokenBlocks.has(holder.nodeId)) throw new Error(`${holder.nodeId} is gone`);
      return (stores.get(holder.nodeId) as BsMem).getBlock(blockId);
    },
  } as unknown as Fleet;

  const holder = (nodeId: string): FleetHolder => ({
    nodeId,
    entry: WebcacheIndex.exampleEntry({ nodeId, blobId, size: content.length }),
    via: 'direct',
  });

  const start = (holders: string[], window?: number) =>
    FleetTransfer.start({
      bs: local,
      fleet,
      holders: holders.map(holder),
      blobId,
      size: content.length,
      window,
    });

  beforeEach(async () => {
    stores = new Map();
    reads = [];
    broken = new Set();
    brokenBlocks = new Set();
    local = new BsMem();
    for (const nodeId of ['a', 'b']) {
      const bs = new BsMem();
      await bs.setBlob(content);
      stores.set(nodeId, bs);
    }
  });

  describe('start(options)', () => {
    it('pulls the blocks from all holders and stores the blob', async () => {
      const transfer = await start(['a', 'b']);
      const read = readAll(transfer.fill.stream());
      expect(await transfer.finished).toEqual({ blobId, size: content.length });
      expect(await read).toEqual(content);
      expect(new Set(reads)).toEqual(new Set(['a', 'b']));
      expect((await local.getBlob(blobId)).content).toEqual(content);
      expect(transfer.blocksFrom).toEqual({
        a: reads.filter((r) => r === 'a').length,
        b: reads.filter((r) => r === 'b').length,
      });
    });

    it('fetches only the blocks it does not have', async () => {
      const blocks = await (stores.get('a') as BsMem).getBlobBlocks(blobId);
      await local.setBlock(await (stores.get('a') as BsMem).getBlock(blocks[0].blockId));
      const transfer = await start(['a'], 1);
      await transfer.finished;
      expect(reads.length).toBe(blocks.length - 1);
    });

    it('takes the blocks of a holder that fails from the others', async () => {
      brokenBlocks.add('b');
      const transfer = await start(['a', 'b']);
      expect((await transfer.finished).blobId).toBe(blobId);
      expect(Object.keys(transfer.blocksFrom)).toEqual(['a']);
    });

    it('takes the block list from the next holder when one fails', async () => {
      broken.add('a');
      const transfer = await start(['a', 'b']);
      expect((await transfer.finished).blobId).toBe(blobId);
    });

    it('fails when no holder gives the block list', async () => {
      broken.add('a');
      await expect(start(['a'])).rejects.toThrow(
        `No node gave the blocks of ${blobId}: a is gone`,
      );
    });

    it('fails when no holder gives a block', async () => {
      brokenBlocks.add('a');
      brokenBlocks.add('b');
      const transfer = await start(['a', 'b']);
      await expect(transfer.finished).rejects.toThrow('No node gave block');
      expect(transfer.fill.error).toBeDefined();
    });

    it('fails when the holders have other blocks than the blob', async () => {
      const other = randomBytes(1_000);
      await (stores.get('a') as BsMem).setBlob(other);
      const transfer = await FleetTransfer.start({
        bs: local,
        fleet: {
          ...fleet,
          blobBlocks: async () =>
            (stores.get('a') as BsMem).getBlobBlocks(ContentId.of(other)),
          block: fleet.block.bind(fleet),
        } as unknown as Fleet,
        holders: [holder('a')],
        blobId,
        size: content.length,
      });
      await expect(transfer.finished).rejects.toThrow();
    });
  });

  describe('abort()', () => {
    it('stops pulling and fails the transfer', async () => {
      const transfer = await start(['a'], 1);
      transfer.abort();
      await expect(transfer.finished).rejects.toThrow('The transfer was stopped');
    });
  });
});
