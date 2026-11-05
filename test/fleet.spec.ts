// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { createSocketPair, IoMem, Socket } from '@rljson/io';
import { PeerReadServer } from '@rljson/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Fleet, FleetOptions, WebcacheEntry, WebcacheIndex } from '../src/index.ts';

describe('Fleet', () => {
  interface TestNode {
    io: IoMem;
    bs: BsMem;
    index: WebcacheIndex;
    server: PeerReadServer;
    sockets: Socket[];
  }
  let nodes: Map<string, TestNode>;
  let connects: string[];
  let behaviour: Map<string, 'unreachable' | 'throws' | 'silent'>;
  let fleet: Fleet;

  const addNode = async (nodeId: string, withTable = true): Promise<TestNode> => {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const bs = new BsMem();
    const index = withTable
      ? await WebcacheIndex.open(io, { nodeId })
      : (undefined as unknown as WebcacheIndex);
    const node = { io, bs, index, server: new PeerReadServer(io, bs), sockets: [] };
    nodes.set(nodeId, node);
    return node;
  };

  const connect: FleetOptions['connect'] = async (nodeId) => {
    connects.push(nodeId);
    const how = behaviour.get(nodeId);
    if (how === 'unreachable') return undefined;
    if (how === 'throws') throw new Error(`ECONNREFUSED ${nodeId}`);
    const [serverSide, clientSide] = createSocketPair();
    serverSide.connect();
    clientSide.connect();
    const node = nodes.get(nodeId) as TestNode;
    node.sockets.push(serverSide);
    if (how !== 'silent') await node.server.addSocket(serverSide);
    return clientSide;
  };

  const newFleet = (options: Partial<FleetOptions> = {}) =>
    new Fleet({
      nodeId: 'self',
      nodes: () => [...nodes.keys()],
      connect,
      timeoutMs: 100,
      connectTimeoutMs: 100,
      ...options,
    });

  const entry = (overrides: Partial<WebcacheEntry> = {}) =>
    WebcacheIndex.exampleDraft({ keyHash: 'k1', ...overrides });

  beforeEach(async () => {
    nodes = new Map();
    connects = [];
    behaviour = new Map();
    await addNode('self');
    fleet = newFleet();
  });

  afterEach(async () => {
    await fleet.close();
  });

  describe('lookup(keyHash)', () => {
    it('finds the nodes holding a key, and those downloading it', async () => {
      const a = await addNode('a');
      const b = await addNode('b');
      const c = await addNode('c');
      const d = await addNode('d');
      await a.index.write(entry({ state: 'cached' }));
      await b.index.write(entry({ state: 'downloading' }));
      await c.index.write(entry({ state: 'pinned' }));
      await d.index.write(entry({ state: 'cached' }));
      await d.index.write(entry({ state: 'removed' }));
      await (nodes.get('self') as TestNode).index.write(entry({ state: 'cached' }));

      const found = await fleet.lookup('k1');
      expect(found.holders.map((h) => [h.nodeId, h.entry.state, h.via])).toEqual([
        ['a', 'cached', 'direct'],
        ['c', 'pinned', 'direct'],
      ]);
      expect(found.downloading.map((e) => e.nodeId)).toEqual(['b']);
      expect([found.asked, found.answered]).toEqual([4, 4]);
      expect(connects).not.toContain('self');
    });

    it('skips nodes it cannot reach, for a while', async () => {
      await addNode('a');
      await addNode('b');
      behaviour.set('a', 'unreachable');
      behaviour.set('b', 'throws');
      let now = 0;
      fleet = newFleet({ downMs: 1_000, clock: () => now });
      expect((await fleet.lookup('k1')).answered).toBe(0);
      expect((await fleet.lookup('k1')).asked).toBe(0);
      expect(connects).toEqual(['a', 'b']);
      now = 2_000;
      await fleet.lookup('k1');
      expect(connects).toEqual(['a', 'b', 'a', 'b']);
    });

    it('does not wait longer than its bound for a silent node', async () => {
      const a = await addNode('a');
      await addNode('b');
      behaviour.set('b', 'silent');
      await a.index.write(entry());
      const started = Date.now();
      const found = await fleet.lookup('k1');
      expect(Date.now() - started).toBeLessThan(1_000);
      expect([found.holders.length, found.asked, found.answered]).toEqual([1, 2, 1]);
    });

    it('takes a node without the table as holding nothing', async () => {
      await addNode('a', false);
      expect((await fleet.lookup('k1')).holders).toEqual([]);
    });

    it('reuses one connection per node', async () => {
      await addNode('a');
      await fleet.lookup('k1');
      await fleet.lookup('k2');
      expect(connects).toEqual(['a']);
      expect(fleet.connectedNodes).toEqual(['a']);
    });

    it('connects again after a connection dropped', async () => {
      const a = await addNode('a');
      await fleet.lookup('k1');
      a.sockets[0].disconnect();
      expect(fleet.connectedNodes).toEqual([]);
      await fleet.lookup('k1');
      expect(connects).toEqual(['a', 'a']);
    });

    it('keeps at most its maximum of connections, closing the oldest', async () => {
      await addNode('a');
      await addNode('b');
      fleet = newFleet({ maxConnections: 1, nodes: () => ['a'] });
      await fleet.lookup('k1');
      fleet = newFleet({ maxConnections: 1, nodes: () => ['a', 'b'] });
      await fleet.lookup('k1');
      expect(fleet.connectedNodes.length).toBe(1);
    });

    it('closes a connection that went unused', async () => {
      await addNode('a');
      fleet = newFleet({ idleMs: 20 });
      await fleet.lookup('k1');
      await new Promise((r) => setTimeout(r, 60));
      expect(fleet.connectedNodes).toEqual([]);
    });

    it('asks the relay for what no node answered directly', async () => {
      const hub = await addNode('hub');
      const holder = await addNode('far');
      behaviour.set('far', 'unreachable');
      behaviour.set('hub', 'unreachable');
      const row = await holder.index.write(entry());
      await hub.io.write({
        data: {
          webcacheEntries: { _type: 'components', _data: [{ ...row }] },
        } as never,
      });
      const blob = await holder.bs.setBlob('relayed');
      await hub.bs.setBlob('relayed');
      fleet = newFleet({ relay: () => ({ io: hub.io, bs: hub.bs }) });
      const found = await fleet.lookup('k1');
      expect(found.holders.map((h) => [h.nodeId, h.via])).toEqual([['far', 'relay']]);
      const [blocks] = [await fleet.blobBlocks(found.holders[0], blob.blobId)];
      expect((await fleet.block(found.holders[0], blocks[0].blockId)).toString()).toBe(
        'relayed',
      );
    });

    it('ignores a relay that has no rows store, fails or knows only this node', async () => {
      fleet = newFleet({ relay: () => ({}) });
      expect((await fleet.lookup('k1')).holders).toEqual([]);
      fleet = newFleet({
        relay: () => ({
          io: { readRows: async () => Promise.reject(new Error('gone')) } as never,
        }),
      });
      expect((await fleet.lookup('k1')).holders).toEqual([]);
      const self = nodes.get('self') as TestNode;
      await self.index.write(entry());
      fleet = newFleet({ relay: () => ({ io: self.io }) });
      expect((await fleet.lookup('k1')).holders).toEqual([]);
    });
  });

  describe('entry(nodeId, keyHash)', () => {
    it('answers the newest row of a key on one node', async () => {
      const a = await addNode('a');
      await a.index.write(entry({ state: 'downloading' }));
      const cached = await a.index.write(entry({ state: 'cached' }));
      expect(await fleet.entry('a', 'k1')).toEqual(cached);
      expect(await fleet.entry('a', 'other')).toBeUndefined();
    });

    it('answers undefined for a node it cannot reach', async () => {
      await addNode('a');
      behaviour.set('a', 'unreachable');
      expect(await fleet.entry('a', 'k1')).toBeUndefined();
    });
  });

  describe('entriesOf(nodeId)', () => {
    it('answers the newest row of every key a node has', async () => {
      const a = await addNode('a');
      await a.index.write(entry({ keyHash: 'x', state: 'downloading' }));
      const x = await a.index.write(entry({ keyHash: 'x', state: 'cached' }));
      const y = await a.index.write(entry({ keyHash: 'y' }));
      expect(await fleet.entriesOf('a')).toEqual([x, y]);
    });

    it('answers undefined for a node it cannot reach or that fails', async () => {
      await addNode('a', false);
      await addNode('b');
      behaviour.set('b', 'unreachable');
      expect(await fleet.entriesOf('a')).toBeUndefined();
      expect(await fleet.entriesOf('b')).toBeUndefined();
    });
  });

  describe('blobBlocks(holder, blobId) and block(holder, blockId)', () => {
    it('read a blob from the node holding it', async () => {
      const a = await addNode('a');
      const { blobId } = await a.bs.setBlob('content of a');
      await a.index.write(entry({ blobId }));
      const [holder] = (await fleet.lookup('k1')).holders;
      const blocks = await fleet.blobBlocks(holder, blobId);
      expect((await fleet.block(holder, blocks[0].blockId)).toString()).toBe(
        'content of a',
      );
    });

    it('fail for a node that is gone', async () => {
      const a = await addNode('a');
      await a.index.write(entry());
      const [holder] = (await fleet.lookup('k1')).holders;
      behaviour.set('a', 'unreachable');
      a.sockets[0].disconnect();
      await expect(fleet.block(holder, 'x')).rejects.toThrow('Node a is not reachable');
    });

    it('fail when a block takes longer than allowed', async () => {
      const a = await addNode('a');
      await a.index.write(entry());
      const [holder] = (await fleet.lookup('k1')).holders;
      behaviour.set('a', 'silent');
      a.sockets[0].disconnect();
      fleet = newFleet({ blockTimeoutMs: 30 });
      await expect(fleet.block(holder, 'x')).rejects.toThrow(
        'Node a took longer than 30 ms',
      );
    });

    it('fail through a relay that has no blob store', async () => {
      fleet = newFleet({ relay: () => ({}) });
      const holder = { nodeId: 'far', entry: WebcacheIndex.exampleEntry(), via: 'relay' as const };
      await expect(fleet.block(holder, 'x')).rejects.toThrow('No relay to read from');
    });
  });

  describe('connections', () => {
    it('work with the default bounds', async () => {
      const a = await addNode('a');
      await a.index.write(entry());
      fleet = new Fleet({ nodeId: 'self', nodes: () => ['a'], connect });
      expect((await fleet.lookup('k1')).holders.length).toBe(1);
    });

    it('open once for reads that come at the same time', async () => {
      await addNode('a');
      await Promise.all([fleet.entry('a', 'k1'), fleet.entry('a', 'k2')]);
      expect(connects).toEqual(['a']);
    });

    it('take a connection split into namespaces', async () => {
      const a = await addNode('a');
      await a.index.write(entry());
      fleet = newFleet({
        connect: async (nodeId, signal) => {
          const socket = (await connect(nodeId, signal)) as never;
          return { ioUp: socket, ioDown: socket, bsUp: socket, bsDown: socket };
        },
      });
      expect((await fleet.lookup('k1')).holders.length).toBe(1);
    });

    it('are closed again when the fleet closed while they opened', async () => {
      await addNode('a');
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      fleet = newFleet({
        connectTimeoutMs: 1_000,
        connect: async (nodeId, signal) => {
          await gate;
          return connect(nodeId, signal);
        },
      });
      const looking = fleet.lookup('k1');
      await fleet.close();
      release();
      expect((await looking).answered).toBe(0);
      expect(fleet.connectedNodes).toEqual([]);
    });

    it('stay up when a node answers a block read with an error', async () => {
      const a = await addNode('a');
      await a.index.write(entry());
      const [holder] = (await fleet.lookup('k1')).holders;
      await expect(fleet.block(holder, 'missing')).rejects.toThrow();
      expect(fleet.connectedNodes).toEqual(['a']);
    });
  });

  describe('close()', () => {
    it('drops every connection and refuses to connect again', async () => {
      await addNode('a');
      await fleet.lookup('k1');
      await fleet.close();
      expect(fleet.connectedNodes).toEqual([]);
      expect((await fleet.lookup('k1')).asked).toBe(0);
    });
  });

  describe('example()', () => {
    it('is a fleet of no other node', async () => {
      const example = Fleet.example();
      expect((await example.lookup('k')).asked).toBe(0);
      expect(await example.entry('node-x', 'k')).toBeUndefined();
      await example.close();
    });
  });
});
