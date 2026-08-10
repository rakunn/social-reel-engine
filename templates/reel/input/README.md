# Reel inputs

Copy original media into the matching folder. Inputs are treated as immutable. The entire runtime project created from this template is local-only and excluded from Git.

- `clips/`: MP4 or MOV camera originals
- `music/`: supplied licensed music
- `captions/`: supplied SRT or Remotion Caption JSON
- `luts/technical/`: exact camera/profile normalization LUTs
- `luts/creative/`: creative or combined look LUTs
- `fonts/` and `brand/`: supplied, licensed supporting assets

Record camera/profile confirmation in `config/sources.json` and LUT semantics in `config/luts.json`. The engine never guesses a technical transform.
