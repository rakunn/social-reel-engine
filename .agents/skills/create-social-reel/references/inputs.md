# Inputs and project intake

## Required intake facts

Collect or discover what is available without forcing the user to repeat facts already supplied:

- project/reel identity and desired title;
- local paths for MP4/MOV clips and optional music, SRT/Remotion Caption JSON, LUTs, fonts, and brand assets;
- camera model plus recorded gamma and gamut for every clip or homogeneous clip group;
- intended technical LUT and its declared input/output color spaces;
- whether a LUT is technical, creative, or a combined normalization-and-look transform;
- desired mood, hook, title/CTA, caption language, music and camera-audio intent, and any required/forbidden shots;
- which shots may be stabilized and whether an unstabilized fallback is acceptable;
- usage-rights confirmation, supplied only by the user.

Do not block initial ingest merely because creative direction is incomplete. Do block color grading and final export when technical profile facts are incomplete.

Every runtime `projects/<reel-name>` job is local-only and ignored by Git, including its metadata and reports. Never use `git add -f` to override that boundary. Put reusable defaults and scaffold changes in `templates/reel/`, not in a live job.

## Typed ingest commands

```text
npm run reel -- new <name> --title "<title>"
npm run reel -- ingest <name> <clip-paths...> --kind clips
npm run reel -- ingest <name> <music-path> --kind music
npm run reel -- ingest <name> <caption-path> --kind captions
npm run reel -- ingest <name> <lut-paths...> --kind technical-lut
npm run reel -- ingest <name> <lut-paths...> --kind creative-lut
npm run reel -- ingest <name> <font-paths...> --kind fonts
npm run reel -- ingest <name> <brand-paths...> --kind brand
```

Use `--list-library` to inspect catalog declarations and `--library <id...>` to install verified catalog LUTs. Ingest performs immutable basename-preserving copies and checksum verification. A same-name file with different bytes is a conflict, not an overwrite opportunity.

## Configuration records

After ingest, run `analyze`. Write each explicit camera/profile confirmation into `config/sources.json`, keyed by the source's project-relative path, then rerun `analyze`. Do not edit generated checksums in `analysis/sources.json`.

Declare every selected LUT in `config/luts.json` with its project-relative file, checksum, kind, profile ID where applicable, canonical `inputGamma` and `inputGamut`, descriptive input/output spaces, transform semantics, and default mix. A technical or combined LUT's canonical gamma and gamut must exactly match the corresponding confirmed source fields. Technical transforms use full strength. Creative mix is chosen in the edit, per shot.

Only one music file is accepted for deterministic beat analysis. Verify whether SRT timestamps are already reel-relative; do not assume source-relative captions will remain synchronized after editing.

## Rights

`brief.json` contains one aggregate `rightsConfirmed` gate. Explain that it covers all used footage, music, captions, LUTs, fonts, brand assets, and other supplied material. Never infer ownership. After the user explicitly confirms the exact current used asset set, persist their decision as `rightsConfirmed: true`; this records the user's statement rather than asserting rights on their behalf. Before using a newly introduced asset, set the gate to `false` and restore it only after the user explicitly confirms the expanded set.
