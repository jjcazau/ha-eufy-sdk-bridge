// A live viewer and the microphone must use the same per-camera SDK client. Hanging up must release
// only the talkback consumer, leaving the viewer's media session running.
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import http from "node:http";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createState } from "../src/state.mjs";

process.env.BRIDGE_STREAM_CONSUMER_LOG_MS = "0";
const { createHttpHandler } = await import("../src/http-routes.mjs");

test("remote clients cannot upload microphone audio to the bridge", async () => {
  const state = createState();
  state.flags.ready = true;
  let clientOpened = false;
  const handler = createHttpHandler({
    ...loadConfig({ EUFY_EMAIL: "test@example.com", EUFY_PASSWORD: "fixture" }),
    state,
    streamClientFor: async () => {
      clientOpened = true;
    },
  });
  let status;
  await handler(
    { method: "POST", url: "/talkback/CAM1", headers: { host: "localhost" }, socket: { remoteAddress: "192.0.2.1" } },
    {
      writeHead: (code) => {
        status = code;
      },
      end: () => {},
    },
  );
  assert.equal(status, 403);
  assert.equal(clientOpened, false);
});

test("microphone joins the viewer's client and hanging up keeps video alive", async () => {
  const state = createState();
  state.flags.ready = true;
  const video = new PassThrough();
  const talk = new EventEmitter();
  const audio = new PassThrough();
  let stops = 0;
  let disconnects = 0;
  talk.writable = () => audio;
  talk.stop = async () => {
    stops++;
    talk.emit("stop");
  };
  const camera = { openReadable: async () => video, talkback: async () => talk };
  const client = {
    getDevice: async () => ({ camera: () => camera }),
    disconnect: async () => {
      disconnects++;
      video.destroy();
    },
  };
  const requests = [];
  const handler = createHttpHandler({
    ...loadConfig({ EUFY_EMAIL: "test@example.com", EUFY_PASSWORD: "fixture" }),
    state,
    eventLog: () => {},
    broadcast: () => {},
    streamClientFor: async (sn) => {
      requests.push(sn);
      return client;
    },
    spawnTalkbackEncoder: () => {
      const encoder = new EventEmitter();
      encoder.stdin = new PassThrough();
      encoder.stdout = encoder.stdin;
      encoder.kill = () => encoder.stdin.destroy();
      return encoder;
    },
  });
  const server = http.createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  let viewer;
  let mic;
  try {
    viewer = http.get(`http://127.0.0.1:${port}/stream/CAM1`);
    const responsePromise = once(viewer, "response");
    // Flush a frame only once the handler has attached the viewer.
    while (!state.streaming.has("CAM1")) await new Promise((r) => setImmediate(r));
    video.write("before call");
    const [response] = await responsePromise;
    response.resume();
    mic = http.request(`http://127.0.0.1:${port}/talkback/CAM1`, { method: "POST" });
    const micResponse = once(mic, "response");
    mic.write(Buffer.alloc(160, 0xd5));
    const [ack] = await micResponse;
    assert.equal(ack.statusCode, 200, "microphone must join through the bridge, rather than a second SDK process");
    ack.resume();
    assert.deepEqual(requests, ["CAM1", "CAM1"]);
    assert.equal(disconnects, 0);
    const during = once(response, "data");
    video.write("during call");
    assert.equal((await during)[0].toString(), "during call");
    const ended = once(ack, "end");
    mic.end();
    await ended;
    assert.equal(stops, 1);
    assert.equal(disconnects, 0, "hang-up must not disconnect the shared viewer client");
    const after = once(response, "data");
    video.write("after call");
    assert.equal((await after)[0].toString(), "after call");
  } finally {
    viewer?.destroy();
    mic?.destroy();
    video.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
