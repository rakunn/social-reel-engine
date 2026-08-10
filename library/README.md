# Local LUT library

The supplied `.cube` files and PDF guide are copied here for local reuse and excluded from Git. `lut-catalog.json` is the tracked source of truth for checksums and declared semantics.

Technical transforms are never selected by filename alone during a reel job. The source camera gamma/gamut and the matching catalog profile must be explicitly confirmed in that project's `config/sources.json` and `config/luts.json`. Technical catalog entries keep gamma and gamut as separate canonical fields so contradictory source facts cannot pass on profile ID alone.

The Szatrasie guide describes its LUTs as creative looks applied after correction/normalization. It recommends tuning each shot rather than leaving a look at 100%, generally within 20–80%. It does not prescribe a particular look for a particular scene, so the reel workflow generates comparison stills and pauses for a human choice.

`HDR CONVERSION LUT.cube` remains unclassified because its input color space, output color space, and transform semantics are not declared. The engine must not use it until those details are confirmed.
