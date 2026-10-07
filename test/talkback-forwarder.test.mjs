import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { createTalkbackForwarder } from "../src/talkback-forwarder.mjs";

test("metadata probes exit without connecting to the bridge", async () => {
  const input = new PassThrough();
  let code;
  createTalkbackForwarder({ input, url: "http://127.0.0.1:1/talkback/CAM1", onExit: (v) => (code = v) });
  const end = once(input, "end");
  input.end();
  await end;
  assert.equal(code, 0);
});

test("forwarder sends first and subsequent microphone bytes, then closes the call on hangup", async () => {
  const server = http.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const input = new PassThrough();
  let finish;
  const finished = new Promise((r) => (finish = r));
  const forwarder = createTalkbackForwarder({
    input,
    url: `http://127.0.0.1:${server.address().port}/talkback/CAM1`,
    onExit: finish,
  });
  try {
    const received = once(server, "request");
    input.write("first");
    const [req, res] = await received;
    res.writeHead(200);
    res.flushHeaders();
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    input.write("second");
    input.end();
    await once(req, "end");
    assert.equal(Buffer.concat(chunks).toString(), "firstsecond");
    res.end();
    assert.equal(await finished, 0);
  } finally {
    forwarder.shutdown();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("hangup of an active forwarder closes the bridge request", async () => {
  const server = http.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const input = new PassThrough();
  const forwarder = createTalkbackForwarder({ input, url: `http://127.0.0.1:${server.address().port}/talkback/CAM1` });
  try {
    const received = once(server, "request");
    input.write("first");
    const [req, res] = await received;
    res.writeHead(200);
    res.flushHeaders();
    // Expected aborted upload raises an error on the incoming request too.
    req.on("error", () => {});
    const closed = new Promise((r) => req.once("close", r));
    forwarder.shutdown();
    await closed;
    assert.ok(req.destroyed);
  } finally {
    forwarder.shutdown();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});
