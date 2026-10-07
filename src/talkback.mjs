// A worker owns one call. Metadata probes never log in; closing stdin cancels startup or ends the call.
import { spawn } from "node:child_process";

export function createTalkbackWorker({ input, openTalkback, spawnProcess = spawn, log = () => {}, onExit = () => {} }) {
  let session;
  let encoder;
  let sink;
  let stopped = false;
  let starting;
  let closing;

  const fail = (e) => {
    log(e?.message ?? String(e));
    void shutdown(1);
  };

  async function shutdown(code = 0) {
    if (stopped) return closing;
    stopped = true;
    input.removeListener("data", onFirstChunk);
    input.unpipe(encoder?.stdin);
    // Release the speaker immediately on hang-up; discard queued speech.
    closing = (async () => {
      encoder?.kill("SIGTERM");
      try {
        await session?.talk.stop();
      } catch (e) {
        log(e?.message ?? String(e));
      }
      try {
        await session?.disconnect();
      } catch (e) {
        log(e?.message ?? String(e));
      }
      onExit(code);
    })();
    return closing;
  }

  async function start(firstChunk) {
    input.pause();
    try {
      session = await openTalkback();
      // A caller can hang up while login/P2P is warming. Release the late handle too.
      if (stopped) {
        await session.talk.stop();
        await session.disconnect();
        return;
      }
      session.talk.on("error", fail);
      session.talk.once("stop", () => void shutdown());
      session.talk.once("finished", () => void shutdown());
      // Extend only while the call is attached. Hanging up still stops it immediately.
      session.talk.on("budget", (notice) => {
        if (!stopped) notice.extend();
      });
      encoder = spawnProcess(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-probesize",
          "32",
          "-analyzeduration",
          "0",
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
      encoder.once("error", fail);
      encoder.stdin.on("error", fail);
      encoder.stdout.on("error", fail);
      encoder.once("exit", (code, signal) => {
        if (!stopped) fail(new Error(`ffmpeg exited (code=${code}, signal=${signal})`));
      });
      sink = session.talk.writable();
      sink.on("error", fail);
      encoder.stdout.pipe(sink);
      encoder.stdin.write(firstChunk);
      input.pipe(encoder.stdin);
    } catch (e) {
      if (!stopped) fail(e);
    }
  }

  function onFirstChunk(chunk) {
    starting = start(chunk);
  }
  input.once("data", onFirstChunk);
  input.once("end", () => void shutdown());
  input.once("close", () => void shutdown());
  input.once("error", fail);
  return {
    shutdown,
    get starting() {
      return starting;
    },
  };
}
