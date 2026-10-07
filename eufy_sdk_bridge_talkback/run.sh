#!/bin/sh
set -e

OPTS=/data/options.json
SUPERVISOR_API="${SUPERVISOR:-http://supervisor}"

export EUFY_EMAIL="$(jq -r '.email // ""' "$OPTS")"
export EUFY_PASSWORD="$(jq -r '.password // ""' "$OPTS")"
export EUFY_COUNTRY="$(jq -r '.country // "AU"' "$OPTS")"
export EUFY_SESSION="/data/.eufy-session.json"
export BRIDGE_HOST="0.0.0.0"

export EUFY_POLL_MS="$(jq -r '.poll_ms // 600000' "$OPTS")"
export STREAM_IDLE_MS="$(jq -r '.stream_idle_ms // 300000' "$OPTS")"
export RTSP_IDLE_OFF_MS="$(jq -r '.rtsp_idle_off_ms // 300000' "$OPTS")"
budget_ms="$(jq -r '.stream_battery_budget_ms // empty' "$OPTS")"
[ -n "$budget_ms" ] && export STREAM_BATTERY_BUDGET_MS="$budget_ms"
[ "$(jq -r '.prewarm // true' "$OPTS")" = "true" ] && export BRIDGE_PREWARM=1
[ "$(jq -r '.event_log // true' "$OPTS")" = "false" ] && export BRIDGE_EVENT_LOG=0
[ "$(jq -r '.debug // false' "$OPTS")" = "true" ] && export BRIDGE_DEBUG=1
[ "$(jq -r '.debug_p2p // false' "$OPTS")" = "true" ] && export BRIDGE_DEBUG_P2P=1
[ "$(jq -r '.go2rtc_enable // true' "$OPTS")" = "false" ] && export GO2RTC_ENABLE=0

# Advertise the published WebRTC port, not the container's :8555. Explicit candidates can also
# include a VPN/public address. Otherwise discover the primary LAN address from Supervisor.
export GO2RTC_WEBRTC_CANDIDATES="$(jq -r '(.webrtc_candidates // []) | join(",")' "$OPTS")"
if [ -z "$GO2RTC_WEBRTC_CANDIDATES" ] && [ -n "${SUPERVISOR_TOKEN:-}" ]; then
  network_info="$(curl -fsS -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" "${SUPERVISOR_API}/network/info")" || network_info='{}'
  addon_info="$(curl -fsS -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" "${SUPERVISOR_API}/addons/self/info")" || addon_info='{}'
  media_port="$(printf '%s' "$addon_info" | jq -r '.data.network["8555/udp"] // .data.network["8555/tcp"] // 8557')"
  lan_ip="$(printf '%s' "$network_info" | jq -r '[.data.interfaces[]? | select(.primary == true) | .ipv4.address[]? | split("/")[0]][0] // empty')"
  if [ -n "$lan_ip" ]; then
    export GO2RTC_WEBRTC_CANDIDATES="${lan_ip}:${media_port},stun:${media_port}"
  fi
fi

register_discovery() {
  [ -n "${SUPERVISOR_TOKEN:-}" ] || return 0

  addon_info="$(curl -fsS -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" "${SUPERVISOR_API}/addons/self/info")" || return 0
  network_info="$(curl -fsS -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" "${SUPERVISOR_API}/network/info")" || network_info='{"data":{}}'

  addon_host="$(printf '%s' "$addon_info" | jq -r '.data.hostname // "eufy-sdk-bridge-talkback"')"
  gateway="$(printf '%s' "$network_info" | jq -r '.data.docker.gateway // empty')"

  mapped_port() {
    key="$1"
    fallback="$2"
    value="$(printf '%s' "$addon_info" | jq -r --arg key "$key" '.data.network[$key] // empty')"
    if [ -n "$value" ]; then printf '%s\n' "$value"; else printf '%s\n' "$fallback"; fi
  }

  if [ -n "$gateway" ]; then bridge_host="$gateway"; else bridge_host="$addon_host"; fi
  bridge_port="$(mapped_port "3000/tcp" 3000)"
  rtsp_port="$(mapped_port "8554/tcp" 8554)"

  payload="$(jq -cn --arg host "$bridge_host" --argjson port "$bridge_port" --argjson rtsp_port "$rtsp_port" \
    '{service:"eufy_sdk",config:{host:$host,port:$port,go2rtc_rtsp_port:$rtsp_port}}')"

  curl -fsS -X POST \
    -H "Authorization: Bearer ${SUPERVISOR_TOKEN}" \
    -H "Content-Type: application/json" \
    -d "$payload" "${SUPERVISOR_API}/discovery" >/dev/null || true
}

wait_for_bridge() {
  health_url="http://127.0.0.1:3000/healthz"
  attempt=0
  until curl -fsS "$health_url" >/dev/null; do
    kill -0 "$bridge_pid" 2>/dev/null || return 1
    attempt=$((attempt + 1))
    [ "$attempt" -lt 30 ] || return 1
    sleep 1
  done
}

eufy-sdk-bridge &
bridge_pid="$!"

stop_bridge() {
  kill -TERM "$bridge_pid" 2>/dev/null || true
  wait "$bridge_pid" || true
}
trap stop_bridge TERM INT

(
  wait_for_bridge && register_discovery
) &

wait "$bridge_pid"
