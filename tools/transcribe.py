#!/usr/bin/env python3
"""Offline CVR transcription — runs entirely on the analyst's machine,
no cloud services (mandatory for defence data).

Uses faster-whisper (CTranslate2 port of OpenAI Whisper). The large-v3
model handles Hindi + English code-switching, which matches the actual
CVR audio; degraded/noisy recordings benefit from the built-in VAD filter.

Setup (one-time, needs internet to fetch the model; afterwards fully offline):
    pip install faster-whisper
    # first run downloads the model to ~/.cache/huggingface — copy that
    # directory to air-gapped machines to run without internet

Usage:
    python3 transcribe.py cockpit.wav                 # auto-detect language
    python3 transcribe.py cockpit.wav --language hi   # force Hindi
    python3 transcribe.py cockpit.wav --model medium  # smaller/faster model

Emits cockpit.srt and cockpit.json next to the input file — either imports
directly into TACT-FDR via the CVR panel's "Transcript…" button.
"""

import argparse
import json
import sys
from pathlib import Path


def fmt_srt_ts(sec: float) -> str:
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def main() -> None:
    ap = argparse.ArgumentParser(description="Offline CVR transcription (faster-whisper)")
    ap.add_argument("audio", help="CVR audio file (wav/mp3/m4a/…)")
    ap.add_argument("--model", default="large-v3",
                    help="Whisper model: tiny/base/small/medium/large-v3 (default large-v3)")
    ap.add_argument("--language", default=None,
                    help="Force language code, e.g. 'hi' for Hindi (default: auto-detect)")
    ap.add_argument("--device", default="auto", help="cpu / cuda / auto")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit("faster-whisper not installed — run: pip install faster-whisper")

    audio_path = Path(args.audio)
    if not audio_path.exists():
        sys.exit(f"No such file: {audio_path}")

    print(f"Loading model {args.model} ({args.device}) …")
    model = WhisperModel(args.model, device=args.device, compute_type="auto")

    print(f"Transcribing {audio_path.name} …")
    seg_iter, info = model.transcribe(
        str(audio_path),
        language=args.language,
        vad_filter=True,               # skip long silence — CVR audio is sparse
        condition_on_previous_text=False,  # noisy audio: avoid hallucination carry-over
    )
    print(f"Detected language: {info.language} (p={info.language_probability:.2f})")

    segments = []
    for seg in seg_iter:
        text = seg.text.strip()
        if not text:
            continue
        segments.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": text})
        print(f"  [{fmt_srt_ts(seg.start)}] {text}")

    srt_path = audio_path.with_suffix(".srt")
    with open(srt_path, "w", encoding="utf-8") as f:
        for i, s in enumerate(segments, 1):
            f.write(f"{i}\n{fmt_srt_ts(s['start'])} --> {fmt_srt_ts(s['end'])}\n{s['text']}\n\n")

    json_path = audio_path.with_suffix(".json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(segments, f, ensure_ascii=False, indent=1)

    print(f"\nWrote {srt_path.name} and {json_path.name} — import either via TACT-FDR's CVR panel.")


if __name__ == "__main__":
    main()
