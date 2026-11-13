// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BlobBlock, Bs, BsPeer } from '@rljson/bs';
import { Io, IoPeer, Socket } from '@rljson/io';
import {
  noopLogger,
  ServerLogger,
  SocketLike,
  SocketNamespaceBundle,
} from '@rljson/server';

import { WebcacheEntry, WebcacheIndex } from './webcache-index.ts';

// #############################################################################
/** Options of {@link Fleet}. */
export interface FleetOptions {
  /** This node; it is never asked. */
  nodeId: string;

  /** The nodes of the network, asked on every lookup. */
  nodes: () => readonly string[];

  /**
   * Opens a peer connection to a node's local stores. Resolves undefined when
   * the node cannot be reached.
   * @param nodeId - The node.
   * @param signal - Aborts when the connection took too long.
   */
  connect: (nodeId: string, signal: AbortSignal) => Promise<SocketLike | undefined>;

  /**
   * The hub's stores, for nodes this one cannot reach directly. Its rows and
   * blocks come from whichever client of the hub has them.
   */
  relay?: () => { io?: Io; bs?: Bs };

  /** Longest one node may take to answer a lookup. Default 1000 ms. */
  timeoutMs?: number;

  /** Longest one block may take. Default 10 000 ms. */
  blockTimeoutMs?: number;

  /** Longest opening a connection may take. Default 3000 ms. */
  connectTimeoutMs?: number;

  /** How many connections stay open at once. Default 8. */
  maxConnections?: number;

  /** A connection unused for this long is closed. Default 60 000 ms. */
  idleMs?: number;

  /** A node that failed is not asked for this long. Default 30 000 ms. */
  downMs?: number;

  /** The time in ms; the system clock when omitted. */
  clock?: () => number;

  /** Logs connections and failures. */
  logger?: ServerLogger;
}

// #############################################################################
/** A node that holds a key, and how it is reached. */
export interface FleetHolder {
  /** The node. */
  nodeId: string;

  /** Its newest row of the key. */
  entry: WebcacheEntry;

  /** `direct` over a peer connection, `relay` through the hub. */
  via: 'direct' | 'relay';
}

// #############################################################################
/** What a lookup found. */
export interface FleetLookup {
  /** The nodes holding the key. */
  holders: FleetHolder[];

  /** The rows of nodes downloading the key right now. */
  downloading: WebcacheEntry[];

  /** How many nodes were asked. */
  asked: number;

  /** How many of them answered in time. */
  answered: number;
}

// .............................................................................
/** An open connection to one node. */
interface _Link {
  nodeId: string;
  io: IoPeer;
  bs: BsPeer;
  sockets: Socket[];
  timer?: ReturnType<typeof setTimeout>;
}

// #############################################################################
/**
 * The other nodes of the network, as far as the webcache needs them: whose
 * index holds a key, and the blocks of what they hold.
 *
 * Reads go over peer connections to the nodes' local stores, never over
 * HTTP. Connections stay open while they are used; a node that fails is left
 * alone for a while, so one silent machine does not slow every lookup.
 */
export class Fleet {
  private readonly _links = new Map<string, _Link>();
  private readonly _opening = new Map<string, Promise<_Link | undefined>>();
  private readonly _down = new Map<string, number>();
  private readonly _clock: () => number;
  private readonly _logger: ServerLogger;
  private readonly _timeoutMs: number;
  private readonly _blockTimeoutMs: number;
  private readonly _connectTimeoutMs: number;
  private _closed = false;

  // ...........................................................................
  /**
   * Creates the fleet.
   * @param _options - Nodes, connections and bounds.
   */
  constructor(private readonly _options: FleetOptions) {
    this._clock = _options.clock ?? Date.now;
    this._logger = _options.logger ?? noopLogger;
    this._timeoutMs = _options.timeoutMs ?? 1_000;
    this._blockTimeoutMs = _options.blockTimeoutMs ?? 10_000;
    this._connectTimeoutMs = _options.connectTimeoutMs ?? 3_000;
  }

  // ...........................................................................
  /**
   * A fleet without other nodes, for tests and docs.
   * @returns The fleet.
   */
  static example(): Fleet {
    return new Fleet({
      nodeId: 'node-example',
      nodes: () => [],
      connect: async () => undefined,
    });
  }

  // ...........................................................................
  /**
   * Asks every node, at once, what it knows about a key. When none holds
   * it, asks the relay.
   * @param keyHash - The key's hash.
   * @returns Who holds it and who downloads it.
   */
  async lookup(keyHash: string): Promise<FleetLookup> {
    const candidates = this._candidates();
    const answers = await Promise.all(
      candidates.map((nodeId) => this._newest(nodeId, keyHash)),
    );
    const holders: FleetHolder[] = [];
    const downloading: WebcacheEntry[] = [];
    let answered = 0;
    answers.forEach((answer, i) => {
      if (answer === null) return;
      answered++;
      if (WebcacheIndex.isLive(answer)) {
        holders.push({ nodeId: candidates[i], entry: answer as WebcacheEntry, via: 'direct' });
      } else if (answer?.state === 'downloading') {
        downloading.push(answer);
      }
    });
    if (holders.length === 0) holders.push(...(await this._relayHolders(keyHash)));
    return { holders, downloading, asked: candidates.length, answered };
  }

  // ...........................................................................
  /**
   * The newest row of a key on one node.
   * @param nodeId - The node.
   * @param keyHash - The key's hash.
   * @returns The row; undefined when it has none or cannot be reached.
   */
  async entry(nodeId: string, keyHash: string): Promise<WebcacheEntry | undefined> {
    return (await this._newest(nodeId, keyHash)) ?? undefined;
  }

  // ...........................................................................
  /**
   * The newest row of every key on one node.
   * @param nodeId - The node.
   * @returns The rows, oldest first; undefined when it cannot be read.
   */
  async entriesOf(nodeId: string): Promise<WebcacheEntry[] | undefined> {
    const rows = await this._read(nodeId, (link) =>
      link.io.dumpTable({ table: WebcacheIndex.table }),
    );
    return rows === null ? undefined : WebcacheIndex.newestPerKey(WebcacheIndex.rowsOf(rows));
  }

  // ...........................................................................
  /**
   * The blocks of a blob a holder has.
   * @param holder - The holder.
   * @param blobId - The blob.
   * @returns The blocks, in order.
   */
  blobBlocks(holder: FleetHolder, blobId: string): Promise<BlobBlock[]> {
    return this._bs(holder, (bs) => bs.getBlobBlocks(blobId));
  }

  // ...........................................................................
  /**
   * One block from a holder, verified against its id.
   * @param holder - The holder.
   * @param blockId - The block.
   * @returns The bytes.
   */
  block(holder: FleetHolder, blockId: string): Promise<Buffer> {
    return this._bs(holder, (bs) => bs.getBlock(blockId));
  }

  // ...........................................................................
  /** Closes every connection; nothing is asked afterwards. */
  async close(): Promise<void> {
    this._closed = true;
    for (const link of [...this._links.values()]) this._drop(link);
  }

  // ...........................................................................
  /** The nodes with an open connection. */
  get connectedNodes(): string[] {
    return [...this._links.keys()];
  }

  // ...........................................................................
  /**
   * The nodes to ask: all but this one and those that failed lately.
   * @returns The node ids.
   */
  private _candidates(): string[] {
    if (this._closed) return [];
    return this._options.nodes().filter((nodeId) => {
      if (nodeId === this._options.nodeId) return false;
      const until = this._down.get(nodeId);
      if (until === undefined) return true;
      if (this._clock() >= until) {
        this._down.delete(nodeId);
        return true;
      }
      return false;
    });
  }

  // ...........................................................................
  /**
   * The newest row of a key on a node.
   * @param nodeId - The node.
   * @param keyHash - The key's hash.
   * @returns The row, undefined for none, null when there is no answer.
   */
  private async _newest(nodeId: string, keyHash: string): Promise<WebcacheEntry | undefined | null> {
    const rows = await this._read(nodeId, (link) =>
      link.io.readRows(WebcacheIndex.query(keyHash)),
    );
    return rows === null ? null : WebcacheIndex.newest(WebcacheIndex.rowsOf(rows));
  }

  // ...........................................................................
  /**
   * Reads from a node, bounded in time. A node that does not answer in time
   * is marked down; one that answers with an error — no table — is not.
   * @param nodeId - The node.
   * @param read - The read.
   * @returns The result, or null without one.
   */
  private async _read<T>(nodeId: string, read: (link: _Link) => Promise<T>): Promise<T | null> {
    const link = await this._link(nodeId);
    if (!link) return null;
    const timeoutMs = this._timeoutMs;
    try {
      return await Fleet._bounded(read(link), timeoutMs, `Node ${nodeId} took longer than ${timeoutMs} ms`);
    } catch (error) {
      if (error instanceof _TimedOut) this._fail(nodeId, error);
      return null;
    }
  }

  // ...........................................................................
  /**
   * The holders the relay names, when no node answered with one directly.
   * @param keyHash - The key's hash.
   * @returns The holders.
   */
  private async _relayHolders(keyHash: string): Promise<FleetHolder[]> {
    const io = this._options.relay?.().io;
    if (!io) return [];
    try {
      const rows = WebcacheIndex.rowsOf(
        await Fleet._bounded(
          io.readRows(WebcacheIndex.query(keyHash)),
          this._timeoutMs,
          'The relay took too long',
        ),
      );
      const byNode = new Map<string, WebcacheEntry[]>();
      for (const row of rows) {
        if (row.nodeId === this._options.nodeId) continue;
        byNode.set(row.nodeId, [...(byNode.get(row.nodeId) ?? []), row]);
      }
      return [...byNode.entries()]
        .map(([nodeId, nodeRows]) => ({
          nodeId,
          entry: WebcacheIndex.newest(nodeRows) as WebcacheEntry,
          via: 'relay' as const,
        }))
        .filter((holder) => WebcacheIndex.isLive(holder.entry));
    } catch {
      return [];
    }
  }

  // ...........................................................................
  /**
   * Runs a blob read on a holder's blob store, bounded in time.
   * @param holder - The holder.
   * @param read - The read.
   * @returns The result.
   */
  private async _bs<T>(holder: FleetHolder, read: (bs: Bs) => Promise<T>): Promise<T> {
    const timeoutMs = this._blockTimeoutMs;
    if (holder.via === 'relay') {
      const bs = this._options.relay?.().bs;
      if (!bs) throw new Error('No relay to read from');
      return Fleet._bounded(read(bs), timeoutMs, `The relay took longer than ${timeoutMs} ms`);
    }
    const link = await this._link(holder.nodeId);
    if (!link) throw new Error(`Node ${holder.nodeId} is not reachable`);
    try {
      return await Fleet._bounded(
        read(link.bs),
        timeoutMs,
        `Node ${holder.nodeId} took longer than ${timeoutMs} ms`,
      );
    } catch (error) {
      if (error instanceof _TimedOut) this._fail(holder.nodeId, error);
      throw error;
    }
  }

  // ...........................................................................
  /**
   * The open connection to a node, opened when there is none.
   * @param nodeId - The node.
   * @returns The connection, or undefined.
   */
  private _link(nodeId: string): Promise<_Link | undefined> {
    const open = this._links.get(nodeId);
    if (open) {
      this._touch(open);
      return Promise.resolve(open);
    }
    let opening = this._opening.get(nodeId);
    if (!opening) {
      opening = this._open(nodeId).finally(() => this._opening.delete(nodeId));
      this._opening.set(nodeId, opening);
    }
    return opening;
  }

  // ...........................................................................
  /**
   * Opens a connection, bounded in time.
   * @param nodeId - The node.
   * @returns The connection, or undefined.
   */
  private async _open(nodeId: string): Promise<_Link | undefined> {
    const abort = new AbortController();
    const connectTimeoutMs = this._connectTimeoutMs;
    let socket: SocketLike | undefined;
    try {
      socket = await Fleet._bounded(
        this._options.connect(nodeId, abort.signal),
        connectTimeoutMs,
        `Connecting to ${nodeId} took longer than ${connectTimeoutMs} ms`,
      );
    } catch (error) {
      abort.abort();
      this._fail(nodeId, error);
      return undefined;
    }
    if (!socket) {
      this._fail(nodeId, new Error(`Node ${nodeId} has no address`));
      return undefined;
    }
    const bundle = _bundle(socket);
    // The peers' own timeouts must lose to this class's bounds.
    const requestTimeoutMs =
      2 * Math.max(this._timeoutMs, this._blockTimeoutMs);
    const link: _Link = {
      nodeId,
      io: new IoPeer(bundle.ioDown, requestTimeoutMs),
      bs: new BsPeer(bundle.bsDown, { requestTimeoutMs }),
      sockets: [...new Set([bundle.ioDown, bundle.bsDown])],
    };
    await link.io.init();
    await link.bs.init();
    if (this._closed) {
      Fleet._disconnect(link);
      return undefined;
    }
    for (const s of link.sockets) {
      s.on('disconnect', () => {
        if (this._links.get(nodeId) === link) this._drop(link);
      });
    }
    this._evictIfFull();
    this._links.set(nodeId, link);
    this._touch(link);
    this._logger.info('Webcache', `Connected to node ${nodeId}`);
    return link;
  }

  // ...........................................................................
  /**
   * Marks a connection used: it stays open for another idle period.
   * @param link - The connection.
   */
  private _touch(link: _Link): void {
    clearTimeout(link.timer);
    link.timer = setTimeout(() => this._drop(link), this._options.idleMs ?? 60_000);
    link.timer.unref?.();
    // Most recently used last, so the first one is the one to evict.
    this._links.delete(link.nodeId);
    this._links.set(link.nodeId, link);
  }

  // ...........................................................................
  /** Closes the least recently used connection when there are too many. */
  private _evictIfFull(): void {
    const max = this._options.maxConnections ?? 8;
    while (this._links.size >= max) {
      this._drop(this._links.values().next().value as _Link);
    }
  }

  // ...........................................................................
  /**
   * Closes a connection.
   * @param link - The connection.
   */
  private _drop(link: _Link): void {
    clearTimeout(link.timer);
    this._links.delete(link.nodeId);
    Fleet._disconnect(link);
  }

  // ...........................................................................
  /**
   * Leaves a node alone for a while, and drops its connection.
   * @param nodeId - The node.
   * @param error - Why.
   */
  private _fail(nodeId: string, error: unknown): void {
    this._down.set(nodeId, this._clock() + (this._options.downMs ?? 30_000));
    const link = this._links.get(nodeId);
    if (link) this._drop(link);
    this._logger.warn('Webcache', `Node ${nodeId} is left alone for a while`, {
      error: String(error),
    });
  }

  // ...........................................................................
  /**
   * Bounds a promise in time.
   * @param work - The promise.
   * @param ms - The bound.
   * @param message - The error's message.
   * @returns The result.
   */
  private static _bounded<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new _TimedOut(message)), ms);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  }

  // ...........................................................................
  /**
   * Disconnects every socket of a connection.
   * @param link - The connection.
   */
  private static _disconnect(link: _Link): void {
    for (const s of link.sockets) s.disconnect();
  }
}

// .............................................................................
/** A read that took longer than its bound. */
class _TimedOut extends Error {}

// .............................................................................
/**
 * The namespaces of a connection: a single socket serves all of them.
 * @param socket - A socket or a bundle.
 * @returns The bundle.
 */
const _bundle = (socket: SocketLike): SocketNamespaceBundle => {
  const bundle = socket as SocketNamespaceBundle;
  if (bundle.ioDown && bundle.bsDown) return bundle;
  const single = socket as Socket;
  return { ioUp: single, ioDown: single, bsUp: single, bsDown: single };
};
