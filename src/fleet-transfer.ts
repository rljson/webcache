// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BlobBlock, Bs } from '@rljson/bs';

import { BlobFill } from './blob-fill.ts';
import { Fleet, FleetHolder } from './fleet.ts';

// #############################################################################
/** Options of {@link FleetTransfer.start}. */
export interface FleetTransferOptions {
  /** The local store the blocks go to. */
  bs: Bs;

  /** Reads from the holders. */
  fleet: Fleet;

  /** The nodes holding the blob. */
  holders: FleetHolder[];

  /** The blob. */
  blobId: string;

  /** Its size. */
  size: number;

  /** How many blocks are fetched at once. Default 8. */
  window?: number;
}

// #############################################################################
/**
 * Copies a blob from the nodes holding it into the local store, read while it
 * runs.
 *
 * The blocks are pulled from all holders at once, in turn, a window of them
 * in flight; a holder that fails is dropped and its blocks go to the others.
 * Blocks the local store already has — from an earlier version of the same
 * file — are not fetched at all.
 */
export class FleetTransfer {
  private _aborted = false;
  private readonly _blocksFrom: Record<string, number> = {};

  // ...........................................................................
  /**
   * Use {@link FleetTransfer.start}.
   * @param _options - What to copy from whom.
   * @param _blocks - The blob's blocks.
   * @param fill - Where it goes.
   */
  private constructor(
    private readonly _options: FleetTransferOptions,
    private readonly _blocks: BlobBlock[],
    readonly fill: BlobFill,
  ) {}

  /** Resolves with the stored blob; rejects when the transfer failed. */
  finished!: Promise<{ blobId: string; size: number }>;

  // ...........................................................................
  /**
   * Gets the block list from the first holder that gives it, and starts
   * copying in the background.
   * @param options - What to copy from whom.
   * @returns The running transfer.
   */
  static async start(options: FleetTransferOptions): Promise<FleetTransfer> {
    const failures: string[] = [];
    for (const holder of options.holders) {
      try {
        const blocks = await options.fleet.blobBlocks(holder, options.blobId);
        const transfer = new FleetTransfer(options, blocks, new BlobFill(options.bs, options.size));
        transfer.finished = transfer._run();
        transfer.finished.catch(() => undefined);
        return transfer;
      } catch (error) {
        failures.push((error as Error).message);
      }
    }
    throw new Error(`No node gave the blocks of ${options.blobId}: ${failures.join('; ')}`);
  }

  // ...........................................................................
  /** Stops copying. */
  abort(): void {
    this._aborted = true;
  }

  // ...........................................................................
  /** How many blocks came from which node. */
  get blocksFrom(): Record<string, number> {
    return this._blocksFrom;
  }

  // ...........................................................................
  /**
   * Copies every block in a sliding window and appends them in order.
   * @returns The stored blob.
   */
  private async _run(): Promise<{ blobId: string; size: number }> {
    const window = this._options.window ?? 8;
    const holders = [...this._options.holders];
    const pending: Promise<BlobBlock>[] = [];
    let next = 0;
    const request = () => {
      const index = next++;
      const fetching = this._copy(this._blocks[index], index, holders);
      fetching.catch(() => undefined);
      pending.push(fetching);
    };
    try {
      while (next < this._blocks.length && pending.length < window) request();
      while (pending.length > 0) {
        if (this._aborted) throw new Error('The transfer was stopped');
        this.fill.append(await (pending.shift() as Promise<BlobBlock>));
        if (next < this._blocks.length) request();
      }
      const stored = await this._options.bs.setBlobBlocks(this._options.blobId, this._blocks);
      this.fill.complete(stored.blobId);
      return { blobId: stored.blobId, size: this.fill.bytes };
    } catch (error) {
      this.fill.fail(error as Error);
      throw error;
    }
  }

  // ...........................................................................
  /**
   * Copies one block into the local store, unless it is there already.
   * @param block - The block.
   * @param index - Its place; picks the holder to ask first.
   * @param holders - The holders still working; a failing one is removed.
   * @returns The block.
   */
  private async _copy(block: BlobBlock, index: number, holders: FleetHolder[]): Promise<BlobBlock> {
    const bs = this._options.bs;
    if (await bs.blockExists(block.blockId)) return block;
    const failures: string[] = [];
    for (let attempt = 0; holders.length > 0; attempt++) {
      const holder = holders[(index + attempt) % holders.length];
      try {
        const bytes = await this._options.fleet.block(holder, block.blockId);
        await bs.setBlock(bytes);
        this._blocksFrom[holder.nodeId] = (this._blocksFrom[holder.nodeId] ?? 0) + 1;
        return block;
      } catch (error) {
        failures.push((error as Error).message);
        const at = holders.indexOf(holder);
        if (at >= 0) holders.splice(at, 1);
      }
    }
    throw new Error(`No node gave block ${block.blockId}: ${failures.join('; ')}`);
  }
}
