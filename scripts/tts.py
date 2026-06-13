#!/usr/bin/env python3
"""
Local TTS via piper-tts for agentchatbox.

Reads text from argv[1] (a file path) or stdin (when --stdin is passed),
synthesizes speech using the configured voice, writes a WAV to the path
given as argv[2] (or stdout if --stdout).

Default voice: en_US-amy-medium (matches the user's hermes TTS config).
Override with PIPER_VOICE env var (just the voice id, e.g.
"en_US-lessac-medium").

When called with --self-test, just checks piper is importable and the
voice file exists. Exits 0 on success, non-zero on failure. Used by
/api/health to probe availability.
"""

import json
import os
import sys
import wave


DEFAULT_VOICE = "en_US-amy-medium"

# Piper writes voices to ~/.local/share/piper/voices/ by default
# (XDG_DATA_HOME/piper/voices).
def _voice_paths(voice: str) -> tuple[str, str]:
    base = os.path.join(
        os.environ.get("XDG_DATA_HOME", os.path.expanduser("~/.local/share")),
        "piper",
        "voices",
    )
    return (
        os.path.join(base, f"{voice}.onnx"),
        os.path.join(base, f"{voice}.onnx.json"),
    )


def self_test() -> int:
    try:
        from piper import PiperVoice  # noqa: F401
    except Exception as e:
        print(f"piper import failed: {e}", file=sys.stderr)
        return 1
    voice = os.environ.get("PIPER_VOICE", DEFAULT_VOICE)
    onnx, jsonp = _voice_paths(voice)
    if not os.path.exists(onnx):
        print(f"voice model not found: {onnx}", file=sys.stderr)
        return 2
    if not os.path.exists(jsonp):
        print(f"voice config not found: {jsonp}", file=sys.stderr)
        return 3
    print(json.dumps({"voice": voice, "onnx": onnx, "sample_rate": "from-model"}))
    return 0


def synthesize(text: str, out_path: str) -> int:
    import numpy as np
    from piper import PiperVoice

    voice = os.environ.get("PIPER_VOICE", DEFAULT_VOICE)
    onnx, jsonp = _voice_paths(voice)
    if not os.path.exists(onnx) or not os.path.exists(jsonp):
        print(f"voice not found: {voice} (looked at {onnx})", file=sys.stderr)
        return 2

    v = PiperVoice.load(onnx, jsonp)
    chunks = list(v.synthesize(text))
    if not chunks:
        print("piper returned no audio chunks", file=sys.stderr)
        return 4

    with wave.open(out_path, "wb") as w:
        # All chunks from one voice share the same sample_rate/width/channels.
        c0 = chunks[0]
        w.setnchannels(c0.sample_channels)
        w.setsampwidth(c0.sample_width)
        w.setframerate(c0.sample_rate)
        for c in chunks:
            # Float in [-1, 1] → int16 PCM. Piper already normalizes.
            pcm = (c.audio_float_array * 32767.0).clip(-32768, 32767).astype(np.int16)
            w.writeframes(pcm.tobytes())
    return 0


def main() -> int:
    if len(sys.argv) >= 2 and sys.argv[1] == "--self-test":
        return self_test()

    # Two positional args: input text file, output wav path.
    if len(sys.argv) < 3:
        print("usage: tts.py <input.txt> <output.wav> | --self-test", file=sys.stderr)
        return 64

    in_path = sys.argv[1]
    out_path = sys.argv[2]
    with open(in_path, "r", encoding="utf-8") as f:
        text = f.read()
    if not text.strip():
        print("input text is empty", file=sys.stderr)
        return 65
    return synthesize(text, out_path)


if __name__ == "__main__":
    sys.exit(main())
