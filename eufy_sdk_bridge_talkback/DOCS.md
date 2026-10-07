# eufy-sdk bridge (Talkback Fork)

This is a test Home Assistant add-on for the `jjcazau/ha-eufy-sdk-bridge` fork.

It preserves the upstream bridge behavior and adds:

- incoming camera audio through go2rtc;
- a separate `<serial>_2way` go2rtc stream for microphone backchannel;
- lazy Eufy SDK talkback, opened only when actual microphone audio is sent.

The add-on intentionally uses different default host ports from upstream so both can be installed at
once while testing:

- bridge/control: **3001**
- go2rtc API: **internal only on 1984** (use Home Assistant Web Proxy)
- RTSP: **8556**
- WebRTC TCP/UDP: **8557**

The go2rtc API intentionally is not published to the LAN because it has no authentication. Advanced Camera Card should reach the internal `http://<add-on-hostname>:1984` endpoint through the Home Assistant Web Proxy integration (`proxy.live: true`). WebRTC media itself uses published port **8557**.

Do not run this fork and the upstream bridge against the same Eufy account at the same time. Stop the
upstream bridge before starting this one so the two sessions do not compete for Eufy authentication or
realtime delivery.
