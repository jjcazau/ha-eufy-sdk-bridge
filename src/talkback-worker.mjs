// go2rtc exec backchannel supplies raw PCMA / 8 kHz to stdin. The SDK takes AAC-LC / 16 kHz ADTS.
import { EufyMega, FileSessionStore, LoginStatus } from "@mega-yfue/eufy-sdk";
import { createTalkbackWorker } from "./talkback.mjs";

const sn = String(process.argv[2] ?? "").trim();
if (!sn) {
  console.error("[talkback] missing device serial");
  process.exit(2);
}

const worker = createTalkbackWorker({
  input: process.stdin,
  log: (message) => console.error(`[talkback] ${message}`),
  onExit: (code) => process.exit(code),
  openTalkback: async () => {
    const client = new EufyMega({
      email: process.env.EUFY_EMAIL,
      password: process.env.EUFY_PASSWORD,
      countryCode: process.env.EUFY_COUNTRY || "GB",
      store: new FileSessionStore(process.env.EUFY_SESSION || "./data/.eufy-session.json"),
      openudid: process.env.BRIDGE_OPENUDID || undefined,
      autoRealtime: false,
    });
    client.on("error", (e) => console.error(`[talkback] sdk error: ${e?.message ?? e}`));
    try {
      const login = await client.login();
      if (login.status !== LoginStatus.Ok) throw new Error(`could not hydrate eufy session (${login.status})`);
      const cam = (await client.getDevice(sn)).camera?.();
      if (!cam?.talkback) throw new Error(`device ${sn} does not expose talkback`);
      const talk = await cam.talkback();
      return { talk, disconnect: () => client.disconnect() };
    } catch (e) {
      await client.disconnect().catch(() => {});
      throw e;
    }
  },
});
process.on("SIGTERM", () => void worker.shutdown());
process.on("SIGINT", () => void worker.shutdown());
