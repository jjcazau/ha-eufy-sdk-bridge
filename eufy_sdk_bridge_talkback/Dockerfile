ARG BUILD_FROM=node:24-alpine
FROM ${BUILD_FROM}

RUN apk add --no-cache ffmpeg curl jq git

ARG GO2RTC_VERSION=1.9.9
ARG BUILD_ARCH
RUN case "${BUILD_ARCH:-amd64}" in \
      amd64) g2="go2rtc_linux_amd64" ;; \
      arm64) g2="go2rtc_linux_arm64" ;; \
      *) echo "unsupported BUILD_ARCH: ${BUILD_ARCH}" && exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/go2rtc \
      "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/${g2}" \
 && chmod +x /usr/local/bin/go2rtc

WORKDIR /app
ARG BRIDGE_REPO=https://github.com/jjcazau/ha-eufy-sdk-bridge.git
ARG BRIDGE_REF=main
RUN git clone --depth 1 --branch "${BRIDGE_REF}" "${BRIDGE_REPO}" /tmp/bridge \
 && cp -a /tmp/bridge/. /app/ \
 && rm -rf /tmp/bridge /app/.git \
 && npm ci --omit=dev --no-audit --no-fund \
 && chmod +x /app/bin/start.sh \
 && ln -sf /app/bin/start.sh /usr/local/bin/eufy-sdk-bridge

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENV BRIDGE_APP_DIR=/app \
    BRIDGE_PORT=3000 \
    BRIDGE_HOST=0.0.0.0 \
    GO2RTC_CONFIG=/app/data/go2rtc.yaml \
    EUFY_SESSION=/data/.eufy-session.json

LABEL \
    org.opencontainers.image.title="Home Assistant Add-on: eufy-sdk bridge Talkback Fork" \
    org.opencontainers.image.description="Experimental Eufy bridge with live audio and WebRTC talkback." \
    org.opencontainers.image.source="https://github.com/jjcazau/ha-eufy-sdk-bridge" \
    org.opencontainers.image.licenses="Apache-2.0"

CMD ["/run.sh"]
