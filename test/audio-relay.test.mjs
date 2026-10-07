import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createPcmAudioRelay } from "../src/audio-relay.mjs";

function fakeLive() {
  const live = new EventEmitter();
  live.paused = false;
  live.stopped = false;
  live.pause = () => {
    live.paused = true;
  };
  live.resume = () => {
    live.paused = false;
  };
  live.stop = () => {
    live.stopped = true;
  };
  return live;
}

function fakeProcess() {
  const p = new EventEmitter();
  p.stdin = new PassThrough();
  p.stdout = new PassThrough();
  p.kill = () => {
    p.killed = true;
  };
  return p;
}

test("audio relay chooses decoder args by eufy codec and keeps one stable PCM output", () => {
  const live = fakeLive();
  const output = new PassThrough();
  const calls = [];
  const procs = [];
  const spawnProcess = (bin, args) => {
    const p = fakeProcess();
    calls.push({ bin, args });
    procs.push(p);
    return p;
  };

  const close = createPcmAudioRelay({ live, output, spawnProcess });

  live.emit("audio", { codec: "aac-lc", data: Buffer.from([1, 2, 3]) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, "ffmpeg");
  assert.deepEqual(calls[0].args.slice(0, 8), [
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "nobuffer",
    "-f",
    "aac",
    "-i",
  ]);
  assert.ok(calls[0].args.includes("pcm_s16le"));
  assert.ok(calls[0].args.includes("16000"));

  // Same codec reuses the decoder.
  live.emit("audio", { codec: "aac-lc", data: Buffer.from([4]) });
  assert.equal(calls.length, 1);

  // A legal mid-stream codec change restarts only the decoder. Output remains s16le/16k/mono.
  live.emit("audio", { codec: "g711a", data: Buffer.from([5]) });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].args.includes("alaw"));
  assert.equal(procs[0].killed, true);

  close();
  assert.equal(live.stopped, true);
  assert.equal(procs[1].killed, true);
});

test("audio relay rejects an unknown SDK audio codec instead of guessing", () => {
  const live = fakeLive();
  const output = new PassThrough();
  const logs = [];
  const close = createPcmAudioRelay({
    live,
    output,
    spawnProcess: () => fakeProcess(),
    log: (message) => logs.push(message),
  });

  live.emit("audio", { codec: "mystery", data: Buffer.from([1]) });
  assert.equal(live.stopped, true);
  assert.ok(logs.some((message) => message.includes("unsupported eufy audio codec")));
  close();
});
