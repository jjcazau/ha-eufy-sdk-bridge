import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTalkbackWorker } from "../src/talkback.mjs";

function harness(open) {
  const input = new PassThrough();
  const talk = new EventEmitter();
  let stops = 0,
    disconnects = 0,
    opens = 0;
  const bytes = [];
  talk.stop = async () => {
    stops++;
    talk.emit("stop");
  };
  talk.writable = () =>
    new Writable({
      write(chunk, _enc, cb) {
        bytes.push(chunk);
        cb();
      },
    });
  const encoder = new EventEmitter();
  encoder.stdin = new PassThrough();
  encoder.stdout = new PassThrough();
  encoder.kill = () => {
    encoder.killed = true;
  };
  const exits = [];
  const session = {
    talk,
    disconnect: async () => {
      disconnects++;
    },
  };
  const worker = createTalkbackWorker({
    input,
    openTalkback: async () => {
      opens++;
      return open ? open(session) : session;
    },
    spawnProcess: () => encoder,
    onExit: (code) => exits.push(code),
  });
  return {
    input,
    talk,
    encoder,
    worker,
    exits,
    bytes,
    get stats() {
      return { opens, stops, disconnects };
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test("metadata probe closes without authenticating or opening the speaker", async () => {
  const h = harness();
  h.input.end();
  h.input.resume();
  await tick();
  assert.deepEqual(h.stats, { opens: 0, stops: 0, disconnects: 0 });
  assert.deepEqual(h.exits, [0]);
});

test("a call forwards the first microphone bytes and releases the speaker on hangup", async () => {
  const h = harness();
  const received = [];
  h.encoder.stdin.on("data", (b) => received.push(b));
  h.input.write(Buffer.from([1, 2]));
  await h.worker.starting;
  h.input.write(Buffer.from([3]));
  await tick();
  assert.deepEqual(Buffer.concat(received), Buffer.from([1, 2, 3]));
  await h.worker.shutdown();
  await h.worker.shutdown();
  assert.deepEqual(h.stats, { opens: 1, stops: 1, disconnects: 1 });
  assert.equal(h.encoder.killed, true);
  assert.deepEqual(h.exits, [0]);
});

test("hangup during authentication releases a late SDK handle without starting ffmpeg", async () => {
  let resolve;
  const h = harness(
    (session) =>
      new Promise((r) => {
        resolve = () => r(session);
      }),
  );
  h.input.write(Buffer.from([1]));
  await h.worker.shutdown();
  resolve();
  await h.worker.starting;
  assert.deepEqual(h.stats, { opens: 1, stops: 1, disconnects: 1 });
  assert.equal(h.encoder.killed, undefined);
});

test("speaker warmup discards old microphone audio instead of replaying the startup delay", async () => {
  let ready;
  const h = harness((session) => new Promise((resolve) => (ready = () => resolve(session))));
  const sent = [];
  h.encoder.stdin.on("data", (chunk) => sent.push(chunk));
  // Each 160-byte PCMA packet is 20 ms. Ten seconds of warmup must not become ten seconds of lag.
  for (let i = 0; i < 500; i++) h.input.write(Buffer.alloc(160, i % 256));
  ready();
  await h.worker.starting;
  await tick();
  assert.equal(Buffer.concat(sent).length, 160, "only the freshest 20 ms may survive speaker warmup");
  assert.deepEqual(sent[0], Buffer.alloc(160, 499 % 256));
  h.input.write(Buffer.alloc(160, 99));
  await tick();
  assert.deepEqual(sent[1], Buffer.alloc(160, 99));
  await h.worker.shutdown();
});

test("SDK stop and ffmpeg pipe errors terminate the worker", async () => {
  for (const failure of ["sdk", "pipe"]) {
    const h = harness();
    h.input.write(Buffer.from([1]));
    await h.worker.starting;
    if (failure === "sdk") h.talk.emit("stop");
    else h.encoder.stdin.emit("error", new Error("EPIPE"));
    await tick();
    assert.deepEqual(h.stats, { opens: 1, stops: 1, disconnects: 1 });
    assert.deepEqual(h.exits, [failure === "sdk" ? 0 : 1]);
  }
});

test("encoder backpressure keeps only fresh microphone audio and never pauses capture", async () => {
  const h = harness();
  const sent = [];
  let blocked = true;
  h.encoder.stdin.write = (chunk) => {
    sent.push(chunk);
    return !blocked;
  };
  h.input.write(Buffer.alloc(160, 1));
  await h.worker.starting;
  for (let i = 0; i < 500; i++) h.input.write(Buffer.alloc(160, i % 256));
  assert.equal(h.input.isPaused(), false);
  assert.equal(sent.length, 1);
  blocked = false;
  h.encoder.stdin.emit("drain");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1], Buffer.alloc(160, 499 % 256));
  await h.worker.shutdown();
  h.encoder.stdin.emit("drain");
  assert.equal(sent.length, 2, "hangup must discard even the newest pending packet");
});

test("only an attached call extends the battery stream budget", async () => {
  const h = harness();
  h.input.write(Buffer.from([1]));
  await h.worker.starting;
  let extensions = 0;
  const notice = { extend: () => extensions++ };
  h.talk.emit("budget", notice);
  await h.worker.shutdown();
  h.talk.emit("budget", notice);
  assert.equal(extensions, 1);
});
