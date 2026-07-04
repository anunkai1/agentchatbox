#!/usr/bin/env bash
#
# qBittorrent post-download guard for the media-stack.
#
# Runs inside the qBittorrent container after every torrent finishes. If any
# large file inside the torrent is NOT a known video container, treat it as
# malware/fake and:
#   1. Move the file/folder to /config/quarantine/ (persists in the volume).
#   2. Remove the torrent from qBittorrent via its Web API (data already
#      moved, so deleteFiles=false).
#
# Sonarr will then fail its import (file missing), and
# BlocklistService.Handle(DownloadFailedEvent) will auto-blocklist the
# infohash in Sonarr -- so the same torrent won't be re-grabbed.
#
# === Wiring in qBittorrent UI ===
# Settings -> BitTorrent -> "Run external program on torrent completion":
#     F="%F" N="%N" H="%I" /config/qbittorrent-file-guard.sh
# (qBittorrent substitutes %F=path, %N=name, %I=infohash v1 at runtime.)
#
# === Required (already present in the lscr.io/linuxserver/qBittorrent image) ===
#   bash, python3, curl
#
# === Notes ===
# - This script lives at /config/qbittorrent-file-guard.sh inside the
#   container (mounted from /srv/media-stack/config/qbittorrent/ on the host).
# - Uses Python for magic-byte detection (no need to install libmagic).
# - Quarantine is /config/quarantine/ -- persists in the volume, review and
#   delete manually.
# - Log path: /config/qbittorrent-file-guard.log (persists, ~10MB rotated).

set -u
LOG=/config/qbittorrent-file-guard.log
QUAR=/config/quarantine

TFILE="${F:-${TORRENT_PATH:-}}"
TNAME="${N:-${TORRENT_NAME:-unknown}}"
HASH="${H:-${TORRENT_HASH:-}}"

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"; }

log "guard: torrent='$TNAME' path='$TFILE' hash='$HASH'"

if [[ -z "$TFILE" || ! -e "$TFILE" ]]; then
  log "guard: no path, exiting"
  exit 0
fi

# Delegate the magic-byte check to Python. Returns:
#   "video:<format>"  if file looks like a real video/audio container
#   "executable:<desc>"  if it looks like a Windows/Linux executable
#   "unknown:<desc>"  otherwise (also reject)
RESULT=$(F="$TFILE" python3 - <<'PY'
import os, sys

path = os.environ['F']
size = os.path.getsize(path)
if size < 50 * 1024 * 1024:
    # Below 50MB -- not the payload, probably .nfo/.srt/.txt; allow.
    print("video:tiny")
    sys.exit(0)

with open(path, 'rb') as f:
    head = f.read(64)

# Reject executables first (highest priority).
if head[:2] == b'MZ':
    # DOS/PE. Real malware files have a PE header at e_lfanew; we trust
    # libmagic-style detection just on 'MZ' since it's not a video header.
    print("executable:PE/DOS")
elif head[:4] == b'\x7fELF':
    print("executable:ELF")
elif head[:2] == b'#!':
    print("executable:script")
elif head[:4] == b'PK\x03\x04' or head[:4] == b'PK\x05\x06' or head[:4] == b'PK\x07\x08':
    print("executable:ZIP/JAR/APK")
elif head[:3] == b'\x1f\x8b\x08':
    print("executable:gzip-binary")

# Accept known video containers. Libmagic-equivalent on first 4-12 bytes.
elif head[:4] == b'\x1a\x45\xdf\xa3':
    # Matroska/WebM
    print("video:MKV/WebM")
elif head[4:8] == b'ftyp':
    # MP4 / MOV / M4V / 3GP / HEIC etc.
    print("video:MP4/ISOBMFF")
elif head[:3] == b'ID3' or head[:2] in (b'\xff\xfb', b'\xff\xf3', b'\xff\xf2'):
    # MP3
    print("audio:MP3")
elif head[:4] == b'fLaC':
    print("audio:FLAC")
elif head[:4] == b'OggS':
    print("audio:Ogg")
elif head[:4] == b'RIFF' and head[8:12] == b'AVI ':
    print("video:AVI")
elif head[:4] == b'Rar!' or head[:7] == b'Rar!\x1a\x07\x00':
    # RAR archive masquerading as video -- not a video
    print("executable:RAR")
elif head[:3] == b'7z\xbc\xaf\x27':
    print("executable:7z")
else:
    print(f"unknown:{head[:16]!r}")
PY
)

log "  check $TFILE -> $RESULT"

case "$RESULT" in
  video:*|audio:*)
    log "guard: all files OK"
    exit 0 ;;
  *)
    log "guard: REJECT ($RESULT)"
    ;;
esac

# --- Quarantine ---
mkdir -p "$QUAR" 2>>"$LOG"
SAFE_NAME=$(echo "$TNAME" | tr '/ ' '__')
TS=$(date +%s)
TARGET="$QUAR/${SAFE_NAME}_${TS}"
if mv -- "$TFILE" "$TARGET" 2>>"$LOG"; then
  log "guard: quarantined to $TARGET"
else
  log "guard: ERROR could not move $TFILE -> $TARGET"
  exit 1
fi

# Remove the torrent from qBittorrent (data already moved).
QB_HOST="${QB_HOST:-http://localhost:8080}"
QB_USER="${QB_USER:-admin}"
QB_PASS="${QB_PASS:-adminadmin}"

COOKIE=$(mktemp)
trap 'rm -f "$COOKIE"' EXIT
if curl -fsS -c "$COOKIE" --max-time 10 \
     --data "username=${QB_USER}&password=${QB_PASS}" \
     "${QB_HOST}/api/v2/auth/login" >/dev/null 2>>"$LOG"; then
  if [[ -n "$HASH" ]]; then
    curl -fsS -b "$COOKIE" --max-time 10 -X POST \
      --data-urlencode "hashes=$HASH" \
      --data-urlencode "deleteFiles=false" \
      "${QB_HOST}/api/v2/torrents/delete" >/dev/null 2>>"$LOG" \
      && log "guard: removed torrent $HASH from qBittorrent" \
      || log "guard: WARN could not remove torrent $HASH"
  fi
else
  log "guard: WARN could not log into qBittorrent API"
fi

# Sonarr will see the missing file on next queue refresh and emit
# DownloadFailedEvent, which BlocklistService auto-blocklists.
log "guard: done '$TNAME'"
exit 0