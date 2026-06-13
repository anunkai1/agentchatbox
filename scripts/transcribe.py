#!/usr/bin/env python3
"""
Local Whisper transcription for agentchatbox.

Reads an audio file from argv[1], transcribes it with faster-whisper (CPU),
prints {"text": "...", "language": "...", "duration": ...} on stdout.

When called with --self-test, just exits 0 if faster-whisper is importable
and prints "ok" — used by /api/health to probe availability.

Model: "small" by default. Override with WHISPER_MODEL env var.
Device: CPU (compute_type=int8). Local-first / no paid APIs.
"""

import json
import os
import sys
import time


def self_test() -> int:
    try:
        from faster_whisper import WhisperModel  # noqa: F401
    except Exception as e:
        print(f"faster-whisper import failed: {e}", file=sys.stderr)
        return 1
    print("ok")
    return 0


def transcribe(audio_path: str) -> int:
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        print(f"faster-whisper not installed: {e}", file=sys.stderr)
        return 2

    model_name = os.environ.get("WHISPER_MODEL", "small")
    # First call downloads the model; subsequent calls are fast.
    # Use int8 for CPU; float16 would need a GPU.
    t0 = time.time()
    model = WhisperModel(model_name, device="cpu", compute_type="int8")

    try:
        segments, info = model.transcribe(audio_path, beam_size=1, vad_filter=True)
    except Exception as e:
        print(f"transcribe failed: {e}", file=sys.stderr)
        return 3

    text = " ".join(seg.text.strip() for seg in segments).strip()
    out = {
        "text": text,
        "language": info.language,
        "duration": info.duration,
        "modelLoadMs": int((time.time() - t0) * 1000),
    }
    print(json.dumps(out))
    return 0


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] == "--self-test":
        return self_test()
    if len(sys.argv) < 2:
        print("usage: transcribe.py <audio-path> | --self-test", file=sys.stderr)
        return 64
    return transcribe(sys.argv[1])


if __name__ == "__main__":
    sys.exit(main())
