// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { Socket } from '@rljson/io';
import {
  Client,
  lateLogger,
  noopLogger,
  PeerReadServer,
  PeerReadServerOptions,
  RouteMember,
  RouteMemberContext,
  ServerLogger,
  SocketLike,
  SocketNamespaceBundle,
} from '@rljson/server';

import { Fleet, FleetOptions } from './fleet.ts';
import { Webcache } from './webcache.ts';

// #############################################################################
/** Options of {@link WebcacheRoute}. */
export interface WebcacheRouteOptions {
  /** The route's tree key. Default `webcache`. */
  treeKey?: string;

  /** The webcache; it outlives every start and stop. Its stores are served to peers. */
  webcache: Webcache;

  /** The other nodes, and how to reach their local stores. */
  peers: Pick<FleetOptions, 'nodes' | 'connect'>;

  /** Bounds of the fleet's reads. */
  fleet?: Omit<FleetOptions, 'nodeId' | 'nodes' | 'connect' | 'relay' | 'logger'>;

  /** Bounds of serving peers. */
  serve?: Omit<PeerReadServerOptions, 'logger'>;
}

// #############################################################################
/**
 * A webcache as a member of a node's route: it serves the webcache's local
 * stores to peers, and while the node knows a hub it lets the webcache ask
 * the other nodes — directly, or through the hub for those it cannot reach.
 */
export class WebcacheRoute implements RouteMember {
  private _fleet?: Fleet;
  private _client?: Client;
  private _socket?: SocketLike;
  private _connecting?: AbortController;
  private _peerServer?: PeerReadServer;
  private _logger: ServerLogger = noopLogger;
  private _queue: Promise<void> = Promise.resolve();

  // ...........................................................................
  /**
   * Creates the member.
   * @param _options - Webcache, stores and peers.
   */
  constructor(private readonly _options: WebcacheRouteOptions) {}

  // ...........................................................................
  /**
   * A member of a webcache in memory without peers, for tests and docs.
   * @returns The member.
   */
  static async example(): Promise<WebcacheRoute> {
    return new WebcacheRoute({
      webcache: await Webcache.example(),
      peers: { nodes: () => [], connect: async () => undefined },
    });
  }

  // ...........................................................................
  /** The route's tree key. */
  get treeKey(): string {
    return this._options.treeKey ?? 'webcache';
  }

  // ...........................................................................
  /** The fleet while started. */
  get fleet(): Fleet | undefined {
    return this._fleet;
  }

  // ...........................................................................
  /** The client of the hub while connected. */
  get client(): Client | undefined {
    return this._client;
  }

  // ...........................................................................
  /** The server answering peers, once a peer came. */
  get peerServer(): PeerReadServer | undefined {
    return this._peerServer;
  }

  // ...........................................................................
  /**
   * Lets the webcache ask the fleet, and connects to the hub for the nodes it
   * cannot reach directly. When the hub cannot be reached, the direct fleet
   * stays and the start fails, so the node tries again.
   * @param context - Hub, identity and logger.
   */
  start(context: RouteMemberContext): Promise<void> {
    return this._serialize(() => this._start(context));
  }

  // ...........................................................................
  /** Stops asking the fleet and disconnects from the hub. */
  stop(): Promise<void> {
    this._connecting?.abort();
    return this._serialize(() => this._stop());
  }

  // ...........................................................................
  /**
   * Answers a peer's reads from the webcache's local stores.
   * @param socket - The peer's connection.
   */
  async servePeer(socket: SocketLike): Promise<void> {
    const { io, bs } = this._options.webcache;
    this._peerServer ??= new PeerReadServer(io, bs, {
      ...this._options.serve,
      logger: lateLogger(() => this._logger),
    });
    await this._peerServer.addSocket(socket);
  }

  // ...........................................................................
  /** Stops and disconnects every peer. The webcache stays open. */
  async close(): Promise<void> {
    await this.stop();
    await this._peerServer?.close();
    this._peerServer = undefined;
  }

  // ...........................................................................
  /**
   * Runs one operation after the ones before it, whatever they ended with.
   * @param operation - The operation.
   * @returns Its result.
   */
  private _serialize(operation: () => Promise<void>): Promise<void> {
    const next = this._queue.then(operation, operation);
    this._queue = next.catch(() => undefined);
    return next;
  }

  // ...........................................................................
  /**
   * See {@link start}.
   * @param context - Hub, identity and logger.
   */
  private async _start(context: RouteMemberContext): Promise<void> {
    await this._stop();
    this._logger = context.logger;
    this._fleet = new Fleet({
      ...this._options.fleet,
      nodeId: context.nodeId,
      nodes: this._options.peers.nodes,
      connect: this._options.peers.connect,
      relay: () => this._client?.peerStores ?? {},
      logger: context.logger,
    });
    this._options.webcache.attach(this._fleet);

    const connecting = new AbortController();
    this._connecting = connecting;
    try {
      this._socket = await context.connectHub(connecting.signal);
      if (connecting.signal.aborted) {
        throw new Error(`Stopped while connecting route ${this.treeKey}`);
      }
      const { io, bs } = this._options.webcache;
      this._client = new Client(this._socket, io, bs, undefined, {
        logger: context.logger,
        ownsStores: false,
        nodeId: context.nodeId,
      });
      await this._client.init();
    } catch (error) {
      await this._stopHub();
      throw error;
    } finally {
      this._connecting = undefined;
    }
  }

  // ...........................................................................
  /** See {@link stop}. */
  private async _stop(): Promise<void> {
    const fleet = this._fleet;
    this._fleet = undefined;
    if (fleet && this._options.webcache.fleet === fleet) this._options.webcache.detach();
    await fleet?.close();
    await this._stopHub();
  }

  // ...........................................................................
  /** Disconnects from the hub. */
  private async _stopHub(): Promise<void> {
    const client = this._client;
    this._client = undefined;
    await client?.tearDown();
    const socket = this._socket;
    this._socket = undefined;
    if (!socket) return;
    const bundle = socket as SocketNamespaceBundle;
    const sockets = bundle.ioUp ? Object.values(bundle) : [socket as Socket];
    for (const s of new Set(sockets)) s.disconnect();
  }
}
