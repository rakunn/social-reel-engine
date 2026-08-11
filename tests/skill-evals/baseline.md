# No-skill baseline

Five fresh-context, read-only agents answered the original cases in `cases.json` without opening a repository-scoped reel skill. They were allowed to inspect the engine so the comparison measures orchestration policy rather than command memorization. The two later regression cases were run against the pre-fix skill because they target contradictions introduced by its autonomous interaction contract.

| Case | Baseline strengths | Baseline gaps or variance to remove with the skill |
| --- | --- | --- |
| DJI start-to-finish | Found the command surface, checksum ingest, two approvals, explicit DJI profile, and final formats. | Treated editorial policy as unspecified; did not define a consistent Codex pause protocol or a required presentation format for previews/stills. |
| Mixed DJI/Sony | Correctly separated S-Gamut3 and S-Gamut3.Cine, rejected the ambiguous HDR LUT, and avoided double normalization. | Proposed a manual generic color workflow instead of the repository's exact commands, artifacts, approval records, and status flow. |
| Creative LUT selection | Correctly refused filename-only selection, used normalized comparison frames, and interpreted the PDF's intensity ranges cautiously. | Tentatively ranked looks from names despite having no visual evidence; no reproducible engine workflow for installing and comparing candidates. |
| Music/captions/stabilization | Covered ingest, beat analysis, SRT timing, user-held approvals, and a stabilization review. | Invented an extra mandatory pause after grading, and exposed engine-policy weaknesses instead of following one stable documented policy. |
| Stale approvals and QC | Correctly explained edit/color hash invalidation and the required rerender sequence. | Found that existing final files were not provably tied to current manifests and that status could call a stale delivery rendered. This became a required engine repair before forward testing. |
| Explicit rights persistence | Recognized that the user's intake statement was explicit confirmation. | Had to override the literal “Do not mark `rightsConfirmed` true” rule to persist it; following the rule would leave final export permanently blocked because no rights CLI command exists. |
| Proxy-only incomplete intake | Correctly kept the rough watermarked, deferred grading, and requested the missing technical facts with rough review. | The necessary fact request and normalized-preview reapproval contradicted the contract's unconditional claim that no post-intake stops existed beyond the two artifact gates. |

The baseline demonstrates good safety instincts but inconsistent execution. The skill must make the normal ready path, the exceptional proxy-only path, explicit rights persistence, exact command order, technical-transform refusal, LUT comparison policy, approval ownership, and output-freshness checks deterministic across all seven wordings.
