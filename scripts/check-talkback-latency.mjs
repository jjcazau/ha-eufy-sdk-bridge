// Exercise real HTTP forwarding and FFmpeg encoding at microphone speed. Camera/SDK startup must
// not turn into a persistent speech backlog. No account, camera or recorded speech is used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import { PassThrough, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { createTalkbackForwarder } from "../src/talkback-forwarder.mjs";
import { createTalkbackWorker } from "../src/talkback.mjs";

const input = new PassThrough();
let worker, forwarder, timer, encoder, encoderExited;
let readyAt,
  firstAudioAt,
  startupBytes = 0,
  audioBytes = 0;
let failure;
const server = http.createServer((request, response) => {
  const talk = new EventEmitter();
  talk.stop = async () => {};
  talk.writable = () =>
    new Writable({
      write(chunk, _encoding, done) {
        firstAudioAt ??= Date.now();
        audioBytes += chunk.length;
        done();
      },
    });
  worker = createTalkbackWorker({
    input: request,
    openTalkback: async () => {
      await delay(2000);
      readyAt = Date.now();
      response.writeHead(200);
      response.flushHeaders();
      return { talk, disconnect: async () => {} };
    },
    spawnProcess: (...args) => {
      encoder = spawn(...args);
      encoderExited = once(encoder, "exit");
      const write = encoder.stdin.write.bind(encoder.stdin);
      encoder.stdin.write = (chunk, ...rest) => {
        if (Date.now() - readyAt < 40) startupBytes += chunk.length;
        return write(chunk, ...rest);
      };
      return encoder;
    },
    log: (message) => {
      failure = message;
    },
  });
  request.on("error", () => {});
});
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  forwarder = createTalkbackForwarder({
    input,
    url: `http://127.0.0.1:${server.address().port}/talkback/TEST`,
    log: (message) => {
      failure = message;
    },
  });
  timer = setInterval(() => input.write(Buffer.alloc(160, 0xd5)), 20);
  await delay(4000);
  assert.equal(failure, undefined);
  assert.ok(readyAt, "speaker must have warmed up");
  assert.ok(startupBytes <= 640, `speaker startup replayed ${startupBytes / 8} ms of old microphone audio`);
  assert.ok(firstAudioAt, "encoder must produce AAC before hangup");
  const latency = firstAudioAt - readyAt;
  assert.ok(latency < 500, `microphone encoding took ${latency} ms after speaker readiness`);
  assert.ok(audioBytes > 100, "audio must keep flowing after startup");
  console.log(
    `PASS: startup retained at most ${startupBytes / 8} ms; first AAC emitted ${latency} ms after speaker readiness`,
  );
} finally {
  clearInterval(timer);
  forwarder?.shutdown();
  await worker?.shutdown();
  if (encoderExited) await encoderExited;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  input.destroy();
}
