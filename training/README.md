# Training and model revisions

Report review, aggregate publication and model retraining are separate operations. Approving a report can make it eligible for the next aggregate pack under the installed model. It does not train the encoder or adapter. The reviewer comparison panel records a private annotation queue; publication never starts Python.

The shipped experiment uses fictional sales and generator-derived, unreviewed comparison labels. Its trained candidate is retained in `candidate-adapter.f32`, but the deployed adapter remains the identity baseline because independently reviewed acceptance evidence is absent. KMeans groups and calibration still use the frozen synthetic development experiment. These results establish reproducibility, not agricultural accuracy.

## Export private reviewer inputs

From the codebase directory, with `DATA_DIR` pointing to the server's database:

```sh
npx tsx apps/server/src/export-training.ts generated/reviewer-training-input.json
```

The export includes consented, approved fictional reports and labels whose two reports are both eligible. A comparison has `left_report_id`, `right_report_id`, `label`, `rationale`, `reviewer_id` and `reviewed_at`. `unknown` labels are exported separately as clarification cases and must not become positive or negative training examples. This export is an input queue; no automatic conversion to reviewed training data is implemented. Keep exports and embedding caches outside browser assets.

## Freeze and review a new experiment

Freeze source IDs, contributor/lot/scenario/template families, train/dev/test assignments and the candidate relevance sets before training. Preserve the existing held-out families. Independently review comparability using descriptions with money and identities removed. Pair judgments alone do not establish a complete precision@5 denominator; review every candidate in each declared relevance set. Record the reviewer and rationale in the accompanying private provenance manifest.

The trainer accepts a private embedding-cache JSON with the existing `records`, version fields and normalized 384-dimensional encoder vectors. Additional reviewed annotations use these shapes (IDs are illustrative):

```json
{
  "independentReview": true,
  "acceptanceCoverage": 0.8,
  "triplets": [{
    "anchorId": "train-a", "positiveId": "train-b", "negativeId": "train-c",
    "split": "train", "reviewStatus": "reviewed", "independent": true
  }],
  "equivalences": [{
    "leftId": "train-a", "rightId": "train-translation",
    "split": "train", "reviewStatus": "reviewed", "independent": true
  }],
  "relevanceSets": [{
    "anchorId": "dev-a", "candidateIds": ["dev-b", "dev-c", "dev-d", "dev-e", "dev-f"],
    "relevantIds": ["dev-b", "dev-c"], "criticalNegativeIds": ["dev-f"],
    "split": "dev", "reviewStatus": "reviewed", "independent": true, "complete": true
  }],
  "semanticChecks": [{
    "kind": "negation", "anchorId": "dev-a", "positiveId": "dev-b", "negativeId": "dev-f",
    "split": "dev", "reviewStatus": "reviewed", "independent": true
  }]
}
```

Also include actual development triplets and reviewed `equivalence` semantic checks. Training triplets and equivalence pairs must stay within train; development semantic checks stay within dev. Development relevance references may use train/dev, never test. Declaring a flag does not supply independent review: retain its evidence in the private manifest.

Candidate acceptance requires all of: independently reviewed training labels; improved development precision@5 on complete reviewed relevance sets; no increase in critical false comparisons at the declared matched coverage before context guards; and no new failures on reviewed equivalence and negation cases. Missing denominators fail closed. Triplet accuracy is diagnostic. Held-out results are reported after selection without retuning.

## Rebuild, verify and activate

`npm run assets:prepare` regenerates the shipped synthetic cache and runs training; it overwrites that cache and its labels. For a reviewed experiment, prepare a separate frozen cache and run:

```sh
npm run train -- --cache generated/reviewed-embedding-cache.json --output-dir generated/reviewed-run
```

Inspect the training report, acceptance gates, baseline/candidate and held-out metrics, source/split/label hashes, and histogram contributor-cap audits. The post-rounding histogram audit can merge or suppress intervals/groups even when original contributor weights passed the cap. Keep the candidate checkpoint even when acceptance fails.

To activate a checked revision, install its matching cache, learned groups, report, split manifest and checkpoint in `generated/`, then run `npm run evaluate`, `npm run release:package`, `npm test` and `npm run build`. Repackaging refreshes the private synthetic server fallback; it does not publish individual records. Real datasets require a separate packaging policy—the demo release command accepts fictional data only.

Restart the server to activate the prepared revision. Startup compares the installed model/cache/policy fingerprint and rebuilds the aggregate pack while preserving report data. A failed rebuild preserves the last published pack. The reviewer Publish action rebuilds with the installed revision; its resulting immutable pack version and inclusion statuses can then be inspected.
