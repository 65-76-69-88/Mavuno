# Coffee sale companion

A working-name **PriceMesh** agriculture prototype for the World Bank Small AI challenge. A farmer describes available coffee-sale evidence, confirms the money and market context, compares the offer with a learned aggregate reference, and records the completed sale. Prices, people, review attestations and Ondera-Demo are fictional.

## Run the prototype

Use Node 22.13 or newer. From this directory:

```sh
npm ci
npm run assets:fetch
npm run build
```

Copy `.env.example` to `.env` and set a private `REVIEWER_SECRET` for the fictional publisher workspace. Then:

```sh
npm start
```

Open `http://127.0.0.1:3001`. The service seeds the deterministic private corpus and publishes its initial aggregate pack. Packaged synthetic server artifacts allow startup without Python. Model assets are downloaded separately and never committed.

Select **Install offline assets** while connected. Wait for asset hashes, the pack and an actual encoder inference to validate. Disable the browser network, reload, enter a new description and compare. `npm run dev` provides the Vite/Express development servers; offline installation uses the production build.

## What is implemented

- React/TypeScript responsive farmer and protected publisher workflows, English/French/Kiswahili text, compact confirmation and two isolated fictional personas.
- Genuine local q8 multilingual E5 inference in a browser worker. Remote model loading is disabled. The shell, worker, model, tokenizer and WASM runtime are cached locally.
- An actual CPU PyTorch experiment learns 384 bounded diagonal scales. Weighted KMeans discovers groups from training transaction embeddings. Price values are excluded from semantic input.
- Decimal money arithmetic, dated synthetic FX, unknown-charge clarification, and separate crop consideration and loan settlement. A per-kg quote with zero known charges can compare without a lot weight.
- Contributor-bounded private price references and public coarse histogram mixtures. Quantiles come from the mixture CDF; group medians are never averaged.
- Local personal records/outbox, idempotent upload, report-scoped tokens, private PNG/JPEG evidence, protected review/correction, publication and atomic pack updates. Approval and inclusion are distinct states.
- Pack/model/preprocessing compatibility, SHA-256 checks, expiry and previous-pack preservation on failed updates.

The UI accepts evidence images. **OCR, speech transcription and visual grading are not implemented.** Attaching an image does not establish quality or verify a sale. Regression is optional work and is not included.

## Reproduce training and evaluation

The synthetic source generator is `fixtures/synthetic/corpus.ts`. It produces 176 records: 144 normal sales and 32 stress cases. Normal records use 48 contributors with three lots each; contributors and narrative template families are split into 96 training, 24 development and 24 held-out records before labels are derived. Publication uses only qualified training records and compatible newly reviewed contributions.

Create an isolated Python environment and install CPU dependencies:

```sh
uv venv .venv
uv pip install --python .venv/Scripts/python.exe numpy==2.2.6 scikit-learn==1.7.2
uv pip install --python .venv/Scripts/python.exe torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
npm run assets:prepare
npm run evaluate
npm run release:package
```

On Linux/macOS use `.venv/bin/python`; set `TRAINING_PYTHON` to that path for `assets:prepare`. The trainer uses cached outputs of the same q8 encoder as the browser. Python is a development dependency; the deployed comparison and publisher use Node and browser inference.

Generated label, split, cache and training manifests record actual hashes, configuration, checkpoint decisions, losses and failures. Labels are derived from declared generator rules and have `synthetic_unreviewed` status. **No independent agricultural reviewer supplied these comparison labels.** The experiment demonstrates optimization and group discovery, not validated field semantics.

The deployed scales are identity: the unchanged encoder remains active because independently reviewed relevance, critical-error and equivalence/negation evidence is missing. The actual learned candidate is preserved in `candidate-adapter.f32` with its optimization history and rejection reasons. Triplet accuracy alone cannot authorize deployment. The independent evaluation reports synthetic relevant-neighbor precision and language failures in `generated/evaluation-report.json`; measured results and reproduction steps are in [EVIDENCE.md](EVIDENCE.md).

## Verify

```sh
npm run typecheck
npm test
npm run test:browser
```

The browser suite uses an installed Chromium if available; otherwise run `npx playwright install chromium`. It tests actual offline reload/new inference, offer-price invariance, incompatible-form refusal, separate persona records and the upload/review/publication/update loop. Domain/API tests cover money, FX, influence, suppression, CDF arithmetic, idempotence and private routes.

In the managed Windows environment, start the application separately before running the browser suite. The tests reuse the running server, avoiding a test-runner wrapper cleanup stall. `npx tsx scripts/measure-runtime.ts` verifies streamed hashes and measures actual compressed shell/model/pack response bodies from the running service.

## Architecture and boundaries

`apps/web` owns the interaction, worker, IndexedDB and service worker. `apps/server` owns SQLite, report/evidence access and publication. `packages/domain` owns evidence/money contracts and exact math. `packages/pack` builds immutable public artifacts. `training` and `tests/evaluation` reproduce learning and measure the private-to-public approximation. A compatibility adapter retains nullable `SaleFacts` for local correction; optional quality fields do not gate embedding or become a fixed comparison taxonomy.

Public downloads contain learned centroids, adapter scales, rounded distributions, broad count bands and limited topic summaries. They contain no source rows, individual vectors, contributor identities, attachments or individual prices. The fictional source/cache artifacts under `artifacts/synthetic` are server inputs outside the served static directory. Never move them into `apps/web/public` or `dist/web`.

Grouping, suppression and rounding reduce disclosure; they do not establish anonymity, differential privacy or resistance to collusion. Demo personas are not production authentication. Use fictional records only. SQLite/evidence files are resettable on ephemeral hosting; personal records persist only while browser storage remains available. Phone performance, local agricultural language review, farmer outcomes and real-market price validity are unmeasured.

Kiswahili is a named live interaction with provisional wording and meaningful clarification/refusal. The frozen Kiswahili evaluation includes unsupported intended comparisons. Language support in the base model does not prove crop-specific language accuracy.

## Deployment and submission

`render.yaml` prepares a one-origin Node service with separate model fetching and selects a free tier. Configure the private reviewer secret through the host environment. The measured Windows service peaked at about 545 MiB after publication and transfer validation; Linux hosting memory is unverified. Check memory, HTTPS, offline origin/assets, source exclusions and restart behavior on the chosen host before making a hosting claim.

This implementation does not create a GitHub remote, deploy to an external account, record team videos or submit to the portal. The release checklist in `../project_description/07-implementation-plan.md` remains authoritative for those deliverables and the actual cutoff/timezone.

Use [DEMO.md](DEMO.md) for the farmer and publisher demonstration sequence.

The local release passed 39 domain/API/publication tests, three CPU training-policy tests and two browser tests. It performed new inference after offline reload and the complete contribution/review/publication/download loop. The reviewed semantic adapter gates remain unmet, so the deployment uses the baseline encoder with learned groups.

## Sources and licenses

Challenge context: supplied `WorldBankChallenge.pdf`, pages 5–11 and 16–17; the PDF is not redistributed here. Base model: [intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small), MIT; [Xenova ONNX conversion](https://huggingface.co/Xenova/multilingual-e5-small/tree/761b726dd34fb83930e26aab4e9ac3899aa1fa78), pinned immutable revision. [Transformers.js local configuration](https://huggingface.co/docs/transformers.js/custom_usage) supports local model and WASM paths. [Render free-service documentation](https://render.com/docs/free) describes reset and idle limitations.

Code: MIT. Team-generated fictional fixture records and source descriptions: CC0-1.0. Derived model/cache artifacts retain their upstream model obligations; see their manifest and the runtime asset registry. Dependency licenses remain with their respective authors.
