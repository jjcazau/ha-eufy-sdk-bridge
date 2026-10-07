// go2rtc backchannel sink: browser microphone -> PCMA -> AAC-LC -> eufy SDK talkback.
//
// go2rtc starts this process only for the dedicated <serial>_2way stream. It writes WebRTC microphone
// audio to stdin as G.711 A-law / 8 kHz. The eufy SDK requires AAC-LC / 16 kHz / mono / ADTS at <=32 kbps.
//
// IMPORTANT: do not log in or open talkback until stdin actually produces microphone audio. go2rtc and
// Advanced Camera Card may probe stream metadata; a probe must not occupy the doorbell speaker path.
import { spawn } from "node:child_process";
import { EufyMega, FileSessionStore, LoginStatus } from "@mega-yfue/eufy-sdk";

const sn = String(process.argv[2] ?? "").trim();
if (!sn) {
  console.error("[talkback] missing device serial");
  process.exit(2);
}

let client;
let talk;
let encoder;
let starting = false;
let stopping = false;
let active = false;

async function shutdown(code = 0, dropQueued = true) {
  if (stopping) return;
  stopping = true;

  try {
    process.stdin.unpipe(encoder?.stdin);
  } catch {
    // best effort
  }
  try {
    encoder?.stdin?.end();
  } catch {
    // best effort
  }
  if (dropQueued) {
    try {
      talk?.stop?.();
    } catch {
      // best effort
    }
  }
  try {
    encoder?.kill("SIGTERM");
  } catch {
    // best effort
  }
  try {
    await client?.disconnect?.();
  } catch {
    // best effort
  }
  process.exit(code);
}

async function start(firstChunk) {
  if (starting || active) return;
  starting = true;
  process.stdin.pause();

  try {
    client = new EufyMega({
      email: process.env.EUFY_EMAIL,
      password: process.env.EUFY_PASSWORD,
      countryCode: process.env.EUFY_COUNTRY || "GB",
      store: new FileSessionStore(process.env.EUFY_SESSION || "./data/.eufy-session.json"),
      openudid: process.env.BRIDGE_OPENUDID || undefined,
      autoRealtime: false,
    });

    const login = await client.login();
    if (login.status !== LoginStatus.Ok) {
      throw new Error(`could not hydrate eufy session (${login.status})`);
    }

    const cam = (await client.getDevice(sn)).camera?.();
    if (!cam?.talkback) throw new Error(`device ${sn} does not expose talkback`);
    talk = await cam.talkback();

    encoder = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-fflags",
        "nobuffer",
        "-f",
        "alaw",
        "-ar",
        "8000",
        "-ac",
        "1",
        "-i",
        "pipe:0",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "aac",
        "-b:a",
        "32k",
        "-f",
        "adts",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );

    encoder.once("error", (e) => {
      console.error(`[talkback] ffmpeg error: ${e?.message ?? e}`);
      void shutdown(1);
    });
    encoder.once("exit", (code) => {
      if (active && code && code !== 0) {
        console.error(`[talkback] ffmpeg exited with code ${code}`);
        void shutdown(1);
      }
    });
    talk.on("error", (e) => console.error(`[talkback] sdk error: ${e?.message ?? e}`));
    talk.once("finished", () => void shutdown(0, false));

    encoder.stdout.pipe(talk.writable());
    if (!encoder.stdin.write(firstChunk)) process.stdin.pause();
    encoder.stdin.once("drain", () => process.stdin.resume());
    process.stdin.pipe(encoder.stdin);
    active = true;
    starting = false;
    process.stdin.resume();
  } catch (e) {
    console.error(`[talkback] ${e?.message ?? e}`);
    await shutdown(1);
  }
}

// Using the first actual microphone byte as the start signal avoids opening a talkback session when
// go2rtc merely probes metadata for two-way-audio capability.
process.stdin.once("data", (firstChunk) => {
  void start(firstChunk);
});
process.stdin.once("end", () => {
  if (!active && !starting) void shutdown(0, false);
});
process.on("SIGTERM", () => void shutdown(0));
process.on("SIGINT", () => void shutdown(0));
