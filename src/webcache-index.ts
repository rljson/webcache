// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { hip } from '@rljson/hash';
import { Io, IoMem } from '@rljson/io';
import { Rljson, TableCfg } from '@rljson/rljson';

// #############################################################################
/**
 * Where an entry stands on the node that wrote it.
 *
 * - `downloading` — the node downloads it now: a claim the others wait for
 * - `cached` / `pinned` — the node holds it; a pinned one never expires
 * - `failed` — the download broke off or was given up
 * - `removed` — the node no longer holds it
 */
export type EntryState =
  | 'downloading'
  | 'cached'
  | 'pinned'
  | 'failed'
  | 'removed';

// #############################################################################
/** One row of the index: what a node knows about one key. */
export interface WebcacheEntry {
  /** The hash of the key; what a lookup asks for. */
  keyHash: string;

  /** The key itself. */
  key: string;

  /** Where the entry stands. */
  state: EntryState;

  /** The blob holding the content; empty while it downloads. */
  blobId: string;

  /** The size in bytes; the expected one while it downloads, -1 unknown. */
  size: number;

  /** The content type the content was served with. */
  contentType: string;

  /** Who asked for it, e.g. a sync of graphic files. */
  consumer: string;

  /** Where the node got it from: `cloud`, `fleet`, or empty. */
  source: string;

  /** When the node got it, in ms since the epoch; 0 while it downloads. */
  fetchedAt: number;

  /** When the row was written, in ms since the epoch of the writing node. */
  at: number;

  /** The node that wrote the row. */
  nodeId: string;
}

// .............................................................................
/** A row as it is written, before the index stamps node and time. */
export type WebcacheDraft = Omit<WebcacheEntry, 'at' | 'nodeId'>;

// .............................................................................
/** The table of the index. */
export const webcacheEntriesTableCfg: TableCfg = (() => {
  const column = (key: string, type: 'string' | 'number') => ({
    key,
    type,
    titleLong: key,
    titleShort: key,
  });
  return hip({
    key: 'webcacheEntries',
    type: 'components',
    columns: [
      column('_hash', 'string'),
      column('keyHash', 'string'),
      column('key', 'string'),
      column('state', 'string'),
      column('blobId', 'string'),
      column('size', 'number'),
      column('contentType', 'string'),
      column('consumer', 'string'),
      column('source', 'string'),
      column('fetchedAt', 'number'),
      column('at', 'number'),
      column('nodeId', 'string'),
    ],
    isHead: false,
    isRoot: false,
    isShared: true,
    _hash: '',
  }) as TableCfg;
})();

// #############################################################################
/**
 * The index of one node: which keys it holds, downloads, gave up or removed.
 *
 * Rows are only ever added; the newest row of a key decides. Other nodes read
 * it through peer reads, so the index is never pushed anywhere.
 */
export class WebcacheIndex {
  private _lastAt = 0;

  // ...........................................................................
  /**
   * Use {@link WebcacheIndex.open}.
   * @param _io - The store.
   * @param _nodeId - The node writing the rows.
   * @param _clock - The time in ms.
   */
  private constructor(
    private readonly _io: Io,
    private readonly _nodeId: string,
    private readonly _clock: () => number,
  ) {}

  // ...........................................................................
  /**
   * Opens the index in a store, creating its table when missing.
   * @param io - The store.
   * @param options - The node writing the rows, and the clock.
   * @param options.nodeId - The node.
   * @param options.clock - The time in ms; the system clock when omitted.
   * @returns The index.
   */
  static async open(
    io: Io,
    options: { nodeId: string; clock?: () => number },
  ): Promise<WebcacheIndex> {
    await io.createOrExtendTable({ tableCfg: webcacheEntriesTableCfg });
    return new WebcacheIndex(io, options.nodeId, options.clock ?? Date.now);
  }

  // ...........................................................................
  /**
   * An index over a fresh in-memory store, for tests and docs.
   * @returns The index.
   */
  static async example(): Promise<WebcacheIndex> {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    return WebcacheIndex.open(io, { nodeId: 'node-example' });
  }

  // ...........................................................................
  /**
   * Adds a row, stamped with this node and a time later than every row
   * before it.
   * @param entry - The row without stamp.
   * @returns The row as written.
   */
  async write(entry: WebcacheDraft): Promise<WebcacheEntry> {
    this._lastAt = Math.max(this._clock(), this._lastAt + 1);
    const row: WebcacheEntry = { ...entry, at: this._lastAt, nodeId: this._nodeId };
    await this._io.write({
      data: {
        [WebcacheIndex.table]: { _type: 'components', _data: [{ ...row }] },
      } as unknown as Rljson,
    });
    return row;
  }

  // ...........................................................................
  /**
   * The newest row of a key.
   * @param keyHash - The key's hash.
   * @returns The row, or undefined.
   */
  async latest(keyHash: string): Promise<WebcacheEntry | undefined> {
    const rows = WebcacheIndex.rowsOf(
      await this._io.readRows(WebcacheIndex.query(keyHash)),
    );
    return WebcacheIndex.newest(rows);
  }

  // ...........................................................................
  /**
   * The newest row of every key, oldest first.
   * @returns The rows.
   */
  async all(): Promise<WebcacheEntry[]> {
    return WebcacheIndex.newestPerKey(
      WebcacheIndex.rowsOf(await this._io.dumpTable({ table: WebcacheIndex.table })),
    );
  }

  // ...........................................................................
  /**
   * The newest row of every key among some rows, oldest first.
   * @param rows - The rows.
   * @returns One row per key.
   */
  static newestPerKey(rows: WebcacheEntry[]): WebcacheEntry[] {
    const newest = new Map<string, WebcacheEntry>();
    for (const row of rows) {
      newest.set(
        row.keyHash,
        WebcacheIndex.newest([newest.get(row.keyHash), row]) as WebcacheEntry,
      );
    }
    return [...newest.values()].sort((a, b) => a.at - b.at);
  }

  // ...........................................................................
  /** The table of the index. */
  static readonly table = 'webcacheEntries';

  // ...........................................................................
  /**
   * The read of one key's rows, as a peer answers it.
   * @param keyHash - The key's hash.
   * @returns The read.
   */
  static query(keyHash: string): {
    table: string;
    where: { keyHash: string };
  } {
    return { table: WebcacheIndex.table, where: { keyHash } };
  }

  // ...........................................................................
  /**
   * The index rows of a read or a dump, without their hashes.
   * @param rljson - The result of a read.
   * @returns The rows.
   */
  static rowsOf(rljson: Rljson): WebcacheEntry[] {
    const table = (rljson as Record<string, { _data?: unknown[] }>)[
      WebcacheIndex.table
    ];
    return (table?._data ?? []).map((row) => {
      const entry = { ...(row as object) } as WebcacheEntry & { _hash?: string };
      delete entry._hash;
      return entry;
    });
  }

  // ...........................................................................
  /**
   * The newest of some rows: the latest time, of equal times the node that
   * sorts last.
   * @param rows - The rows; undefined ones are skipped.
   * @returns The newest, or undefined.
   */
  static newest(
    rows: (WebcacheEntry | undefined)[],
  ): WebcacheEntry | undefined {
    let newest: WebcacheEntry | undefined;
    for (const row of rows) {
      if (row === undefined) continue;
      if (
        newest === undefined ||
        row.at > newest.at ||
        (row.at === newest.at && row.nodeId > newest.nodeId)
      ) {
        newest = row;
      }
    }
    return newest;
  }

  // ...........................................................................
  /**
   * Whether a row says its node holds the content.
   * @param entry - The row.
   * @returns True for cached and pinned entries.
   */
  static isLive(entry: WebcacheEntry | undefined): boolean {
    return entry?.state === 'cached' || entry?.state === 'pinned';
  }

  // ...........................................................................
  /**
   * A realistic row as it is written, for tests and docs.
   * @param overrides - The values to change.
   * @returns The row without stamp.
   */
  static exampleDraft(overrides: Partial<WebcacheDraft> = {}): WebcacheDraft {
    const entry: Partial<WebcacheEntry> = WebcacheIndex.exampleEntry(overrides);
    delete entry.at;
    delete entry.nodeId;
    return entry as WebcacheDraft;
  }

  // ...........................................................................
  /**
   * A realistic row, for tests and docs.
   * @param overrides - The values to change.
   * @returns The row.
   */
  static exampleEntry(overrides: Partial<WebcacheEntry> = {}): WebcacheEntry {
    return {
      keyHash: 'Ae9hC2_xWm8sYp1nQ4rT0u',
      key: 'https://downloads.example.com/catalogue/2026-11.zip',
      state: 'cached',
      blobId: 'Bq7fK3_zXn5tVr2mP8sL1w',
      size: 147_862,
      contentType: 'application/zip',
      consumer: 'example',
      source: 'cloud',
      fetchedAt: 1_000,
      at: 1_000,
      nodeId: 'node-example',
      ...overrides,
    };
  }
}
