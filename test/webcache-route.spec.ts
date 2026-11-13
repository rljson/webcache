// @license
// Copyright (c) rljson
//
// Use of this source code is governed by terms that can be
// found in the LICENSE file in the root of this package.

import { BsMem } from '@rljson/bs';
import { createSocketPair, IoMem } from '@rljson/io';
import { Route } from '@rljson/rljson';
import { noopLogger, RouteMemberContext, Server } from '@rljson/server';
import { randomBytes } from 'node:crypto';
import { createServer, Server as HttpServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Fleet, Webcache, webcacheHubStores, WebcacheRoute } from '../src/index.ts';

describe('WebcacheRoute', () => {
  const content = randomBytes(2 * 1024 * 1024);
  let origin: HttpServer;
  let originUrl: string;
  let hits: number;
  let hub: Server;
  let members: Map<string, WebcacheRoute>;
  let webcaches: Map<string, Webcache>;
  let direct: boolean;

  const pair = () => {
    const [serverSide, clientSide] = createSocketPair();
    serverSide.connect();
    clientSide.connect();
    return [serverSide, clientSide] as const;
  };

  const context = (
    nodeId: string,
    overrides: Partial<RouteMemberContext> = {},
  ): RouteMemberContext => ({
    treeKey: 'webcache',
    route: Route.fromFlat('/webcache'),
    nodeId,
    hubAddress: '127.0.0.1:1',
    connectHub: async () => {
      const [serverSide, clientSide] = pair();
      await hub.addSocket(serverSide);
      return clientSide;
    },
    logger: noopLogger,
    ...overrides,
  });

  const addMember = async (nodeId: string) => {
    const io = new IoMem();
    await io.init();
    await io.isReady();
    const webcache = await Webcache.open({
      io,
      bs: new BsMem(),
      nodeId,
      allowedHosts: ['127.0.0.1'],
      claimSettleMs: 10,
      pollMs: 10,
      sweepIntervalMs: 0,
    });
    const member = new WebcacheRoute({
      webcache,
      peers: {
        nodes: () => [...members.keys()],
        connect: async (peerId) => {
          if (!direct) return undefined;
          const [serverSide, clientSide] = pair();
          await (members.get(peerId) as WebcacheRoute).servePeer(serverSide);
          return clientSide;
        },
      },
      fleet: { timeoutMs: 300 },
    });
    members.set(nodeId, member);
    webcaches.set(nodeId, webcache);
    return { member, webcache };
  };

  const get = async (webcache: Webcache) => {
    const response = await webcache.fetch({ url: `${originUrl}/catalogue.zip` });
    const parts: Uint8Array[] = [];
    for await (const part of response.body()) parts.push(part);
    await response.finished;
    return { source: response.source, bytes: Buffer.concat(parts) };
  };

  beforeEach(async () => {
    hits = 0;
    direct = true;
    members = new Map();
    webcaches = new Map();
    origin = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'content-length': String(content.length) }).end(content);
    });
    await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
    originUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
    const stores = await webcacheHubStores();
    hub = new Server(Route.fromFlat('/webcache'), stores.io, stores.bs);
    await hub.init();
  });

  afterEach(async () => {
    for (const member of members.values()) await member.close();
    for (const webcache of webcaches.values()) await webcache.close();
    await hub.tearDown();
    origin.closeAllConnections();
    await new Promise((r) => origin.close(r));
  });

  describe('start(context)', () => {
    it('lets the webcache read from other nodes directly', async () => {
      const a = await addMember('a');
      const b = await addMember('b');
      await a.member.start(context('a'));
      await b.member.start(context('b'));
      expect(b.webcache.fleet).toBe(b.member.fleet);
      expect(b.member.client).toBeDefined();
      await get(a.webcache);
      const fromB = await get(b.webcache);
      expect([fromB.source, hits]).toEqual(['fleet', 1]);
      expect(fromB.bytes).toEqual(content);
      expect(b.member.fleet?.connectedNodes).toContain('a');
    });

    it('reads through the hub from nodes it cannot reach directly', async () => {
      direct = false;
      const a = await addMember('a');
      const b = await addMember('b');
      await a.member.start(context('a'));
      await b.member.start(context('b'));
      await get(a.webcache);
      const fromB = await get(b.webcache);
      expect([fromB.source, hits]).toEqual(['fleet', 1]);
      expect(fromB.bytes).toEqual(content);
    });

    it('keeps the direct fleet and fails when the hub cannot be reached', async () => {
      const a = await addMember('a');
      await expect(
        a.member.start(
          context('a', {
            connectHub: async () => Promise.reject(new Error('ECONNREFUSED hub')),
          }),
        ),
      ).rejects.toThrow('ECONNREFUSED hub');
      expect(a.webcache.fleet).toBeDefined();
      expect(a.member.client).toBeUndefined();
      expect((await get(a.webcache)).source).toBe('cloud');
    });

    it('starts anew when started twice', async () => {
      const a = await addMember('a');
      await a.member.start(context('a'));
      const first = a.member.fleet;
      await a.member.start(context('a'));
      expect(a.member.fleet).not.toBe(first);
      expect(a.webcache.fleet).toBe(a.member.fleet);
    });

    it('takes a hub connection split into namespaces', async () => {
      const a = await addMember('a');
      await a.member.start(
        context('a', {
          connectHub: async () => {
            const [serverSide, clientSide] = pair();
            await hub.addSocket(serverSide);
            return { ioUp: clientSide, ioDown: clientSide, bsUp: clientSide, bsDown: clientSide };
          },
        }),
      );
      expect(a.member.client).toBeDefined();
      await a.member.stop();
    });
  });

  describe('stop()', () => {
    it('stops asking the fleet and disconnects from the hub', async () => {
      const a = await addMember('a');
      await a.member.start(context('a'));
      await a.member.stop();
      expect([a.webcache.fleet, a.member.fleet, a.member.client]).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    });

    it('leaves a fleet attached by somebody else alone', async () => {
      const a = await addMember('a');
      await a.member.start(context('a'));
      const foreign = Fleet.example();
      a.webcache.attach(foreign);
      await a.member.stop();
      expect(a.webcache.fleet).toBe(foreign);
    });

    it('aborts a start that still connects', async () => {
      const a = await addMember('a');
      const starting = a.member.start(
        context('a', {
          connectHub: (signal) =>
            new Promise((resolve) => {
              signal.addEventListener('abort', () => {
                const [, clientSide] = pair();
                resolve(clientSide);
              });
            }),
        }),
      );
      await new Promise((r) => setTimeout(r, 10));
      await a.member.stop();
      await expect(starting).rejects.toThrow('Stopped while connecting route webcache');
    });
  });

  describe('servePeer(socket) and close()', () => {
    it('serve peers before any start, until closed', async () => {
      const a = await addMember('a');
      const b = await addMember('b');
      await b.member.start(context('b'));
      await get(b.webcache);
      // a never started: b can still read a's empty index, a b's full one.
      await a.member.start(context('a'));
      expect((await get(a.webcache)).source).toBe('fleet');
      expect(b.member.peerServer).toBeDefined();
      await b.member.close();
      expect(b.member.peerServer).toBeUndefined();
    });
  });

  describe('treeKey', () => {
    it('is webcache unless named', async () => {
      const example = await WebcacheRoute.example();
      expect(example.treeKey).toBe('webcache');
      await example.start(context('example'));
      expect(await example.fleet?.entry('x', 'k')).toBeUndefined();
      expect((await example.fleet?.lookup('k'))?.asked).toBe(0);
      await example.close();
      const named = new WebcacheRoute({
        treeKey: 'webcacheTest',
        webcache: await Webcache.example(),
        peers: { nodes: () => [], connect: async () => undefined },
      });
      expect(named.treeKey).toBe('webcacheTest');
    });
  });
});
