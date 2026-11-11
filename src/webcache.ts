// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Bs, BsMem } from '@rljson/bs';
import { Io, IoMem } from '@rljson/io';
import { noopLogger, ServerLogger } from '@rljson/server';
import { statfs } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { BlobFill } from './blob-fill.ts';
import { CloudDownload } from './cloud-download.ts';
import { Fleet, FleetHolder } from './fleet.ts';
import { FleetTransfer } from './fleet-transfer.ts';
import { FetchLike, OriginFetch } from './origin-fetch.ts';
import { WebcacheError } from './webcache-error.ts';
import { WebcacheDraft, WebcacheEntry, WebcacheIndex } from './webcache-index.ts';
import { keyOf, redactUrl } from './webcache-key.ts';
import { FileStats, StatTotals, WebcacheSource, WebcacheStats } from './webcache-stats.ts';

// #############################################################################
/** What a webcache does, changeable while it runs. */
export interface WebcacheSettings {
  /** The hosts it may download from: `host` or `*.domain`. */
  allowedHosts: string[];

  /** An HTTP proxy to reach the cloud through. */
  proxy?: string;

  /** How long an entry lives after its last request. Default 30 days. */
  lifetimeMs: number;

  /** How many bytes the store may hold. Default 50 GiB. */
  diskBudgetBytes: number;

  /** The share of the disk that must stay free, in percent. Default 10. */
  minFreeDiskPercent: number;

  /** Whether other nodes are asked before the cloud. Default true. */
  fleetEnabled: boolean;

  /** Longest a request waits for another node's download. Default 240 000 ms. */
  waitMs: number;

  /** How long a claim settles before rivals are compared. Default 250 ms. */
  claimSettleMs: number;

  /** How often a download renews its claim. Default 10 000 ms. */
  heartbeatMs: number;

  /** A claim not renewed for this long is given up. Default 30 000 ms. */
  staleMs: number;

  /** How often a waiting request asks again. Default 500 ms. */
  pollMs: number;

  /** How often expired entries are swept; 0 is never. Default 600 000 ms. */
  sweepIntervalMs: number;

  /** A blob no entry holds is kept this long before it goes. Default 600 000 ms. */
  orphanGraceMs: number;
}

// .............................................................................
/** The settings a webcache starts with. */
export const defaultWebcacheSettings: WebcacheSettings = {
  allowedHosts: [],
  lifetimeMs: 30 * 24 * 60 * 60 * 1000,
  diskBudgetBytes: 50 * 1024 ** 3,
  minFreeDiskPercent: 10,
  fleetEnabled: true,
  waitMs: 240_000,
  claimSettleMs: 250,
  heartbeatMs: 10_000,
  staleMs: 30_000,
  pollMs: 500,
  sweepIntervalMs: 600_000,
  orphanGraceMs: 600_000,
};

// .............................................................................
/** How far the clocks of two machines may differ. */
const _SKEW_MS = 5 * 60_000;

// .............................................................................
/** Swallows the failure of something nobody waits for. */
const _ignore = (): undefined => undefined;

// #############################################################################
/** What the store can tell and do beyond the `Bs` interface. */
export interface WebcacheMaintenance {
  /** Frees blocks no blob references any more. */
  collectGarbage(): Promise<{ removedBlocks: number; freedBytes: number }>;

  /** Counts what the store holds on disk. */
  usage(): Promise<{ blobs: number; blocks: number; bytes: number }>;
}

// #############################################################################
/** Options of {@link Webcache.open}. */
export interface WebcacheOptions extends Partial<WebcacheSettings> {
  /** The local rows: the index. */
  io: Io;

  /** The local blobs. */
  bs: Bs;

  /** This node. */
  nodeId: string;

  /** Where the numbers are kept; in memory when omitted. */
  statsFile?: string;

  /** The store's folder, to measure the free disk. */
  folder?: string;

  /** Garbage collection and disk usage of the store. */
  maintenance?: WebcacheMaintenance;

  /** Measures the disk; by `folder` when omitted. */
  diskSpace?: () => Promise<{ free: number; total: number } | undefined>;

  /** The fetch for the cloud; the platform's when omitted. */
  fetch?: FetchLike;

  /** The wait before a broken download is resumed. Default 1000 ms. */
  retryDelayMs?: number;

  /** The time in ms; the system clock when omitted. */
  clock?: () => number;

  /** Logs downloads and failures. */
  logger?: ServerLogger;
}

// #############################################################################
/** A request for some content. */
export interface WebcacheRequest {
  /** The key; the URL's key when omitted. */
  key?: string;

  /** Where the content is downloaded from on a miss. */
  url: string;

  /** The size it must have; unchecked when omitted or -1. */
  size?: number;

  /** Who asks, e.g. a sync of graphic files. */
  consumer?: string;

  /** Headers for the cloud, e.g. an authorization. Never stored. */
  headers?: Record<string, string>;
}

// #############################################################################
/** The answer to a request. */
export interface WebcacheResponse {
  /** Where it comes from. */
  source: WebcacheSource;

  /** The key. */
  key: string;

  /** The key's hash. */
  keyHash: string;

  /** The size, -1 while unknown. */
  size: number;

  /** The content type. */
  contentType: string;

  /** The blob, when it is stored already. */
  blobId?: string;

  /**
   * The bytes, or a range of them, as they arrive.
   * @param range - The bytes `[start, end)`; all when omitted.
   */
  body(range?: { start: number; end?: number }): ReadableStream<Uint8Array>;

  /** Resolves once the content is stored here. */
  finished: Promise<WebcacheEntry>;

  /**
   * Counts the bytes sent to the requester.
   * @param bytes - How many.
   */
  served(bytes: number): void;
}

// #############################################################################
/**
 * The answer to {@link Webcache.poll}: the complete content, or pending
 * while it is still on its way.
 */
export type WebcachePoll =
  | { state: 'pending' }
  | { state: 'ready'; response: WebcacheResponse };

// #############################################################################
/** An entry as it is shown. */
export interface WebcacheEntryView extends WebcacheEntry {
  /** Its numbers. */
  stats: FileStats | undefined;

  /** When it was last asked for, else when it was stored. */
  lastAccess: number;

  /** When its lifetime ends; null when pinned. */
  expiresAt: number | null;
}

// #############################################################################
/** A request on its way: looked up, waited for, downloaded or copied. */
export interface WebcacheDownloadView {
  keyHash: string;
  key: string;
  consumer: string;
  stage: 'looking' | 'waiting' | 'transferring' | 'downloading';
  source?: 'fleet' | 'cloud';
  waitingFor?: string;
  from?: string[];
  bytes: number;
  size: number;
  startedAt: number;
  bytesPerSecond: number;
}

// #############################################################################
/** What a webcache holds and did. */
export interface WebcacheSummary {
  nodeId: string;
  entries: number;
  pinned: number;
  bytes: number;
  usageBytes?: number;
  diskBudgetBytes: number;
  disk?: { free: number; total: number };
  downloads: number;
  fleet: { attached: boolean; connectedNodes: string[] };
  totals: { all: StatTotals; today: StatTotals & { day: string }; byConsumer: Record<string, StatTotals> };
}

// #############################################################################
/** What a sweep removed. */
export interface WebcacheSweepResult {
  expired: number;
  evicted: number;
  orphans: number;
  freedBytes: number;
  usageBytes?: number;
}

// .............................................................................
/** Something to read: a fill, where it comes from, when it is stored. */
interface _Ready {
  source: WebcacheSource;
  fill: BlobFill;
  contentType: string;
  finished: Promise<WebcacheEntry>;
}

// .............................................................................
/** A request on its way. */
interface _Flight {
  keyHash: string;
  key: string;
  consumer: string;
  stage: WebcacheDownloadView['stage'];
  source?: 'fleet' | 'cloud';
  waitingFor?: string;
  from?: string[];
  fill?: BlobFill;
  startedAt: number;
  startedTick: number;
  deadline: number;
  abort?: () => void;
  ready: Promise<_Ready>;
}

// .............................................................................
/** A request answered as pending: what it waits for, and how that ended. */
interface _Poll {
  /** Whether it joined a request that was on its way already. */
  joined: boolean;

  /** Resolves once the content is complete and stored. */
  settled: Promise<_Ready>;

  /** How it ended; unset while it is on its way. */
  outcome?: { ready: _Ready } | { error: unknown };

  /** When it ended. */
  settledAt?: number;
}

// .............................................................................
/** How long the outcome of a pending request waits to be asked for. */
const _POLL_KEEP_MS = 60_000;

// #############################################################################
/**
 * Downloaded content as a cache that the nodes of a network share.
 *
 * A request is answered from this node's store; else from another node that
 * holds it, or downloads it right now; else from the cloud — downloaded once,
 * served while it arrives, stored, and so available to every other node.
 * Requests for the same key share one answer.
 */
export class Webcache {
  private readonly _flights = new Map<string, _Flight>();
  private readonly _polls = new Map<string, _Poll>();
  private readonly _reading = new Map<string, Set<BlobFill>>();
  private readonly _claimsSeen = new Map<string, { at: number; since: number }>();
  private readonly _clock: () => number;
  private readonly _logger: ServerLogger;
  private _settings: WebcacheSettings;
  private _origin!: OriginFetch;
  private _fleet?: Fleet;
  private _sweepTimer?: ReturnType<typeof setInterval>;
  private _sweeping?: Promise<WebcacheSweepResult>;
  private _closed = false;

  // ...........................................................................
  /**
   * Use {@link Webcache.open}.
   * @param _options - Stores and settings.
   * @param _index - The index.
   * @param stats - The numbers.
   */
  private constructor(
    private readonly _options: WebcacheOptions,
    private readonly _index: WebcacheIndex,
    readonly stats: WebcacheStats,
  ) {
    this._clock = _options.clock ?? Date.now;
    this._logger = _options.logger ?? noopLogger;
    this._settings = { ...defaultWebcacheSettings };
    this.reconfigure(_options);
  }

  // ...........................................................................
  /**
   * Opens a webcache over its local stores.
   * @param options - Stores, node and settings.
   * @returns The webcache.
   */
  static async open(options: WebcacheOptions): Promise<Webcache> {
    const index = await WebcacheIndex.open(options.io, {
      nodeId: options.nodeId,
      clock: options.clock,
    });
    const stats = await WebcacheStats.open({ file: options.statsFile, clock: options.clock });
    return new Webcache(options, index, stats);
  }

  // ...........................................................................
  /**
   * A webcache in memory allowing `downloads.example.com`, for tests and docs.
   * @returns The webcache.
   */
  static async example(): Promise<Webcache> {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    return Webcache.open({
      io,
      bs: new BsMem(),
      nodeId: 'node-example',
      allowedHosts: ['downloads.example.com'],
    });
  }

  // ...........................................................................
  /**
   * Answers a request: from this node, the fleet or the cloud.
   * @param request - What is asked for.
   * @returns The answer, readable at once.
   */
  fetch(request: WebcacheRequest): Promise<WebcacheResponse> {
    return this._fetch(request, true);
  }

  // ...........................................................................
  /**
   * Answers a request only with complete content. Content that is held, or
   * gets complete within `waitMs`, is ready; anything else is pending, and
   * keeps coming meanwhile. Asked again with the same request, it answers
   * the content once it is complete — or fails with what stopped it. The
   * outcome waits a minute to be asked for.
   * @param request - What is asked for.
   * @param waitMs - How long to wait for the content to complete.
   * @returns Ready with the complete content, or pending.
   */
  async poll(request: WebcacheRequest, waitMs: number): Promise<WebcachePoll> {
    if (this._closed) throw new WebcacheError('closed', 'The webcache is closed');
    const { key, keyHash } = Webcache._parse(request);
    const consumer = request.consumer ?? 'default';
    this._forgetOldPolls();
    let poll = this._polls.get(keyHash);
    if (!poll) {
      const flight = this._flights.get(keyHash);
      poll = this._startPoll(
        flight ?? this._startFlight(key, keyHash, request, consumer),
        flight !== undefined,
      );
      this._polls.set(keyHash, poll);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      poll.settled.catch(_ignore),
      new Promise((resolve) => (timer = setTimeout(resolve, waitMs))),
    ]);
    clearTimeout(timer);

    const outcome = poll.outcome;
    if (outcome === undefined) return { state: 'pending' };
    this._polls.delete(keyHash);
    if ('error' in outcome) throw outcome.error;
    const source = poll.joined ? 'local' : outcome.ready.source;
    return {
      state: 'ready',
      response: this._respond(outcome.ready, source, key, keyHash, consumer, true),
    };
  }

  // ...........................................................................
  /**
   * Starts asking the fleet before the cloud.
   * @param fleet - The other nodes.
   */
  attach(fleet: Fleet): void {
    this._fleet = fleet;
  }

  // ...........................................................................
  /** Stops asking the fleet. */
  detach(): void {
    this._fleet = undefined;
  }

  // ...........................................................................
  /** The local rows: the index. */
  get io(): Io {
    return this._options.io;
  }

  // ...........................................................................
  /** The local blobs. */
  get bs(): Bs {
    return this._options.bs;
  }

  // ...........................................................................
  /** The fleet while attached. */
  get fleet(): Fleet | undefined {
    return this._fleet;
  }

  // ...........................................................................
  /** The settings in force. */
  get settings(): WebcacheSettings {
    return this._settings;
  }

  // ...........................................................................
  /**
   * Changes settings while running.
   * @param settings - The settings to change.
   */
  reconfigure(settings: Partial<WebcacheSettings>): void {
    const changed: Partial<WebcacheSettings> = {};
    for (const key of Object.keys(defaultWebcacheSettings).concat('proxy')) {
      const value = (settings as Record<string, unknown>)[key];
      if (value !== undefined) (changed as Record<string, unknown>)[key] = value;
    }
    this._settings = { ...this._settings, ...changed };
    this._origin = new OriginFetch({
      allowedHosts: this._settings.allowedHosts,
      proxy: this._settings.proxy,
      fetch: this._options.fetch,
    });
    clearInterval(this._sweepTimer);
    this._sweepTimer = undefined;
    if (this._settings.sweepIntervalMs > 0 && !this._closed) {
      this._sweepTimer = setInterval(
        () => void this.sweep().catch(this._ignoreSweepFailure),
        this._settings.sweepIntervalMs,
      );
      this._sweepTimer.unref?.();
    }
  }

  // ...........................................................................
  /**
   * What this node holds.
   * @returns The entries, oldest first.
   */
  async entries(): Promise<WebcacheEntryView[]> {
    return (await this._live()).map((entry) => {
      const stats = this.stats.of(entry.keyHash);
      const lastAccess = stats?.lastAccess ?? entry.fetchedAt;
      return {
        ...entry,
        stats,
        lastAccess,
        expiresAt: entry.state === 'pinned' ? null : lastAccess + this._settings.lifetimeMs,
      };
    });
  }

  // ...........................................................................
  /**
   * Removes an entry, and its blob unless another entry holds the same
   * content or somebody reads it right now — a sweep takes it later.
   * @param keyHash - The entry's key hash.
   * @returns False when this node does not hold it.
   */
  async remove(keyHash: string): Promise<boolean> {
    const latest = await this._index.latest(keyHash);
    if (!WebcacheIndex.isLive(latest)) return false;
    const entry = latest as WebcacheEntry;
    await this._index.write({ ...Webcache._draft(entry), state: 'removed' });
    this.stats.forget(keyHash);
    const held = (await this._live()).some((e) => e.blobId === entry.blobId);
    if (!held && !this._busy(keyHash)) await this._deleteBlob(entry.blobId);
    return true;
  }

  // ...........................................................................
  /**
   * Pins an entry: it never expires.
   * @param keyHash - The entry's key hash.
   * @returns False when this node does not hold it.
   */
  pin(keyHash: string): Promise<boolean> {
    return this._restate(keyHash, 'pinned');
  }

  // ...........................................................................
  /**
   * Unpins an entry: it expires again.
   * @param keyHash - The entry's key hash.
   * @returns False when this node does not hold it.
   */
  unpin(keyHash: string): Promise<boolean> {
    return this._restate(keyHash, 'cached');
  }

  // ...........................................................................
  /**
   * Reads an entry whole and checks it against its blob id. A damaged one is
   * removed, so the next request gets it again.
   * @param keyHash - The entry's key hash.
   * @returns Whether it is whole, and why not.
   */
  async verify(keyHash: string): Promise<{ ok: boolean; reason?: string }> {
    const latest = await this._index.latest(keyHash);
    if (!WebcacheIndex.isLive(latest)) return { ok: false, reason: 'Not held here' };
    try {
      const stream = await this._options.bs.getBlobStream((latest as WebcacheEntry).blobId);
      for await (const part of stream as ReadableStream<Uint8Array>) void part;
      return { ok: true };
    } catch (error) {
      await this.remove(keyHash);
      return { ok: false, reason: (error as Error).message };
    }
  }

  // ...........................................................................
  /**
   * Gets content before anybody asks for it, one request after the other.
   * @param requests - What to get.
   * @returns Per request where it came from, or why it failed.
   */
  async prefetch(
    requests: WebcacheRequest[],
  ): Promise<{ key?: string; keyHash?: string; source?: WebcacheSource; error?: string }[]> {
    const results = [];
    for (const request of requests) {
      try {
        const response = await this._fetch(request, false);
        await response.finished;
        results.push({ key: response.key, keyHash: response.keyHash, source: response.source });
      } catch (error) {
        results.push({ error: (error as Error).message });
      }
    }
    return results;
  }

  // ...........................................................................
  /**
   * The requests on their way.
   * @returns One view per request.
   */
  downloads(): WebcacheDownloadView[] {
    const now = performance.now();
    return [...this._flights.values()].map((flight) => {
      const bytes = flight.fill?.bytes ?? 0;
      const seconds = Math.max((now - flight.startedTick) / 1000, 0.001);
      return {
        keyHash: flight.keyHash,
        key: flight.key,
        consumer: flight.consumer,
        stage: flight.stage,
        source: flight.source,
        waitingFor: flight.waitingFor,
        from: flight.from,
        bytes,
        size: flight.fill?.expectedSize ?? -1,
        startedAt: flight.startedAt,
        bytesPerSecond: Math.round(bytes / seconds),
      };
    });
  }

  // ...........................................................................
  /**
   * Sums up what this node holds and did.
   * @returns The summary.
   */
  async summary(): Promise<WebcacheSummary> {
    const live = await this._live();
    return {
      nodeId: this._options.nodeId,
      entries: live.length,
      pinned: live.filter((e) => e.state === 'pinned').length,
      bytes: live.reduce((sum, e) => sum + e.size, 0),
      usageBytes: (await this._options.maintenance?.usage())?.bytes,
      diskBudgetBytes: this._settings.diskBudgetBytes,
      disk: await this._diskSpace(),
      downloads: this._flights.size,
      fleet: {
        attached: this._fleet !== undefined,
        connectedNodes: this._fleet?.connectedNodes ?? [],
      },
      totals: this.stats.totals(),
    };
  }

  // ...........................................................................
  /**
   * Removes what outlived its lifetime, then the least recently used entries
   * while the store is above its budget or the disk below its floor, then
   * blobs no entry holds, and frees their blocks. Pinned entries and what is
   * read or downloaded right now stay.
   * @returns What was removed.
   */
  sweep(): Promise<WebcacheSweepResult> {
    this._sweeping ??= this._sweep().finally(() => (this._sweeping = undefined));
    return this._sweeping;
  }

  // ...........................................................................
  /** Stops every download and sweep, and writes the numbers. */
  async close(): Promise<void> {
    this._closed = true;
    this._polls.clear();
    clearInterval(this._sweepTimer);
    for (const flight of this._flights.values()) flight.abort?.();
    this._fleet = undefined;
    await this.stats.close();
  }

  // ...........................................................................
  /**
   * See {@link fetch}.
   * @param request - What is asked for.
   * @param count - Whether it counts as a request.
   * @returns The answer.
   */
  private async _fetch(request: WebcacheRequest, count: boolean): Promise<WebcacheResponse> {
    if (this._closed) throw new WebcacheError('closed', 'The webcache is closed');
    const { key, keyHash } = Webcache._parse(request);
    const consumer = request.consumer ?? 'default';
    let flight = this._flights.get(keyHash);
    const joined = flight !== undefined;
    if (!flight) flight = this._startFlight(key, keyHash, request, consumer);
    const ready = await flight.ready;
    return this._respond(ready, joined ? 'local' : ready.source, key, keyHash, consumer, count);
  }

  // ...........................................................................
  /**
   * Starts answering a key no other request is answering.
   * @param key - The key.
   * @param keyHash - Its hash.
   * @param request - The request.
   * @param consumer - Who asks.
   * @returns The flight.
   */
  private _startFlight(
    key: string,
    keyHash: string,
    request: WebcacheRequest,
    consumer: string,
  ): _Flight {
    const startedTick = performance.now();
    const flight: _Flight = {
      keyHash,
      key,
      consumer,
      stage: 'looking',
      startedAt: this._clock(),
      startedTick,
      deadline: startedTick + this._settings.waitMs,
      ready: undefined as unknown as Promise<_Ready>,
    };
    this._flights.set(keyHash, flight);
    const end = () => this._flights.delete(keyHash);
    flight.ready = this._fly(flight, request);
    flight.ready.then(
      (ready) => ready.finished.then(end, end),
      end,
    );
    return flight;
  }

  // ...........................................................................
  /**
   * Follows a flight for {@link poll} until its content is stored.
   * @param flight - The flight.
   * @param joined - Whether the flight was on its way already.
   * @returns The poll; its outcome is set once the flight ended.
   */
  private _startPoll(flight: _Flight, joined: boolean): _Poll {
    const poll: _Poll = {
      joined,
      settled: flight.ready.then(async (ready) => {
        await ready.finished;
        return ready;
      }),
    };
    // Set before any waiter of `settled` resumes: they are registered later.
    const settle = (outcome: _Poll['outcome']) => {
      poll.outcome = outcome;
      poll.settledAt = this._clock();
    };
    poll.settled.then(
      (ready) => settle({ ready }),
      (error: unknown) => settle({ error }),
    );
    return poll;
  }

  // ...........................................................................
  /** Forgets the outcomes nobody asked for in time. */
  private _forgetOldPolls(): void {
    const oldest = this._clock() - _POLL_KEEP_MS;
    for (const [keyHash, poll] of this._polls) {
      if (poll.settledAt !== undefined && poll.settledAt < oldest) this._polls.delete(keyHash);
    }
  }

  // ...........................................................................
  /**
   * Finds what to read: this node, the fleet, the cloud.
   * @param flight - The flight.
   * @param request - The request.
   * @returns Something to read.
   */
  private async _fly(flight: _Flight, request: WebcacheRequest): Promise<_Ready> {
    const local = await this._index.latest(flight.keyHash);
    if (
      WebcacheIndex.isLive(local) &&
      Webcache._sizeFits((local as WebcacheEntry).size, request.size) &&
      (await this._options.bs.blobExists((local as WebcacheEntry).blobId))
    ) {
      const entry = local as WebcacheEntry;
      return {
        source: 'local',
        fill: await BlobFill.stored(this._options.bs, entry.blobId),
        contentType: entry.contentType,
        finished: Promise.resolve(entry),
      };
    }
    let mayYield = true;
    if (this._fleetUsable) {
      const found = await this._fromFleet(flight, request);
      if (found !== undefined && found !== 'timeout') return found;
      mayYield = found !== 'timeout';
    }
    return this._fromCloud(flight, request, mayYield);
  }

  // ...........................................................................
  /** Whether the fleet is asked. */
  private get _fleetUsable(): boolean {
    return this._fleet !== undefined && this._settings.fleetEnabled;
  }

  // ...........................................................................
  /**
   * Reads from a node that holds the key; waits while another one downloads
   * it.
   * @param flight - The flight.
   * @param request - The request.
   * @returns Something to read; undefined when nobody has or gets it;
   * 'timeout' when the wait for a download ran out.
   */
  private async _fromFleet(
    flight: _Flight,
    request: WebcacheRequest,
  ): Promise<_Ready | undefined | 'timeout'> {
    for (;;) {
      const lookup = await (this._fleet as Fleet).lookup(flight.keyHash);
      const ready = await this._transfer(flight, request, lookup.holders);
      if (ready) return ready;
      const rivals = lookup.downloading.filter((claim) => this._isFresh(claim));
      if (rivals.length === 0) return undefined;
      if (performance.now() >= flight.deadline) return 'timeout';
      flight.stage = 'waiting';
      flight.waitingFor = rivals[0].nodeId;
      await new Promise((resolve) => setTimeout(resolve, this._settings.pollMs));
      if (!this._fleetUsable) return undefined;
    }
  }

  // ...........................................................................
  /**
   * Starts copying from the holders of the newest version that fits.
   * @param flight - The flight.
   * @param request - The request.
   * @param holders - Who holds the key.
   * @returns Something to read, or undefined when nobody gives it.
   */
  private async _transfer(
    flight: _Flight,
    request: WebcacheRequest,
    holders: FleetHolder[],
  ): Promise<_Ready | undefined> {
    const fitting = holders.filter((h) => Webcache._sizeFits(h.entry.size, request.size));
    if (fitting.length === 0) return undefined;
    const newest = WebcacheIndex.newest(fitting.map((h) => h.entry)) as WebcacheEntry;
    const same = fitting.filter((h) => h.entry.blobId === newest.blobId);
    let transfer: FleetTransfer;
    try {
      transfer = await FleetTransfer.start({
        bs: this._options.bs,
        fleet: this._fleet as Fleet,
        holders: same,
        blobId: newest.blobId,
        size: newest.size,
      });
    } catch (error) {
      this._logger.warn('Webcache', 'No node gave what its index lists', {
        key: flight.key,
        error: (error as Error).message,
      });
      return undefined;
    }
    flight.stage = 'transferring';
    flight.source = 'fleet';
    flight.from = same.map((h) => h.nodeId);
    flight.fill = transfer.fill;
    flight.waitingFor = undefined;
    flight.abort = () => transfer.abort();
    return {
      source: 'fleet',
      fill: transfer.fill,
      contentType: newest.contentType,
      finished: transfer.finished.then(() =>
        this._index.write({
          ...Webcache._draft(newest),
          key: flight.key,
          state: 'cached',
          consumer: flight.consumer,
          source: 'fleet',
          fetchedAt: this._clock(),
        }),
      ),
    };
  }

  // ...........................................................................
  /**
   * Downloads from the cloud, after claiming the key in the fleet: a node
   * with a lower id that claimed it at the same time downloads instead.
   * @param flight - The flight.
   * @param request - The request.
   * @param mayYield - False once a wait for another node ran out.
   * @returns Something to read.
   */
  private async _fromCloud(
    flight: _Flight,
    request: WebcacheRequest,
    mayYield: boolean,
  ): Promise<_Ready> {
    const claim: WebcacheDraft = {
      keyHash: flight.keyHash,
      key: flight.key,
      state: 'downloading',
      blobId: '',
      size: request.size ?? -1,
      contentType: '',
      consumer: flight.consumer,
      source: '',
      fetchedAt: 0,
    };
    await this._index.write(claim);
    if (this._fleetUsable) {
      await new Promise((resolve) => setTimeout(resolve, this._settings.claimSettleMs));
      const lookup = await (this._fleet as Fleet).lookup(flight.keyHash);
      const ready = await this._transfer(flight, request, lookup.holders);
      const rival = lookup.downloading.some(
        (other) => other.nodeId < this._options.nodeId && this._isFresh(other),
      );
      if (ready || (mayYield && rival)) {
        await this._index.write({ ...claim, state: 'failed' });
        if (ready) return ready;
        const found = await this._fromFleet(flight, request);
        if (found !== undefined && found !== 'timeout') return found;
        return this._fromCloud(flight, request, false);
      }
    }

    let download: CloudDownload;
    try {
      download = await CloudDownload.start({
        bs: this._options.bs,
        origin: this._origin,
        url: request.url,
        expectedSize: request.size,
        headers: request.headers,
        retryDelayMs: this._options.retryDelayMs,
      });
    } catch (error) {
      await this._index.write({ ...claim, state: 'failed' });
      throw error;
    }
    if (this._closed) download.abort();
    flight.stage = 'downloading';
    flight.source = 'cloud';
    flight.fill = download.fill;
    flight.waitingFor = undefined;
    flight.abort = () => download.abort();
    this._logger.info('Webcache', `Downloading ${redactUrl(request.url)}`);
    const heartbeat = setInterval(
      () => void this._index.write(claim).catch(_ignore),
      this._settings.heartbeatMs,
    );
    heartbeat.unref?.();
    const finished = download.finished.then(
      ({ blobId, size }) =>
        this._index.write({
          ...claim,
          state: 'cached',
          blobId,
          size,
          contentType: download.contentType,
          source: 'cloud',
          fetchedAt: this._clock(),
        }),
      async (error: Error) => {
        await this._index.write({ ...claim, state: 'failed' }).catch(_ignore);
        this._logger.warn('Webcache', `Download of ${redactUrl(request.url)} failed`, {
          error: error.message,
        });
        throw error;
      },
    );
    finished.finally(() => clearInterval(heartbeat)).catch(_ignore);
    return { source: 'cloud', fill: download.fill, contentType: download.contentType, finished };
  }

  // ...........................................................................
  /**
   * Whether another node's claim is alive: renewed within the stale period,
   * as this node sees it. A claim seen for the first time is believed unless
   * it is older than any clock difference explains.
   * @param claim - The other node's row.
   * @returns True while it is alive.
   */
  private _isFresh(claim: WebcacheEntry): boolean {
    const id = `${claim.nodeId}/${claim.keyHash}`;
    const seen = this._claimsSeen.get(id);
    const tick = performance.now();
    if (seen && seen.at === claim.at) return tick - seen.since <= this._settings.staleMs;
    // A renewed claim is alive; one seen for the first time only when it is
    // younger than any clock difference explains — else it stays dead.
    const alive =
      seen !== undefined || this._clock() - claim.at <= this._settings.staleMs + _SKEW_MS;
    this._claimsSeen.set(id, { at: claim.at, since: alive ? tick : -Infinity });
    return alive;
  }

  // ...........................................................................
  /**
   * The answer one requester gets.
   * @param ready - What to read.
   * @param source - Where it comes from for this requester.
   * @param key - The key.
   * @param keyHash - Its hash.
   * @param consumer - Who asks.
   * @param count - Whether it counts as a request.
   * @returns The answer.
   */
  private _respond(
    ready: _Ready,
    source: WebcacheSource,
    key: string,
    keyHash: string,
    consumer: string,
    count: boolean,
  ): WebcacheResponse {
    if (count) this.stats.request(keyHash, source, consumer);
    const fill = ready.fill;
    return {
      source,
      key,
      keyHash,
      size: fill.isDone ? fill.bytes : fill.expectedSize,
      contentType: ready.contentType,
      blobId: fill.blobId,
      body: (range) => {
        const reading = this._reading.get(keyHash) ?? new Set<BlobFill>();
        reading.add(fill);
        this._reading.set(keyHash, reading);
        return fill.stream(range);
      },
      finished: ready.finished,
      served: (bytes) => this.stats.served(keyHash, bytes, source, consumer),
    };
  }

  // ...........................................................................
  /**
   * Whether a key is being answered or read right now.
   * @param keyHash - The key's hash.
   * @returns True when busy.
   */
  private _busy(keyHash: string): boolean {
    if (this._flights.has(keyHash)) return true;
    const reading = this._reading.get(keyHash);
    for (const fill of [...(reading ?? [])]) {
      if (fill.readers > 0) return true;
      reading?.delete(fill);
    }
    this._reading.delete(keyHash);
    return false;
  }

  // ...........................................................................
  /**
   * Gives a held entry another state.
   * @param keyHash - The entry's key hash.
   * @param state - The state.
   * @returns False when this node does not hold it.
   */
  private async _restate(keyHash: string, state: 'cached' | 'pinned'): Promise<boolean> {
    const latest = await this._index.latest(keyHash);
    if (!WebcacheIndex.isLive(latest)) return false;
    await this._index.write({ ...Webcache._draft(latest as WebcacheEntry), state });
    return true;
  }

  // ...........................................................................
  /**
   * Logs a sweep that failed on its own schedule.
   * @param error - Why.
   */
  private readonly _ignoreSweepFailure = (error: Error): void => {
    this._logger.warn('Webcache', 'A sweep failed', { error: error.message });
  };

  // ...........................................................................
  /**
   * Deletes a blob; one that is gone already is fine.
   * @param blobId - The blob.
   */
  private async _deleteBlob(blobId: string): Promise<void> {
    if (await this._options.bs.blobExists(blobId)) await this._options.bs.deleteBlob(blobId);
  }

  // ...........................................................................
  /**
   * The entries this node holds.
   * @returns Cached and pinned entries, oldest first.
   */
  private async _live(): Promise<WebcacheEntry[]> {
    return (await this._index.all()).filter((e) => WebcacheIndex.isLive(e));
  }

  // ...........................................................................
  /**
   * The free and total bytes of the store's disk.
   * @returns The space, or undefined when unknown.
   */
  private async _diskSpace(): Promise<{ free: number; total: number } | undefined> {
    if (this._options.diskSpace) return this._options.diskSpace();
    if (!this._options.folder) return undefined;
    const fs = await statfs(this._options.folder);
    return { free: fs.bavail * fs.bsize, total: fs.blocks * fs.bsize };
  }

  // ...........................................................................
  /** See {@link sweep}. */
  private async _sweep(): Promise<WebcacheSweepResult> {
    const now = this._clock();
    const lastAccess = (e: WebcacheEntry) => this.stats.lastAccess(e.keyHash) ?? e.fetchedAt;
    const removable = (e: WebcacheEntry) => e.state === 'cached' && !this._busy(e.keyHash);

    let expired = 0;
    for (const entry of await this._live()) {
      if (removable(entry) && lastAccess(entry) + this._settings.lifetimeMs <= now) {
        await this.remove(entry.keyHash);
        expired++;
      }
    }

    let evicted = 0;
    const usage = await this._options.maintenance?.usage();
    const disk = await this._diskSpace();
    let excess = usage ? usage.bytes - this._settings.diskBudgetBytes : 0;
    if (disk) {
      const floor = (disk.total * this._settings.minFreeDiskPercent) / 100;
      excess = Math.max(excess, floor - disk.free);
    }
    if (excess > 0) {
      const candidates = (await this._live())
        .filter(removable)
        .sort((a, b) => lastAccess(a) - lastAccess(b));
      for (const entry of candidates) {
        if (excess <= 0) break;
        await this.remove(entry.keyHash);
        excess -= entry.size;
        evicted++;
      }
    }

    let orphans = 0;
    const held = new Set((await this._live()).map((e) => e.blobId));
    const busy = new Set(
      [...this._reading.entries()]
        .filter(([keyHash]) => this._busy(keyHash))
        .flatMap(([, fills]) => [...fills].map((f) => f.blobId)),
    );
    let token: string | undefined;
    do {
      const page = await this._options.bs.listBlobs({ continuationToken: token });
      for (const blob of page.blobs) {
        const old = blob.createdAt.getTime() <= now - this._settings.orphanGraceMs;
        if (old && !held.has(blob.blobId) && !busy.has(blob.blobId)) {
          await this._deleteBlob(blob.blobId);
          orphans++;
        }
      }
      token = page.continuationToken;
    } while (token);

    const gc = await this._options.maintenance?.collectGarbage();
    return {
      expired,
      evicted,
      orphans,
      freedBytes: gc?.freedBytes ?? 0,
      usageBytes: usage?.bytes,
    };
  }

  // ...........................................................................
  /**
   * Checks a request.
   * @param request - The request.
   * @returns Its key and key hash.
   */
  private static _parse(request: WebcacheRequest): { key: string; keyHash: string } {
    if (typeof request.url !== 'string') {
      throw new WebcacheError('bad-request', 'The URL is missing');
    }
    if (request.size !== undefined && (!Number.isInteger(request.size) || request.size < -1)) {
      throw new WebcacheError('bad-request', 'The size must be a whole number of bytes');
    }
    try {
      return keyOf(request);
    } catch (error) {
      throw new WebcacheError('bad-request', (error as Error).message);
    }
  }

  // ...........................................................................
  /**
   * Whether a held size fits the size asked for.
   * @param held - The size held.
   * @param asked - The size asked for; anything fits when omitted or -1.
   * @returns True when it fits.
   */
  private static _sizeFits(held: number, asked: number | undefined): boolean {
    return asked === undefined || asked < 0 || held === asked;
  }

  // ...........................................................................
  /**
   * The row of an entry as it is written again.
   * @param entry - The entry.
   * @returns The row without stamp.
   */
  private static _draft(entry: WebcacheEntry): WebcacheDraft {
    return {
      keyHash: entry.keyHash,
      key: entry.key,
      state: entry.state,
      blobId: entry.blobId,
      size: entry.size,
      contentType: entry.contentType,
      consumer: entry.consumer,
      source: entry.source,
      fetchedAt: entry.fetchedAt,
    };
  }
}
