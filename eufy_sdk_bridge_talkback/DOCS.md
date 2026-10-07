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

The generated config accepts the browser Origin forwarded by Home Assistant Web Proxy. Without
`api.origin: "*"`, go2rtc rejects proxied live and microphone WebSockets with HTTP 403 because the
browser origin differs from the internal app hostname. Keep port 1984 internal when using this setting.

Do not run this fork and the upstream bridge against the same Eufy account at the same time. Stop the
upstream bridge before starting this one so the two sessions do not compete for Eufy authentication or
realtime delivery.

## On-demand live view

Opening a go2rtc stream pulls `/stream/<serial>`, which calls the SDK's `openReadable()` and sends the
camera's live-media start command over P2P. Motion and the Eufy app are not prerequisites. A sleeping
battery doorbell can take several seconds to wake. Closing the player releases the stream.

The default battery budget stops a continuous stream after about 55 seconds; set
`stream_battery_budget_ms: 300000` for a five-minute live view. The idle guard also stops a stream after
five minutes without a detection. Leaving the dashboard's live player on continuously will wake the
camera and drain its battery; use the card's image view and tap Live when needed.

## WebRTC and the existing HACS integration

`webrtc_candidates` defaults to automatic detection of the primary HA LAN address and the published
WebRTC port. If detection fails or a VPN is used, set candidates explicitly, for example
`["192.0.2.1:8557", "stun:8557"]` (replace the example IP with your HA address).

The installed upstream HACS integration version 0.3.0 hardcodes RTSP port 8554 and has no host/port
reconfigure flow. To preserve existing entities without forking it, stop the upstream bridge, map this
fork's control port to the existing **3000**, and map RTSP to **8554**. The fork's separate test defaults
3001/8556 are suitable for staging, but do not match that existing integration automatically.

Keep the go2rtc API internal. Home Assistant Web Proxy and Advanced Camera Card can use
`http://<fork-add-on-hostname>:1984` with `proxy.live: true`. HTTPS/Companion-app microphone permission
is required for browser talkback.

Advanced Camera Card 8.1.0 supports a view camera plus a hidden call dependency:

```yaml
type: custom:advanced-camera-card
view:
  default: image
cameras:
  - camera_entity: camera.doorbell
    id: doorbell
    live_provider: go2rtc
    go2rtc:
      url: http://<fork-add-on-hostname>:1984
      stream: <serial>
      modes: [webrtc]
    proxy:
      live: true
    dependencies:
      cameras: [doorbell_2way]
  - camera_entity: camera.doorbell
    id: doorbell_2way
    live_provider: go2rtc
    go2rtc:
      url: http://<fork-add-on-hostname>:1984
      stream: <serial>_2way
      modes: [webrtc]
    proxy:
      live: true
    capabilities:
      disable_except: [2-way-audio]
menu:
  buttons:
    microphone:
      enabled: true
      type: toggle
    mute:
      enabled: true
```

Replace the serial and hostname with the discovered values. Tap Live to wake the doorbell, then Call
and Microphone to speak. Hang up to release the speaker. Viewing and metadata probes never open
Eufy talkback. The microphone worker extends its battery budget only while the call remains attached.

Validation covers Node 24 unit tests, real ffmpeg conversion, and an ARM64 container build. Audible
playback on each doorbell model still requires a physical test; AAC-ELD decoding is not hardware-verified.

## Installation builds

From app version 0.1.2, GitHub Actions publishes prebuilt amd64 and aarch64 app images to GHCR after
source checks pass. Supervisor downloads the image instead of installing ffmpeg and npm dependencies
on the Home Assistant host. Each image embeds the exact Git commit being published. The Dockerfile
remains available for local/source builds.
