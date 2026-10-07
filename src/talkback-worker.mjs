// go2rtc supplies raw PCMA / 8 kHz on stdin. Forward it to the local bridge so talkback shares the
// viewer's SDK/P2P session. A metadata probe with no microphone bytes never opens an HTTP request.
import { createTalkbackForwarder } from "./talkback-forwarder.mjs";

const sn = String(process.argv[2] ?? "").trim();
if (!sn) {
  console.error("[talkback] missing device serial");
  process.exit(2);
}
const worker = createTalkbackForwarder({
  input: process.stdin,
  url: `http://127.0.0.1:${Number(process.env.BRIDGE_PORT) || 3000}/talkback/${encodeURIComponent(sn)}`,
  log: (message) => console.error(`[talkback] ${message}`),
  onExit: (code) => process.exit(code),
});
process.on("SIGTERM", () => worker.shutdown());
process.on("SIGINT", () => worker.shutdown());
