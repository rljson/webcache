# Changelog

## [Unreleased]

The first version of `@rljson/webcache`: downloaded content as a cache that
the nodes of a network share.

- `Webcache` answers a request from its own store, else from another node of
  the network that holds the content, else from the cloud — downloaded once,
  served while it arrives, stored, and so available to every other node.
- Nodes that ask for the same content at the same moment claim it; the node
  with the lowest id downloads, the others wait and copy from it.
- Downloads are cut into content-defined blocks as they arrive, resumed after
  a broken connection, and stored only when the size asked for and the MD5
  the cloud names are right.
- Copies from the fleet fetch only the blocks the store lacks, from every
  holder at once.
- Entries live for a sliding lifetime; a disk budget and a free-disk floor
  evict the least recently used; pinned entries stay.
- `WebcacheHttpServer` serves `POST /fetch` and `GET /_webcache/health` to the
  programs of this machine only.
- `poll(request, waitMs)` answers only complete content, else pending while
  it keeps coming; asked again, it gives the content or the error that
  stopped it. With `pendingAfterMs`, `POST /fetch` answers `202` with an
  empty body for pending, so a requester with a short timeout gets content
  of any size by asking again.
- `WebcacheRoute` runs the webcache as a member of an `@rljson/server` `Node`;
  `webcacheHubStores()` lets a hub relay without keeping anything.
