# No-skill baseline

Five fresh-context, read-only agents answered the original cases in `cases.json` without opening a repository-scoped reel skill. They were allowed to inspect the engine so the comparison measures orchestration policy rather than command memorization. The later regression cases and three rights-binding variants were run against the pre-fix skill because they target contradictions introduced by its autonomous interaction contract.

| Case | Baseline strengths | Baseline gaps or variance to remove with the skill |
| --- | --- | --- |
| DJI start-to-finish | Found the command surface, checksum ingest, two approvals, explicit DJI profile, and final formats. | Treated editorial policy as unspecified; did not define a consistent Codex pause protocol or a required presentation format for previews/stills. |
| Mixed DJI/Sony | Correctly separated S-Gamut3 and S-Gamut3.Cine, rejected the ambiguous HDR LUT, and avoided double normalization. | Proposed a manual generic color workflow instead of the repository's exact commands, artifacts, approval records, and status flow. |
| Creative LUT selection | Correctly refused filename-only selection, used normalized comparison frames, and interpreted the PDF's intensity ranges cautiously. | Tentatively ranked looks from names despite having no visual evidence; no reproducible engine workflow for installing and comparing candidates. |
| Music/captions/stabilization | Covered ingest, beat analysis, SRT timing, user-held approvals, and a stabilization review. | Invented an extra mandatory pause after grading, and exposed engine-policy weaknesses instead of following one stable documented policy. |
| Stale approvals and QC | Correctly explained edit/color hash invalidation and the required rerender sequence. | Found that existing final files were not provably tied to current manifests and that status could call a stale delivery rendered. This became a required engine repair before forward testing. |
| Explicit rights persistence | Recognized that the user's intake statement was explicit confirmation. | Had to override the literal “Do not mark `rightsConfirmed` true” rule to persist it; following the rule would leave final export permanently blocked because no rights CLI command exists. |
| Resumed rights binding | Correctly left confirmation current for a newly ingested but unused file and blocked a known changed used clip. | A bare Boolean could not prove an ambiguous resumed set was unchanged, so the agent had to ask again; for a known change it could only edit the Boolean manually and explicitly found no checksum-persisting command. |
| Proxy-only incomplete intake | Correctly kept the rough watermarked, deferred grading, and requested the missing technical facts with rough review. | The necessary fact request and normalized-preview reapproval contradicted the contract's unconditional claim that no post-intake stops existed beyond the two artifact gates. |

The baseline demonstrates good safety instincts but inconsistent execution. The skill must make the normal ready path, the exceptional proxy-only path, explicit rights persistence, exact command order, technical-transform refusal, LUT comparison policy, approval ownership, and output-freshness checks deterministic across all eight wordings.

## Active-media monitoring and recovery baseline

A fresh-context agent was given a live `analysis/operation.json` proxy record under an ETA deadline and explicitly told not to read the reel skill or repository source. It correctly rejected concurrent `analyze` and `proxy`, and it chose one `status` check. Its recovery advice nevertheless said to “inspect the recorded failure/log state and existing completed outputs” and to restart only through a “known resumable, non-destructive recovery path—not a concurrent or blind fresh proxy invocation.”

That is too ambiguous for the engine contract introduced in Phase 1: a failed/stale operation record already names the exact safe retry command, and interrupted media must not be manually trusted as reusable cache inputs. The forward guidance must say that a recorded active job permits `status` because it returns before checksum scanning, but all other producers remain disallowed; after interruption, use `status` and rerun the exact recorded command so atomic output handling replaces incomplete work safely.

## Subject-preservation regression baseline

The first production run of the Coron/Ngey Ngey reel exposed a crop failure that the pre-update guidance did not prevent: the boat in the second selected shot drifted toward the edge of the 9:16 crop, and the third selected shot did not establish the visible group of three huts as the composition's subject. The existing wording to review the moving image and avoid blind center-crops was too soft to encode subject identity, required count, safe margin, or a default “establish-and-hold” policy. The regression case `subject-preserving-composition` makes those requirements explicit.
