// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BlobBlock, Bs, BsMem } from '@rljson/bs';

// #############################################################################
/**
 * A blob being filled block by block, in order, and read while it fills.
 *
 * Whoever fills it — a download, a transfer from another node — stores each
 * block first and then appends it. Readers stream any range of the bytes and
 * wait where the fill has not arrived yet. A blob that is already stored is a
 * fill that is complete from the start.
 */
export class BlobFill {
  private readonly _blocks: BlobBlock[] = [];
  private readonly _offsets: number[] = [];
  private _bytes = 0;
  private _blobId?: string;
  private _error?: Error;
  private _readers = 0;
  private _changed!: Promise<void>;
  private _signal!: () => void;
  private readonly _done: Promise<{ blobId: string; size: number }>;
  private _resolveDone!: (value: { blobId: string; size: number }) => void;
  private _rejectDone!: (error: Error) => void;

  // ...........................................................................
  /**
   * Starts an empty fill.
   * @param _bs - The store the blocks are in.
   * @param expectedSize - The blob's size when known, else -1.
   */
  constructor(
    private readonly _bs: Bs,
    readonly expectedSize: number,
  ) {
    this._arm();
    this._done = new Promise((resolve, reject) => {
      this._resolveDone = resolve;
      this._rejectDone = reject;
    });
    // Nobody may ever ask; a failure must not end up unhandled.
    this._done.catch(() => undefined);
  }

  // ...........................................................................
  /**
   * A complete fill of a stored blob.
   * @param bs - The store.
   * @param blobId - The blob.
   * @returns The fill.
   */
  static async stored(bs: Bs, blobId: string): Promise<BlobFill> {
    const blocks = await bs.getBlobBlocks(blobId);
    const size = blocks.reduce((sum, block) => sum + block.size, 0);
    const fill = new BlobFill(bs, size);
    for (const block of blocks) fill.append(block);
    fill.complete(blobId);
    return fill;
  }

  // ...........................................................................
  /**
   * An empty fill of unknown size over an in-memory store, for tests and docs.
   * @returns The fill.
   */
  static example(): BlobFill {
    return new BlobFill(new BsMem(), -1);
  }

  // ...........................................................................
  /**
   * Adds the next block. Store it first: readers read it at once.
   * @param block - The block.
   */
  append(block: BlobBlock): void {
    if (this._ended) throw new Error('The fill already ended');
    this._offsets.push(this._bytes);
    this._blocks.push(block);
    this._bytes += block.size;
    this._wake();
  }

  // ...........................................................................
  /**
   * Ends the fill: every block is there and they make `blobId`.
   * @param blobId - The blob the blocks make.
   */
  complete(blobId: string): void {
    if (this._ended) return;
    this._blobId = blobId;
    this._resolveDone({ blobId, size: this._bytes });
    this._wake();
  }

  // ...........................................................................
  /**
   * Ends the fill without a blob. Readers fail with the error.
   * @param error - Why.
   */
  fail(error: Error): void {
    if (this._ended) return;
    this._error = error;
    this._rejectDone(error);
    this._wake();
  }

  // ...........................................................................
  /**
   * Resolves once the fill is complete; rejects when it fails.
   * @returns The blob and its size.
   */
  done(): Promise<{ blobId: string; size: number }> {
    return this._done;
  }

  // ...........................................................................
  /**
   * Streams the bytes `[start, end)` — the whole blob when omitted — as they
   * arrive. A range past the end streams nothing.
   * @param range - The bytes.
   * @param range.start - The first byte.
   * @param range.end - After the last byte; the end of the blob when omitted.
   * @returns The stream.
   */
  stream(range: { start: number; end?: number } = { start: 0 }): ReadableStream<Uint8Array> {
    let position = range.start;
    let open = true;
    this._readers++;
    const leave = () => {
      if (!open) return;
      open = false;
      this._readers--;
    };
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          for (;;) {
            const end = Math.min(range.end ?? Infinity, this._size);
            if (position >= end) {
              leave();
              controller.close();
              return;
            }
            const index = this._blockAt(position);
            if (index !== undefined) {
              const first = this._offsets[index];
              const bytes = await this._bs.getBlock(this._blocks[index].blockId);
              const part = bytes.subarray(
                position - first,
                Math.min(end, first + bytes.length) - first,
              );
              position += part.length;
              controller.enqueue(
                new Uint8Array(part.buffer, part.byteOffset, part.length),
              );
              return;
            }
            if (this._error) throw this._error;
            await this._changed;
          }
        } catch (error) {
          leave();
          throw error;
        }
      },
      cancel: leave,
    });
  }

  // ...........................................................................
  /** The blocks so far, in order. */
  get blocks(): readonly BlobBlock[] {
    return this._blocks;
  }

  /** The bytes so far. */
  get bytes(): number {
    return this._bytes;
  }

  /** Whether the fill is complete. */
  get isDone(): boolean {
    return this._blobId !== undefined;
  }

  /** The blob, once complete. */
  get blobId(): string | undefined {
    return this._blobId;
  }

  /** Why the fill failed, once it did. */
  get error(): Error | undefined {
    return this._error;
  }

  /** How many streams read it right now. */
  get readers(): number {
    return this._readers;
  }

  // ...........................................................................
  /** Whether the fill ended, complete or failed. */
  private get _ended(): boolean {
    return this._blobId !== undefined || this._error !== undefined;
  }

  // ...........................................................................
  /** The size so far as far as readers may go: unknown means "all of it". */
  private get _size(): number {
    if (this.isDone) return this._bytes;
    return this.expectedSize >= 0 ? this.expectedSize : Infinity;
  }

  // ...........................................................................
  /**
   * The block holding a byte, if it arrived.
   * @param position - The byte.
   * @returns The block's index, or undefined.
   */
  private _blockAt(position: number): number | undefined {
    if (position >= this._bytes) return undefined;
    let low = 0;
    let high = this._offsets.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this._offsets[middle] <= position) low = middle;
      else high = middle - 1;
    }
    return low;
  }

  // ...........................................................................
  /** Arms the promise readers wait on for the next change. */
  private _arm(): void {
    this._changed = new Promise((resolve) => (this._signal = resolve));
  }

  // ...........................................................................
  /** Wakes every waiting reader. */
  private _wake(): void {
    const signal = this._signal;
    this._arm();
    signal();
  }
}
