// The generated go2rtc config defines a view-only stream and, when supported, a separate two-way
// backchannel. Keeping those separate prevents ordinary viewing from opening the camera speaker.
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

async function generate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "go2rtc-"));
  const file = path.join(dir, "go2rtc.yaml");
  const sns = await writeGo2rtcConfig({ go2rtcConfig: file, selfHost: "127.0.0.1", port: 3000 }, cams);
  return { yaml: fs.readFileSync(file, "utf8"), sns };
}

test("camera view stream keeps async video and adds normalized incoming audio", async () => {
  const { yaml, sns } = await generate();
  assert.deepEqual(sns, ["CAM1", "VIDEO_ONLY"]);
  assert.match(yaml, /- ffmpeg:http:\/\/127\.0\.0\.1:3000\/stream\/CAM1#video=copy#async/);
  assert.match(yaml, /- ffmpeg:http:\/\/127\.0\.0\.1:3000\/audio\/CAM1#input=eufy_pcm#audio=opus/);
  assert.match(yaml, /eufy_pcm: ".*-f s16le -ar 16000 -ac 1 -i \{input\}"/);
});

test("speaker-capable camera gets a separate lazy two-way stream", async () => {
  const { yaml } = await generate();
  assert.match(yaml, /CAM1_2way:/);
  assert.match(yaml, /talkback-worker\.mjs CAM1#backchannel=1#audio=alaw\/8000/);
  assert.ok(!yaml.includes("VIDEO_ONLY_2way"), "no speaker evidence means no talkback stream");
});

test("a camera without microphone evidence stays video-only", async () => {
  const { yaml } = await generate();
  assert.match(yaml, /stream\/VIDEO_ONLY#video=copy#async/);
  assert.ok(!yaml.includes("/audio/VIDEO_ONLY"), "no microphone evidence means no inbound audio source");
});

test("a device without a stream path is left out", async () => {
  const { yaml } = await generate();
  assert.ok(!yaml.includes("SENSOR1"), "non-camera devices must not become go2rtc streams");
});
