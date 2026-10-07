// Convert eufy's live camera audio into one stable raw PCM format for go2rtc.
//
// The SDK reports one of three wire codecs per frame (AAC-LC, AAC-ELD, G.711 A-law). go2rtc should not
// have to know which model chose which codec, so this relay normalises all of them to signed 16-bit LE,
// 16 kHz, mono. The sibling go2rtc ffmpeg source then turns that small PCM stream into Opus for WebRTC.
//
// A codec change inside one live session is legal. Because the relay's OUTPUT format never changes we can
// restart only the decoder and keep the HTTP response open.
import { spawn } from "node:child_process";

const INPUT_ARGS = {
  "aac-lc": ["-f", "aac"],
  "aac-eld": ["-f", "aac"],
  g711a: ["-f", "alaw", "-ar", "16000", "-ac", "1"],
};

const OUTPUT_ARGS = ["-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"];

export function createPcmAudioRelay({ live, output, spawnProcess = spawn, log = () => {} }) {
  let decoder;
  let codec;
  let closed = false;
  let pausedForDrain = false;

  const stopDecoder = () => {
    if (!decoder) return;
    try {
      decoder.stdout?.unpipe(output);
    } catch {
      // best effort
    }
    try {
      decoder.stdin?.end();
    } catch {
      // best effort
    }
    try {
      decoder.kill("SIGTERM");
    } catch {
      // best effort
    }
    decoder = undefined;
    codec = undefined;
  };

  const startDecoder = (nextCodec) => {
    const input = INPUT_ARGS[nextCodec];
    if (!input) throw new Error(`unsupported eufy audio codec: ${nextCodec}`);
    stopDecoder();
    codec = nextCodec;
    decoder = spawnProcess(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-probesize",
        "32",
        "-analyzeduration",
        "0",
        ...input,
        "-i",
        "pipe:0",
        ...OUTPUT_ARGS,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    decoder.stdout.pipe(output, { end: false });
    const current = decoder;
    const failed = (e) => {
      if (closed || decoder !== current) return;
      log(`audio decoder error: ${e?.message ?? e}`);
      close();
    };
    decoder.once("error", failed);
    decoder.stdin.on("error", failed);
    decoder.stdout.on("error", failed);
    decoder.once("exit", (code, signal) => {
      if (!closed && decoder === current) failed(new Error(`exited code=${code} signal=${signal ?? ""}`));
    });
  };

  const onAudio = (frame) => {
    if (closed) return;
    try {
      if (!decoder || codec !== frame.codec) startDecoder(frame.codec);
      if (!decoder.stdin.write(frame.data) && !pausedForDrain) {
        pausedForDrain = true;
        live.pause?.();
        decoder.stdin.once("drain", () => {
          pausedForDrain = false;
          live.resume?.();
        });
      }
    } catch (e) {
      log(`audio relay failed: ${e?.message ?? e}`);
      close();
    }
  };

  const close = () => {
    if (closed) return;
    closed = true;
    live.off?.("audio", onAudio);
    stopDecoder();
    output.end();
    try {
      live.stop?.();
    } catch {
      // best effort
    }
  };

  live.on("audio", onAudio);
  return close;
}
