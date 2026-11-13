<!--
@license
Copyright (c) rljson

Use of this source code is governed by terms that can be
found in the LICENSE file in the root of this package.
-->

# @rljson/webcache — architecture

## The modules

| Module | What it does |
| --- | --- |
| `webcache-key.ts` | Keys, key hashes, and URLs as they may be shown. |
| `webcache-index.ts` | The index of one node: an insert-only components table `webcacheEntries`. |
| `blob-fill.ts` | A blob filled block by block and read while it fills. |
| `origin-fetch.ts` | Requests to the cloud: allowed hosts, uncompressed, resumable, bounded in time, optional proxy. |
| `cloud-download.ts` | A download into the store: content-defined blocks as they arrive, resume, size and MD5 checks. |
| `fleet.ts` | The other nodes: lookups and block reads over peer connections, or through the hub. |
| `fleet-transfer.ts` | A copy from the nodes holding a blob, from all of them at once. |
| `webcache-stats.ts` | Requests and bytes per file, per consumer and today. |
| `webcache.ts` | The order of sources, claims, the admin API, the sweep. |
| `webcache-http.ts` | The HTTP endpoint for the programs of this machine. |
| `webcache-route.ts` | The route member for an `@rljson/server` `Node`. |
| `webcache-hub-stores.ts` | The stores a hub serves the route with. |

## The index

Every node keeps its own index; nothing is pushed. A row is written for every
change of an entry and never changed: the newest row of a key on a node
decides. The states:

- `downloading` — the node downloads the key now. The row is renewed every
  `heartbeatMs`, and it is the node's **claim**.
- `cached` / `pinned` — the node holds the key.
- `failed` — a download broke off, was refused, or the node yielded.
- `removed` — the node no longer holds the key.

Rows are queried by `keyHash`, never by the key: IoSqliteNode puts `where`
values into SQL unescaped, and the hash is 22 characters of base64url.

## Answering a request

1. **Single flight.** Requests for the same key share one flight.
2. **Own store.** A live row whose size fits and whose blob exists answers.
3. **Fleet.** `Fleet.lookup` asks every node in parallel for its newest row
   of the key — bounded per node, a node that fails is left alone for a
   while.
   - Holders → `FleetTransfer` from all holders of the newest version.
   - A fresh claim of another node → wait, polling, until a holder appears,
     the claim goes stale, or `waitMs` ran out.
4. **Cloud.** Claim the key, wait `claimSettleMs`, look again:
   - a holder appeared → copy from it;
   - a fresh claim of a node with a **lower id** → yield (`failed`) and
     wait for it, as above; once that wait ran out, download without
     yielding again;
   - else download.

Machines that start together and ask in the same order thus download each
file once: they all claim, the lowest id downloads, the others copy.

**Freshness of a claim** is judged with this machine's own monotonic clock: a
claim is alive while its `at` changes within `staleMs`. A claim seen for the
first time is believed only if its `at` is no older than `staleMs` plus five
minutes of clock difference between machines.

## Blocks

Blobs are stored as content-defined blocks (`@rljson/bs`): a cloud download
is cut as it arrives, so memory stays at a few blocks whatever the size. A
connection that breaks is resumed from the last block boundary with `Range`
and `If-Range`; the blocks cut after it are the same as without the break.

A copy from the fleet fetches only the blocks the store lacks, in a window of
eight, from the holders in turn; the blocks of an older version of the same
file are not fetched again. Every block is verified against its id, and the
blob against its id when its block list is stored.

## The hub

Nodes reach each other directly over peer connections. For nodes they cannot
reach, the hub relays: its stores for the route are `webcacheHubStores()`,
which keep nothing. A hub that kept the rows it relays would answer later
lookups from its stale copy (an IoMulti stops at the first layer that has
rows), and would hold the blocks of every large file that ever crossed it.

## The sweep

Every `sweepIntervalMs`:

1. entries whose lifetime ended — counted from the last request, else from
   the download — are removed; pinned entries never expire;
2. while the store is above its budget, or the disk below its free floor, the
   least recently used entries are removed;
3. blobs no live entry holds and older than `orphanGraceMs` are deleted;
4. the store's garbage collector frees the blocks no blob references.

What is being downloaded, copied or read is never removed.
