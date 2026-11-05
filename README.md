# webcache

The RLJSON webcache provides downloaded web content like media, images and texts as a local requestable cache. Based on a blob store (rljson/bs), it serves downloaded data through an rljson network (rljson/server, rljson/network), so that other rljson clients can retrieve it from the fleet first before downloading it on their own.
