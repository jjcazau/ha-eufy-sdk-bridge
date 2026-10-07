// Exercise the generated config against the bundled go2rtc, including the Origin forwarded by
// Home Assistant Web Proxy. Run inside the app image so its pinned binary is tested before publishing.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { writeGo2rtcConfig } from "../go2rtc-config.mjs";

const dir = await mkdtemp(join(tmpdir(), "go2rtc-origin-"));
let proc;
try {
  const config = join(dir, "go2rtc.yaml");
  await writeGo2rtcConfig({ go2rtcConfig: config, selfHost: "127.0.0.1", port: 3000 }, []);
  proc = spawn("go2rtc", ["-config", config], { stdio: "ignore" });
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  let spawnError;
  proc.once("error", (error) => (spawnError = error));
  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (spawnError) throw spawnError;
    try {
      ready = (await fetch("http://127.0.0.1:1984/api"))?.ok;
    } catch {}
    if (ready) break;
    await delay(100);
  }
  assert.ok(ready, "go2rtc API did not become ready");
  for (const stream of ["TEST", "TEST_2way"]) {
    await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:1984/api/ws?src=${stream}`, {
        origin: "https://home-assistant.example",
        handshakeTimeout: 3000,
      });
      socket.once("open", () => {
        socket.close();
        resolve();
      });
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        socket.terminate();
        reject(new Error(`${stream}: HA-origin WebSocket returned HTTP ${response.statusCode}`));
      });
      socket.once("error", reject);
    });
  }
  console.log("PASS: live and microphone WebSockets accept the forwarded Home Assistant origin");
  proc.kill("SIGTERM");
  await exited;
} finally {
  proc?.kill("SIGTERM");
  await rm(dir, { recursive: true, force: true });
}
