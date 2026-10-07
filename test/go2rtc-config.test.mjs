// A call must use the same stream ID as Live: Advanced Camera Card also displays its call target.
// The lazy backchannel opens the speaker only when microphone samples arrive.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { writeGo2rtcConfig } from "../go2rtc-config.mjs";

const cams = [
  { sn: "CAM1", stream: "/stream/CAM1", state: { microphone: true, speaker: true } },
  { sn: "VIDEO_ONLY", stream: "/stream/VIDEO_ONLY", state: {} },
  { sn: "SENSOR1" }, // no stream path → not a camera, must not appear
];

async function generate(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go2rtc-"));
  const file = path.join(dir, "go2rtc.yaml");
  const sns = await writeGo2rtcConfig({ go2rtcConfig: file, selfHost: "127.0.0.1", port: 3000, ...extra }, cams);
  return { yaml: fs.readFileSync(file, "utf8"), sns };
}

test("camera view stream uses native video and adds normalized incoming audio", async () => {
  const { yaml, sns } = await generate();
  assert.deepEqual(sns, ["CAM1", "VIDEO_ONLY"]);
  assert.match(yaml, /- http:\/\/127\.0\.0\.1:3000\/stream\/CAM1\n/);
  assert.match(yaml, /- ffmpeg:http:\/\/127\.0\.0\.1:3000\/audio\/CAM1#input=eufy_pcm#audio=opus/);
  assert.match(yaml, /eufy_pcm: ".*-f s16le -ar 16000 -ac 1 -i \{input\}"/);
});

test("WebRTC candidates advertise the mapped host media port under webrtc", async () => {
  const { yaml } = await generate({ webrtcCandidates: ["192.0.2.1:8557", "stun:8557"] });
  assert.match(yaml, /webrtc:\n  listen: ":8555"\n  candidates:\n    - "192.0.2.1:8557"\n    - "stun:8557"\nffmpeg:/);
});

test("speaker-capable camera gets a separate lazy two-way stream", async () => {
  const { yaml } = await generate();
  assert.match(yaml, /CAM1_2way:/);
  assert.match(yaml, /talkback-worker\.mjs CAM1#backchannel=1#audio=alaw\/8000/);
  assert.ok(!yaml.includes("VIDEO_ONLY_2way"), "no speaker evidence means no talkback stream");
});

test("the Live stream supports the audio-only call without changing the displayed stream ID", async () => {
  const { yaml } = await generate();
  const live = yaml.split("  CAM1:\n")[1].split("  CAM1_2way:\n")[0];
  assert.match(live, /http:\/\/127\.0\.0\.1:3000\/stream\/CAM1/);
  assert.match(live, /exec:node \/app\/src\/talkback-worker\.mjs CAM1#backchannel=1#audio=alaw\/8000/);
  const videoOnly = yaml.split("  VIDEO_ONLY:\n")[1];
  assert.ok(!videoOnly.includes("backchannel=1"), "a video-only camera must not advertise talkback");
});

test("muted hardware still has a backchannel when the SDK exposes talkback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go2rtc-"));
  const file = path.join(dir, "go2rtc.yaml");
  await writeGo2rtcConfig({ go2rtcConfig: file, selfHost: "127.0.0.1", port: 3000 }, [
    {
      sn: "MUTED",
      stream: "/stream/MUTED",
      state: { speaker: false, microphone: false },
      audio: { incoming: true, talkback: true },
    },
  ]);
  const yaml = fs.readFileSync(file, "utf8");
  assert.match(yaml, /MUTED_2way:/);
  assert.match(yaml, /audio\/MUTED/);
});

test("a camera without microphone evidence stays video-only", async () => {
  const { yaml } = await generate();
  assert.match(yaml, /- http:\/\/127\.0\.0\.1:3000\/stream\/VIDEO_ONLY\n/);
  assert.ok(!yaml.includes("/audio/VIDEO_ONLY"), "no microphone evidence means no inbound audio source");
});

test("a device without a stream path is left out", async () => {
  const { yaml } = await generate();
  assert.ok(!yaml.includes("SENSOR1"), "non-camera devices must not become go2rtc streams");
});
