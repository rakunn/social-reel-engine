# Local LUT library

LUT `.cube` files and the PDF guide must be supplied by the user. They are excluded from Git. `lut-catalog.json` describes optional local files and their checksums/semantics; a catalog entry does not mean the file is installed. A fresh checkout with no LUT binaries is expected.

For a new job, the workflow first checks supplied/project inputs and verified local catalog files. It asks for a missing required normalizer in the consolidated intake, copies the supplied file through `ingest --kind technical-lut` into `projects/<name>/input/luts/technical/`, and records verified metadata in `config/luts.json`. Creative LUTs are optional and use `--kind creative-lut`. When a LUT is already supplied but unclassified, request only missing transform facts. Never infer them from filenames. The original files remain unchanged.

For local reuse, an exact catalog-matching file may be placed at its declared `library/` path. The workflow verifies its checksum before installation into a job. Other user-supplied transforms can be declared directly in that job without modifying the shared catalog. Rights still require explicit user confirmation for the assets used.

Technical transforms are never selected by filename alone during a reel job. The source camera gamma/gamut and the matching catalog profile must be explicitly confirmed in that project's `config/sources.json` and `config/luts.json`. Technical catalog entries keep gamma and gamut as separate canonical fields so contradictory source facts cannot pass on profile ID alone.

The Szatrasie guide describes its LUTs as creative looks applied after correction/normalization. It recommends tuning each shot rather than leaving a look at 100%, generally within 20–80%. It does not prescribe a particular look for a particular scene, so the reel workflow generates comparison stills and pauses for a human choice.

`HDR CONVERSION LUT.cube` remains unclassified because its input color space, output color space, and transform semantics are not declared. The engine must not use it until those details are confirmed.

## Reusable travel styles and fonts

`font-catalog.json` and `style-catalog.json` are the tracked source of truth for the Philippines travel typography library. Font downloads use immutable Google Fonts URLs pinned to one upstream commit, bounded response sizes, exact SHA-256 checksums, and OFL-1.1 license metadata. Verified binaries are cached locally in ignored `library/fonts/`; they are not committed.

```bash
npm run reel -- style --list
npm run reel -- style <name> --apply philippines-island-editorial
npm run reel -- analyze <name>
```

The initial presets are `philippines-island-editorial`, `philippines-field-notes`, and `philippines-postcard`. A preset controls typography, palette, spacing, scrim, shadow, and fade tokens only. It never modifies a clip's exposure, white balance, tint, treatment, or LUT selection. Applying or changing typography is an editorial change reviewed through the existing rough-cut approval; the exact color approval remains reusable when all color-relevant inputs are unchanged. Selected fonts are included in the project's rights fingerprint. Noto Sans Tagalog is cataloged only for user-supplied or independently verified Tagalog-script text; the workflow does not invent or transliterate Baybayin.
