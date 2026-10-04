# Prototype evidence and release checks

Measured on 4 October 2026. Sales, prices, people, attestations and labels are fictional. These checks demonstrate software behavior on synthetic evidence, not field accuracy, fair prices or farmer income effects.

## Reproduction and current checks

`npm run assets:prepare` produced genuine pinned q8 embeddings and ran CPU PyTorch training. `npm run evaluate`, `npx tsx scripts/verify-publication.ts`, `npm run release:package` and `npm run build` completed successfully. `npm test` passed 39 domain/API/publication tests; `.venv/Scripts/python.exe -m unittest discover -s training -p test_policies.py` passed three training-policy tests. A standard `npm ci --dry-run --ignore-scripts --audit=false` resolved the lockfile. The final patched dependency installation reported zero npm advisories.

Preprocessing is **evidence-text-v4** and publication policy is **synthetic-coffee-v2-rounding-cap**. Both Node and the browser use the shared preparation recipe. It removes labeled prices, charges and loan repayments, including signed amounts without a currency, while preserving quantities and measured characteristics. Money tests independently check:

- TZS 300,000 crop consideration, zero charges, 50 kg and a separate confirmed TZS 60,000 loan produce **6,000 TZS/kg** and **240,000 TZS cash**.
- A per-kg quote is not divided by weight again. Zero known charges permit comparison without quantity; total prices or allocated charges require confirmed weight.
- Unconfirmed optional loan/weight observations cannot create a confirmed cash total. Conflicting charges, source-unit quantities and negative financial values require correction.
- Synthetic INR/USD=80 and KES/USD=130 convert INR 100/kg to **KES 162.50/kg**. Missing/stale FX refuses conversion; same-currency arithmetic needs no rate.
- Duplicated lots and self-reviews earn no reputation credit. Invalid reviews take precedence at an identical latest timestamp.
- Contributor shares remain at or below 25% after histogram rounding and normalization. An adversarial rounding case requires an adjacent-bin merge; both Python and TypeScript enforce it.

## Training provenance and deployment decision

The generator produces **176 records**: 144 normal sales from 48 contributors with three lots each, plus 32 stress cases. Normal splits are 96 training/32 contributors, 24 development/8 contributors and 24 held-out/8 contributors. Splits precede relation generation. Hidden factors and the declared price equation are private simulation truth, not farmer requirements or direct model inputs.

There are **416 derived triplets**, marked `synthetic_unreviewed`, and no reviewed equivalence pairs. CPU training uses Adam at 0.03, seed 20261004, bounded diagonal scales [0.5, 2], and four margin/regularization candidates. The retained experimental checkpoint used margin 0.2, regularization 0.01 and 100 epochs. Candidate bytes and loss history are preserved in `artifacts/synthetic`, outside the served web directory.

**Deployment uses baseline-adapter-702cc37cfd91cac6 (identity scales).** Independently reviewed training labels, development precision@5 sets, matched-coverage critical cases, and equivalence/negation cases are missing. All four declared acceptance gates therefore fail closed. No triplet improvement can override them. Development triplet accuracy was 63/66 for both baseline and candidate; held-out accuracy was 51/65 baseline versus 54/65 candidate. These are diagnostic simulation results, not independent agricultural validation.

Weighted KMeans selected four groups from candidates 2, 4 and 8 using development approximation. The publication includes 100 qualified training-source lots: 96 normal sales plus four valid stress sales. Private recurring phrase candidates are preserved; no unreviewed topic captions are published.

## Final aggregate approximation

The independent TypeScript evaluator builds the final publisher distributions and compares their mixture CDF medians against a private contributor-bounded reference. Held-out results were not used to retune model, group or grid choices.

| Metric | Development | Held-out |
|---|---:|---:|
| Supported queries | 24/24 | 24/24 |
| Median absolute reference error | 40.15 TZS/kg | 29.80 TZS/kg |
| 90th percentile absolute error | 42.00 TZS/kg | 35.16 TZS/kg |
| Maximum absolute error | 42.30 TZS/kg | 35.72 TZS/kg |

The largest final represented contributor share across published groups was **15.93%**. These small approximation errors measure agreement with a synthetic private comparator; they do not measure error against a real market price.

`verify-publication.ts` measured actual negotiated gzip response bodies: pack JSON 1,322 bytes, identity adapter 35 bytes and float32 prototypes 5,688 bytes, totaling **7,045 transmitted body bytes** versus **20,935 decoded bytes**. Manifest, headers and HTTP framing are excluded. Hash verification after decoding passed. The evaluation variant including its manifest was 21,869 decoded bytes; version metadata explains the size difference.

## Multilingual evaluation

Seventy descriptions ran through actual Node q8 inference in about 3.25 seconds for the warmed evaluation loop. This excludes model installation, cold initialization and browser rendering. Precision@5 is measured before context guards against declared synthetic relevance; support and guard effects are separate outputs.

| Language / partition | Cases | Supported | Semantic precision@5 | Keyword precision@5 |
|---|---:|---:|---:|---:|
| English development | 12 | 12/12 | 0.333 | 0.317 |
| English held-out | 20 | 20/20 | 0.300 | 0.200 |
| French development | 12 | 12/12 | 0.183 | 0.233 |
| French held-out | 20 | 20/20 | 0.410 | 0.220 |
| Kiswahili development | 3 | 1/3 | Unlabeled | Unlabeled |
| Kiswahili held-out | 3 | 0/3 | Unlabeled | Unlabeled |

French development retrieval was worse than the keyword baseline. Of three intended Kiswahili comparisons, one development case was supported and both held-out cases abstained. The other three intended clarification/refusal cases produced no reference. No independent fluent agricultural reviewer checked the wording or labels. Do not claim general Kiswahili price accuracy or universally better semantic retrieval.

Raw metrics, denominators, hashes and case failures are in `generated/evaluation-report.json`, `generated/final-pack-verification.json` and `artifacts/synthetic/training-report.json`.

## Browser and installation evidence

The final `npm run test:browser` run exited **0**, with **two tests passed in 38.3 seconds**. Chromium 145.0.7632.6 ran on Windows at 1280×1000 and 390×844. Screenshots were inspected for desktop/mobile readability and clipping. No external requests or page errors occurred; one console resource error was the deliberately aborted update request.

The suite verified network-disabled reload and genuinely new q8 inference in English/French/Kiswahili; known incompatible processing refusal; unchanged references after offer edits; corrected/blank weight and cash calculations; separate personal records; clearing an old receipt when starting a new sale; offline receipt persistence, upload and protected image inspection; anonymous unknown comparison annotation; approval, publication, Farmer B download and new offline inference with the updated pack. Incompatible preprocessing, corrupt hashes and interrupted updates preserved the prior active version.

The same unseen text produced 384-dimensional Node/browser vectors with L2 difference **1.65×10⁻⁷** and cosine **0.9999999999999862**, passing predeclared tolerances. Browser worker inference measured **63.8 ms**, excluding model initialization. Elapsed UI timings were installation **9.00 s**, first English comparison after offline reload **2.05 s**, French **0.44 s**, and Kiswahili **0.43 s**. These are local desktop measurements, not physical-phone or weak-network measurements. This browser Kiswahili example supported comparison; it does not override the unsupported held-out language cases above.

Evidence is saved in `output/browser/browser-evidence.json`, the HTML report and screenshots. The managed Windows test server wrapper stalled during teardown; rerunning against a separately started persistent server completed normally. Application assertions passed with exit 0.

The pinned registry contains **118,308,185 bytes of q8 weights** and **169,075,122 decoded bytes (161.24 MiB)** of model/tokenizer/runtime assets. Application shell and comparison pack are additional. A small recurring pack does not remove the substantial first-installation or device-storage burden.

`npx tsx scripts/measure-runtime.ts` streamed and hash-checked the final served shell/model/runtime and current demo pack. First-use bodies total approximately **90.71 MB transferred / 169.61 MB decoded**, including the current pack. The shell is about **158 KB transferred**, and pack **coffee-2026-10-04-v4-3e886ac9** is **8,015 transferred bytes including its manifest**. Totals exclude HTTP headers/framing and repeated requests; both `/` and `/index.html` count because the service worker caches both URLs. This updated demo pack includes browser contributions; the frozen 100-source evaluation pack above remains a separate reproducible measurement. Details are in `output/runtime-footprint.json`.

The Windows Node service measured **425,934,848 bytes current working set** and **571,670,528 bytes peak working set** after publication and transfer checks. This is not a Linux hosting benchmark. Publication memory must be checked on the chosen host before claiming that the free-tier blueprint works there.

## Boundaries and release handoff

OCR, speech, visual grading and regression are omitted. Physical phone measurements, real market validity, production identities/custody and livelihood effects are unmeasured. Aggregates and parameters provide disclosure controls, not formal anonymity. Demo storage is resettable; browser storage can be evicted.

The model/tokenizer/runtime revision and asset hashes are pinned. Multer, Vite and Vitest were updated to patched versions; a Sharp 0.35.4 override patches the unused image-decoding dependency while preserving Transformers.js 3.8.1 and actual text-encoder outputs. This follows the upstream [Sharp advisory](https://github.com/advisories/GHSA-rgj7-g3m4-5g8c) and [Vitest advisory](https://github.com/advisories/GHSA-82fw-gwwq-j7x9).

See `DEMO.md` for the farmer/publisher sequence and `training/README.md` for model revision. No external hosted URL, GitHub remote, physical-phone result or completed video is claimed.
