// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BlobBlock, BlobProperties, Bs, BsMem, ContentId, writeBlocks } from '@rljson/bs';
import { Io, IoMem } from '@rljson/io';
import { Rljson } from '@rljson/rljson';

import { webcacheEntriesTableCfg, WebcacheIndex } from './webcache-index.ts';

// .............................................................................
/** Rows that never stay: the index of whichever client a read reached. */
class _PassingIo extends IoMem {
  // ...........................................................................
  /**
   * Writes everything but index rows.
   * @param request - What to write.
   */
  override async write(request: { data: Rljson }): Promise<void> {
    const data = { ...(request.data as Record<string, unknown>) };
    delete data[WebcacheIndex.table];
    await super.write({ data: data as Rljson });
  }
}

// .............................................................................
/** Blobs that never stay: what passes through is not kept. */
class _PassingBs extends BsMem {
  // ...........................................................................
  /**
   * Takes a block without keeping it.
   * @param content - The block's bytes.
   * @returns The block.
   */
  override async setBlock(content: Buffer): Promise<BlobBlock> {
    return { blockId: ContentId.of(content), size: content.length };
  }

  // ...........................................................................
  /**
   * Takes a blob without keeping it.
   * @param content - The blob.
   * @returns Its properties.
   */
  override async setBlob(content: Buffer | string | ReadableStream): Promise<BlobProperties> {
    const layout = await writeBlocks(content, async () => undefined);
    return { blobId: layout.blobId, size: layout.size, createdAt: new Date() };
  }

  // ...........................................................................
  /**
   * Takes a blob's block list without keeping it.
   * @param blobId - The blob.
   * @param blocks - Its blocks.
   * @returns Its properties.
   */
  override async setBlobBlocks(blobId: string, blocks: BlobBlock[]): Promise<BlobProperties> {
    return { blobId, size: blocks.reduce((sum, b) => sum + b.size, 0), createdAt: new Date() };
  }
}

// .............................................................................
/**
 * The stores a hub serves the webcache's route with: they pass the index and
 * the blobs of its clients through and keep nothing.
 *
 * A hub that kept what it relays would answer later lookups from rows its
 * clients have long moved past, and would hold the blocks of every large file
 * that ever crossed it.
 * @returns The stores.
 */
export const webcacheHubStores = async (): Promise<{ io: Io; bs: Bs }> => {
  const io = new _PassingIo();
  await io.init();
  await io.isReady();
  await io.createOrExtendTable({ tableCfg: webcacheEntriesTableCfg });
  return { io, bs: new _PassingBs() };
};
