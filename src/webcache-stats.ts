// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { readFile, rename, writeFile } from 'node:fs/promises';

// #############################################################################
/** Where an answer came from. */
export type WebcacheSource = 'local' | 'fleet' | 'cloud';

// #############################################################################
/** Requests and bytes, counted together. */
export interface StatTotals {
  /** Requests answered. */
  requests: number;

  /** Requests by where the answer came from. */
  hits: Record<WebcacheSource, number>;

  /** Bytes sent to requesters. */
  bytesServed: number;

  /** Of them, bytes that came from the cloud. */
  bytesFromCloud: number;
}

// #############################################################################
/** The numbers of one file. */
export interface FileStats extends StatTotals {
  /** When it was first asked for, in ms since the epoch. */
  firstAccess: number;

  /** When it was last asked for, in ms since the epoch. */
  lastAccess: number;
}

// .............................................................................
/** What the journal keeps on disk. */
interface _Journal {
  files: Record<string, FileStats>;
  all: StatTotals;
  today: StatTotals & { day: string };
  byConsumer: Record<string, StatTotals>;
}

// .............................................................................
const _totals = (): StatTotals => ({
  requests: 0,
  hits: { local: 0, fleet: 0, cloud: 0 },
  bytesServed: 0,
  bytesFromCloud: 0,
});

// .............................................................................
const _dayOf = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// #############################################################################
/**
 * The numbers of a webcache: requests and bytes per file, per consumer and
 * today, and when each file was last asked for — which its lifetime counts
 * from.
 *
 * Kept in memory and written to a file now and then, never into the index:
 * a number that changes with every request is no row to share.
 */
export class WebcacheStats {
  private _dirty = false;
  private _timer?: ReturnType<typeof setTimeout>;
  private _writing: Promise<void> = Promise.resolve();

  // ...........................................................................
  /**
   * Use {@link WebcacheStats.open}.
   * @param _journal - The numbers.
   * @param _file - Where they are kept, if anywhere.
   * @param _clock - The time in ms.
   * @param _flushMs - How long changes may wait before they are written.
   */
  private constructor(
    private _journal: _Journal,
    private readonly _file: string | undefined,
    private readonly _clock: () => number,
    private readonly _flushMs: number,
  ) {}

  // ...........................................................................
  /**
   * Opens the journal, with the numbers of its file when there is one.
   * @param options - File, clock, flush period.
   * @param options.file - Where the numbers are kept; in memory only when
   * omitted.
   * @param options.clock - The time in ms; the system clock when omitted.
   * @param options.flushMs - How long changes may wait before they are
   * written; 0 writes only on flush and close. Default 30 000 ms.
   * @returns The journal.
   */
  static async open(options: {
    file?: string;
    clock?: () => number;
    flushMs?: number;
  }): Promise<WebcacheStats> {
    const clock = options.clock ?? Date.now;
    let journal: _Journal = {
      files: {},
      all: _totals(),
      today: { day: _dayOf(clock()), ..._totals() },
      byConsumer: {},
    };
    if (options.file) {
      try {
        journal = JSON.parse(await readFile(options.file, 'utf8')) as _Journal;
      } catch {
        // No file yet, or a broken one: start empty.
      }
    }
    return new WebcacheStats(journal, options.file, clock, options.flushMs ?? 30_000);
  }

  // ...........................................................................
  /**
   * An empty journal in memory, for tests and docs.
   * @returns The journal.
   */
  static example(): WebcacheStats {
    return new WebcacheStats(
      { files: {}, all: _totals(), today: { day: '2026-11-05', ..._totals() }, byConsumer: {} },
      undefined,
      Date.now,
      0,
    );
  }

  // ...........................................................................
  /**
   * Counts a request for a file.
   * @param keyHash - The file's key hash.
   * @param source - Where the answer came from.
   * @param consumer - Who asked.
   */
  request(keyHash: string, source: WebcacheSource, consumer: string): void {
    const now = this._clock();
    const file = this._file_(keyHash, now);
    file.lastAccess = now;
    const consumerTotals = (this._journal.byConsumer[consumer] ??= _totals());
    for (const totals of [file, this._today(), this._journal.all, consumerTotals]) {
      totals.requests++;
      totals.hits[source]++;
    }
    this._changed();
  }

  // ...........................................................................
  /**
   * Counts bytes sent for a file.
   * @param keyHash - The file's key hash.
   * @param bytes - How many.
   * @param source - Where they came from.
   * @param consumer - Who asked; counted under no consumer when omitted.
   */
  served(keyHash: string, bytes: number, source: WebcacheSource, consumer?: string): void {
    const file = this._file_(keyHash, this._clock());
    const all = [file, this._today(), this._journal.all];
    if (consumer !== undefined) all.push((this._journal.byConsumer[consumer] ??= _totals()));
    for (const totals of all) {
      totals.bytesServed += bytes;
      if (source === 'cloud') totals.bytesFromCloud += bytes;
    }
    this._changed();
  }

  // ...........................................................................
  /**
   * The numbers of a file.
   * @param keyHash - The file's key hash.
   * @returns The numbers, or undefined.
   */
  of(keyHash: string): FileStats | undefined {
    return this._journal.files[keyHash];
  }

  // ...........................................................................
  /**
   * When a file was last asked for.
   * @param keyHash - The file's key hash.
   * @returns The time in ms, or undefined.
   */
  lastAccess(keyHash: string): number | undefined {
    return this._journal.files[keyHash]?.lastAccess;
  }

  // ...........................................................................
  /**
   * The numbers of all files, of today and by consumer.
   * @returns The totals.
   */
  totals(): {
    all: StatTotals;
    today: StatTotals & { day: string };
    byConsumer: Record<string, StatTotals>;
  } {
    return {
      all: this._journal.all,
      today: this._today(),
      byConsumer: this._journal.byConsumer,
    };
  }

  // ...........................................................................
  /**
   * Drops the numbers of a file that is gone.
   * @param keyHash - The file's key hash.
   */
  forget(keyHash: string): void {
    delete this._journal.files[keyHash];
    this._changed();
  }

  // ...........................................................................
  /** Writes the numbers to the file, if anything changed. */
  flush(): Promise<void> {
    clearTimeout(this._timer);
    this._timer = undefined;
    if (!this._dirty || !this._file) return this._writing;
    this._dirty = false;
    const file = this._file;
    const text = JSON.stringify(this._journal);
    this._writing = this._writing.then(async () => {
      const temp = `${file}.tmp`;
      await writeFile(temp, text);
      await rename(temp, file);
    });
    return this._writing;
  }

  // ...........................................................................
  /** Writes what changed and stops writing on its own. */
  async close(): Promise<void> {
    await this.flush();
  }

  // ...........................................................................
  /**
   * The numbers of a file, created on first use.
   * @param keyHash - The file's key hash.
   * @param now - The time.
   * @returns The numbers.
   */
  private _file_(keyHash: string, now: number): FileStats {
    return (this._journal.files[keyHash] ??= {
      ..._totals(),
      firstAccess: now,
      lastAccess: now,
    });
  }

  // ...........................................................................
  /**
   * Today's numbers, started anew on a new day.
   * @returns The numbers.
   */
  private _today(): StatTotals & { day: string } {
    const day = _dayOf(this._clock());
    if (this._journal.today.day !== day) this._journal.today = { day, ..._totals() };
    return this._journal.today;
  }

  // ...........................................................................
  /** Marks a change and writes it after the flush period. */
  private _changed(): void {
    this._dirty = true;
    if (this._flushMs <= 0 || this._timer) return;
    this._timer = setTimeout(() => void this.flush(), this._flushMs);
    this._timer.unref?.();
  }
}
