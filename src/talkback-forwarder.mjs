import http from "node:http";

export function createTalkbackForwarder({ input, url, log = () => {}, onExit = () => {} }) {
  let request;
  let stopped = false;
  function shutdown(code = 0) {
    if (stopped) return;
    stopped = true;
    input.removeListener("data", start);
    input.unpipe(request);
    request?.destroy();
    onExit(code);
  }
  function fail(error) {
    if (stopped) return;
    log(error?.message ?? String(error));
    shutdown(1);
  }
  function start(chunk) {
    input.pause();
    request = http.request(url, {
      method: "POST",
      headers: { "content-type": "audio/PCMA", "x-eufy-audio-format": "alaw/8000/mono" },
    });
    request.once("error", fail);
    request.once("response", (response) => {
      response.resume();
      if (response.statusCode !== 200) return fail(new Error(`bridge talkback returned HTTP ${response.statusCode}`));
      response.once("end", () => shutdown());
      response.once("error", fail);
    });
    request.write(chunk);
    input.pipe(request);
  }
  input.once("data", start);
  input.once("end", () => {
    if (!request) shutdown();
  });
  input.once("close", () => {
    if (!input.readableEnded) shutdown();
  });
  input.once("error", fail);
  return { shutdown };
}
