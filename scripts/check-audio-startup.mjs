// Real go2rtc/FFmpeg regression: a normal Live request must negotiate promptly with real-time PCM,
// rather than waiting for FFmpeg's default five-second audio analysis before video can start.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeGo2rtcConfig } from "../go2rtc-config.mjs";

const dir = await mkdtemp(join(tmpdir(), "eufy-audio-startup-"));
const coldStartMs = Number(process.env.COLD_START_MS) || 0;
let go2rtc;
let server;
let socket;
try {
  const videoPath = join(dir, "fixture.h264");
  const fixture = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=size=320x240:rate=25",
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-g",
    "25",
    "-f",
    "h264",
    videoPath,
  ]);
  assert.equal(fixture.status, 0, "could not generate video fixture");
  const video = await readFile(videoPath);
  server = http
    .createServer((request, response) => {
      // Deliver one second of Annex-B video each second and raw PCM at its real-time rate.
      // Neither media source may buffer seconds of data before the Live SDP can be returned.
      const isAudio = request.url.startsWith("/audio/");
      const chunk = isAudio ? Buffer.alloc(640) : video;
      let timer;
      const start = () => {
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.write(chunk);
        timer = setInterval(() => response.write(chunk), isAudio ? 20 : 1000);
      };
      // A fresh SDK client may still be discovering the camera when go2rtc asks for video. Its
      // producer must wait for that first keyframe, rather than replace video with audio-only SDP.
      const warming = setTimeout(start, isAudio ? 0 : coldStartMs);
      response.on("close", () => {
        clearTimeout(warming);
        clearInterval(timer);
      });
    })
    .listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = join(dir, "go2rtc.yaml");
  await writeGo2rtcConfig({ go2rtcConfig: config, selfHost: "127.0.0.1", port: server.address().port }, [
    { sn: "TEST", stream: "/stream/TEST", audio: { incoming: true } },
  ]);
  const yaml = (await readFile(config, "utf8"))
    .replace(":1984", ":32284")
    .replace(":8554", ":32254")
    .replace(":8555", ":32255");
  await writeFile(config, yaml);
  go2rtc = spawn(process.env.GO2RTC_BIN || "go2rtc", ["-config", config], { stdio: "ignore" });
  let spawnError;
  go2rtc.on("error", (error) => {
    spawnError = error;
  });
  for (let i = 0; i < 40; i++) {
    if (spawnError) throw spawnError;
    try {
      if ((await fetch("http://127.0.0.1:32284/api")).ok) break;
    } catch {}
    await delay(100);
  }
  const start = Date.now();
  socket = net.connect(32254, "127.0.0.1");
  await once(socket, "connect");
  socket.write("DESCRIBE rtsp://127.0.0.1:32254/TEST RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n");
  const sdp = await new Promise((resolve, reject) => {
    let data = "";
    const timeout = setTimeout(
      () => reject(new Error("Live negotiation stalled after camera media became ready (over 2 seconds)")),
      coldStartMs + 2000,
    );
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      data += chunk.toString();
      const length = Number(data.match(/Content-Length: (\d+)/i)?.[1]);
      const boundary = data.indexOf("\r\n\r\n");
      if (boundary >= 0 && length && Buffer.byteLength(data.slice(boundary + 4)) >= length) {
        clearTimeout(timeout);
        resolve(data);
      }
    });
  });
  assert.match(sdp, /RTSP\/1.0 200 OK/);
  assert.match(sdp, /m=video/, "cold Live must contain video without first opening talkback");
  assert.match(sdp, /m=audio/);
  console.log(`PASS: normal Live negotiated video and camera audio in ${Date.now() - start}ms`);
} finally {
  socket?.destroy();
  if (go2rtc?.pid) {
    const exited = once(go2rtc, "exit");
    go2rtc.kill("SIGTERM");
    await exited;
  }
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
