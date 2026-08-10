#!/usr/bin/env python3
"""Analyze supplied music without downloading or transcribing anything."""

from __future__ import annotations

import argparse
import json

import librosa
import numpy as np


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    args = parser.parse_args()

    samples, sample_rate = librosa.load(args.audio, sr=None, mono=True)
    duration = float(librosa.get_duration(y=samples, sr=sample_rate))
    onset_envelope = librosa.onset.onset_strength(y=samples, sr=sample_rate)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_envelope,
        sr=sample_rate,
        units="frames",
    )
    onset_frames = librosa.onset.onset_detect(
        onset_envelope=onset_envelope,
        sr=sample_rate,
        units="frames",
        backtrack=False,
    )
    tempo_value = float(np.asarray(tempo).reshape(-1)[0]) if np.asarray(tempo).size else 0.0
    result = {
        "durationSeconds": duration,
        "sampleRate": int(sample_rate),
        "tempoBpm": tempo_value,
        "beatsSeconds": [
            float(value)
            for value in librosa.frames_to_time(beat_frames, sr=sample_rate).tolist()
        ],
        "onsetsSeconds": [
            float(value)
            for value in librosa.frames_to_time(onset_frames, sr=sample_rate).tolist()
        ],
    }
    print(json.dumps(result, separators=(",", ":")))


if __name__ == "__main__":
    main()
