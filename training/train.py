"""Reproducible CPU-only metric experiment and aggregate group discovery.

The cached encoder vectors are the exact local q8 artifact used by the browser.
Synthetic rule labels exercise learning; they are not independent market review.
Run from codebase: .venv/Scripts/python training/train.py --cache generated/embedding-cache.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from collections import defaultdict
from datetime import date
from pathlib import Path

import numpy as np
import torch
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import TfidfVectorizer

SEED = 20261004
AS_OF = date(2026, 10, 4)


def adapt(embeddings: np.ndarray, scales: np.ndarray) -> np.ndarray:
    values = embeddings * scales
    return values / np.linalg.norm(values, axis=1, keepdims=True)


def capped_weights(base: np.ndarray, contributors: list[str], cap: float = .25) -> np.ndarray:
    totals: dict[str, float] = defaultdict(float)
    for weight, contributor in zip(base, contributors):
        totals[contributor] += float(weight)
    if len(totals) * cap < 1 - 1e-12:
        raise ValueError("Contributor cap is infeasible")
    remaining, allocated, available = dict(totals), {}, 1.
    while remaining:
        total = sum(remaining.values())
        capped = [key for key, value in remaining.items() if available * value / total > cap + 1e-12]
        if not capped:
            allocated.update({key: available * value / total for key, value in remaining.items()})
            break
        for key in capped:
            allocated[key] = cap
            del remaining[key]
            available -= cap
    return np.array([allocated[contributor] * weight / totals[contributor]
                     for weight, contributor in zip(base, contributors)])


def quantile(prices: np.ndarray, weights: np.ndarray, probability: float = .5) -> float:
    order = np.argsort(prices, kind="stable")
    cumulative = np.cumsum(weights[order]) / np.sum(weights)
    index = min(len(order) - 1, int(np.searchsorted(cumulative, probability - 1e-12)))
    return float(prices[order[index]])


def triplet_metrics(vectors: np.ndarray, triples: np.ndarray) -> dict:
    if len(triples) == 0:
        return {"count": 0, "accuracy": None, "meanDistanceGap": None}
    anchors, positives, negatives = vectors[triples[:, 0]], vectors[triples[:, 1]], vectors[triples[:, 2]]
    positive = np.sum((anchors - positives) ** 2, axis=1)
    negative = np.sum((anchors - negatives) ** 2, axis=1)
    known = defaultdict(lambda: {"positive": set(), "negative": set()})
    for anchor, pos, neg in triples:
        known[int(anchor)]["positive"].add(int(pos)); known[int(anchor)]["negative"].add(int(neg))
    precision, recall, precision5, recall5 = [], [], [], []
    for anchor, pairs in known.items():
        candidates = list(pairs["positive"] | pairs["negative"])
        ranked = sorted(candidates, key=lambda index: float(np.linalg.norm(vectors[anchor] - vectors[index])))
        selected = ranked[:3]
        hits = len(set(selected) & pairs["positive"])
        precision.append(hits / len(selected)); recall.append(hits / len(pairs["positive"]))
        selected5 = ranked[:5]; hits5 = len(set(selected5) & pairs["positive"])
        precision5.append(hits5 / len(selected5)); recall5.append(hits5 / len(pairs["positive"]))
    return {"count": int(len(triples)), "accuracy": float(np.mean(positive < negative)),
            "meanDistanceGap": float(np.mean(negative - positive)), "uniqueAnchors": len(known),
            "precisionAt3AmongLabeledCandidates": float(np.mean(precision)),
            "recallAt3AmongLabeledCandidates": float(np.mean(recall)),
            "precisionAt5AmongLabeledCandidates": float(np.mean(precision5)),
            "recallAt5AmongLabeledCandidates": float(np.mean(recall5)),
            "relevanceStatus": "Diagnostic restricted candidate sets derived from triplets; not a complete reviewed relevance evaluation"}


def independently_reviewed(case: dict) -> bool:
    return case.get("reviewStatus") == "reviewed" and case.get("independent") is True


def reviewed_retrieval(vectors: np.ndarray, cases: list[dict], ids: dict[str, int]) -> dict:
    selected_cases = [case for case in cases if case.get("split") == "dev" and independently_reviewed(case)
                      and case.get("complete") is True]
    precisions, recalls = [], []
    for case in selected_cases:
        candidates = list(dict.fromkeys(case["candidateIds"]))
        relevant = set(case["relevantIds"])
        if len(candidates) < 5 or not relevant or not relevant.issubset(candidates):
            raise ValueError("Reviewed precision@5 needs at least five completely labeled candidates and relevant sources")
        anchor = vectors[ids[case["anchorId"]]]
        ranked = sorted(candidates, key=lambda key: (float(np.linalg.norm(anchor - vectors[ids[key]])), key))[:5]
        hits = len(set(ranked) & relevant)
        precisions.append(hits / 5); recalls.append(hits / len(relevant))
    return {"reviewedQueryCount": len(selected_cases), "precisionAt5": float(np.mean(precisions)) if precisions else None,
            "recallAt5": float(np.mean(recalls)) if recalls else None,
            "beforeContextGuards": True, "candidateSetStatus": "complete independently reviewed relevance sets"}


def matched_coverage_critical(vectors: np.ndarray, cases: list[dict], ids: dict[str, int], coverage: float) -> dict:
    edges = []
    for case in cases:
        if case.get("split") != "dev" or not independently_reviewed(case) or case.get("complete") is not True:
            continue
        critical = set(case.get("criticalNegativeIds", []))
        if not critical.issubset(set(case["candidateIds"]) - set(case["relevantIds"])):
            raise ValueError("Critical negatives must be explicitly reviewed non-relevant candidates")
        for candidate in dict.fromkeys(case["candidateIds"]):
            distance = float(np.linalg.norm(vectors[ids[case["anchorId"]]] - vectors[ids[candidate]]))
            edges.append((distance, case["anchorId"], candidate, candidate in critical))
    edges.sort()
    accepted_count = int(math.ceil(len(edges) * coverage))
    critical_count = sum(edge[3] for edge in edges)
    failures = sum(edge[3] for edge in edges[:accepted_count])
    return {"reviewedComparisons": len(edges), "criticalComparisons": critical_count, "acceptedComparisons": accepted_count,
            "coverage": accepted_count / len(edges) if edges else None, "targetCoverage": coverage,
            "criticalFalseComparisons": failures, "beforeContextGuards": True,
            "selection": "Fixed accepted count by semantic distance with deterministic ID tie-breaking"}


def reviewed_semantic_checks(vectors: np.ndarray, checks: list[dict], ids: dict[str, int]) -> dict:
    result = {}
    for kind in ("equivalence", "negation"):
        cases = [case for case in checks if case.get("split") == "dev" and case.get("kind") == kind and independently_reviewed(case)]
        failures = []
        for index, case in enumerate(cases):
            anchor, positive, negative = [vectors[ids[case[key]]] for key in ("anchorId", "positiveId", "negativeId")]
            if float(np.linalg.norm(anchor - positive)) >= float(np.linalg.norm(anchor - negative)):
                failures.append(index)
        result[kind] = {"reviewedCaseCount": len(cases), "failedCaseIndices": failures, "failureCount": len(failures)}
    return result


def acceptance_decision(cache: dict, ids: dict[str, int], baseline: np.ndarray, candidate: np.ndarray) -> dict:
    cases = cache.get("relevanceSets", []); checks = cache.get("semanticChecks", [])
    coverage = float(cache.get("acceptanceCoverage", .8))
    if not 0 < coverage <= 1: raise ValueError("Acceptance coverage must be declared in (0,1]")
    for case in cases:
        if case.get("split") != "dev": continue
        if cache["records"][ids[case["anchorId"]]]["split"] != "dev" or any(
                cache["records"][ids[key]]["split"] == "test" for key in case.get("candidateIds", [])):
            raise ValueError("Development relevance queries must be dev; references cannot include held-out test records")
    for case in checks:
        if case.get("split") == "dev" and any(cache["records"][ids[case[key]]]["split"] != "dev"
            for key in ("anchorId", "positiveId", "negativeId")):
            raise ValueError("Reviewed development semantic cases cross a frozen split")
    baseline_retrieval = reviewed_retrieval(baseline, cases, ids)
    candidate_retrieval = reviewed_retrieval(candidate, cases, ids)
    baseline_critical = matched_coverage_critical(baseline, cases, ids, coverage)
    candidate_critical = matched_coverage_critical(candidate, cases, ids, coverage)
    baseline_semantics = reviewed_semantic_checks(baseline, checks, ids)
    candidate_semantics = reviewed_semantic_checks(candidate, checks, ids)
    train_labels = [case for case in cache.get("triplets", []) if case.get("split") == "train"]
    review_supported = cache.get("independentReview") is True and bool(train_labels) and all(independently_reviewed(case) for case in train_labels)
    primary_improves = baseline_retrieval["reviewedQueryCount"] > 0 and candidate_retrieval["precisionAt5"] > baseline_retrieval["precisionAt5"] + 1e-12
    critical_supported = baseline_critical["criticalComparisons"] > 0 and baseline_critical["acceptedComparisons"] == candidate_critical["acceptedComparisons"]
    critical_preserved = critical_supported and candidate_critical["criticalFalseComparisons"] <= baseline_critical["criticalFalseComparisons"]
    semantic_supported = all(baseline_semantics[kind]["reviewedCaseCount"] > 0 for kind in ("equivalence", "negation"))
    no_new_semantic_failures = semantic_supported and all(set(candidate_semantics[kind]["failedCaseIndices"]).issubset(
        baseline_semantics[kind]["failedCaseIndices"]) for kind in ("equivalence", "negation"))
    gates = {"independentReviewedTrainingLabels": review_supported, "developmentPrecisionAt5Improves": primary_improves,
             "criticalFalseComparisonsDoNotIncreaseAtMatchedCoverage": critical_preserved,
             "noNewReviewedEquivalenceOrNegationFailures": no_new_semantic_failures}
    reasons = [key for key, passed in gates.items() if not passed]
    return {"accepted": all(gates.values()), "primaryMetric": "precision@5 on complete independently reviewed development relevance sets",
            "tripletAccuracyRole": "diagnostic only", "gates": gates, "failedGates": reasons,
            "baselineDevelopmentRetrieval": baseline_retrieval, "candidateDevelopmentRetrieval": candidate_retrieval,
            "baselineCriticalAtMatchedCoverage": baseline_critical, "candidateCriticalAtMatchedCoverage": candidate_critical,
            "baselineReviewedSemantics": baseline_semantics, "candidateReviewedSemantics": candidate_semantics}


def financial_info(item: dict) -> tuple[float, float] | None:
    record = item["record"]
    facts = record["facts"]
    value = lambda key: facts[key]["value"]
    if record["reviewState"] != "approved" or not record["consent"]["aggregateUse"]:
        return None
    if (value("cropId"), value("marketAreaId"), value("saleChannel")) != ("coffee", "ondera-demo", "farmgate"):
        return None
    # Declared initial reference context: contradictions never enter the same reference.
    if (value("species"), value("productForm"), value("deliveryTerms"), value("paymentTerms")) != (
            "arabica", "parchment", "buyer_collects", "immediate"):
        return None
    required = ["saleDate", "currency", "priceBasis", "saleCosts"]
    price_field = "quotedUnitPrice" if value("priceBasis") == "per_kg" else "cropConsideration"
    required += [price_field]
    if value("priceBasis") == "lot" or (value("saleCosts") is not None and float(value("saleCosts")) > 0):
        required += ["quantityKg"]
    if any(value(key) is None or facts[key]["status"] not in ("confirmed", "attested") for key in required):
        return None
    age = (AS_OF - date.fromisoformat(value("saleDate"))).days
    if not 0 <= age <= 90:
        return None
    quantity = None if value("quantityKg") is None else float(value("quantityKg"))
    if quantity is not None and quantity <= 0:
        return None
    charges = float(value("saleCosts"))
    if charges < 0:
        return None
    if quantity is not None and value("sourceQuantity") is not None and value("sourceUnit") in ("kg", "tonne", "lb"):
        factor = {"kg": 1, "tonne": 1000, "lb": .45359237}[value("sourceUnit")]
        if abs(float(value("sourceQuantity")) * factor - quantity) > 1e-9:
            return None
    amount = float(value(price_field))
    price = amount - (charges / quantity if quantity else 0) if value("priceBasis") == "per_kg" else (amount - charges) / quantity
    if value("currency") == "USD":
        price *= 2500  # Explicit dated synthetic corpus rate, not a live FX quote.
    elif value("currency") != "TZS":
        return None
    if not 0 < price <= 20000:
        return None
    completeness = sum(value(key) is not None for key in required) / len(required)
    confirmation = sum(facts[key]["status"] in ("confirmed", "attested") for key in required) / len(required)
    corroboration = {"seller_reported": 0, "receipt_attached": .25, "cooperative_attested": .75,
                     "independently_audited": 1}[record["verification"]]
    evidence = .5 * completeness + .3 * corroboration + .2 * confirmation
    return price, evidence * 2 ** (-age / 30)


def merge_histogram_intervals(left: dict, right: dict) -> dict:
    masses = defaultdict(float, left["contributorMasses"])
    for contributor, mass in right["contributorMasses"].items(): masses[contributor] += mass
    return {"start": left["start"], "end": right["end"], "mass": left["mass"] + right["mass"], "contributorMasses": dict(masses)}


def rounded_interval_masses(intervals: list[dict]) -> np.ndarray:
    masses = np.array([math.floor(interval["mass"] * 20 + .5) / 20 for interval in intervals])
    if masses.sum() <= 0: raise ValueError("Histogram has no represented mass after rounding")
    return masses / masses.sum()


def maximum_represented_share(intervals: list[dict], masses: np.ndarray) -> float:
    shares = defaultdict(float)
    for interval, rounded in zip(intervals, masses):
        if interval["mass"] <= 0: continue
        for contributor, original in interval["contributorMasses"].items():
            shares[contributor] += float(rounded) * original / interval["mass"]
    return max(shares.values(), default=0.)


def histogram(prices: np.ndarray, weights: np.ndarray, contributors: list[str]) -> tuple[list[dict], dict]:
    cells: dict[int, dict] = {}
    total = float(np.sum(weights))
    if total <= 0 or not np.all(np.isfinite(weights)) or np.any(weights < 0): raise ValueError("Invalid histogram source weights")
    original_shares = defaultdict(float)
    for price, weight, contributor in zip(prices, weights, contributors):
        if weight == 0: continue
        if not 0 <= price <= 20000: raise ValueError("Price falls outside the declared histogram grid")
        cell = min(79, int(price // 250))
        if cell not in cells:
            cells[cell] = {"start": cell, "end": cell + 1, "mass": 0., "contributorMasses": defaultdict(float)}
        normalized = float(weight) / total
        cells[cell]["mass"] += normalized
        cells[cell]["contributorMasses"][contributor] += normalized
        original_shares[contributor] += normalized
    original_maximum = max(original_shares.values(), default=0.)
    if original_maximum > .25 + 1e-10: raise ValueError("Original contributor influence exceeds the publication cap")
    merged, pending = [], None
    for cell in sorted(cells):
        current = cells[cell]
        pending = current if pending is None else merge_histogram_intervals(pending, current)
        if len(pending["contributorMasses"]) >= 3 and pending["mass"] >= .025:
            merged.append(pending)
            pending = None
    if pending is not None:
        if merged:
            merged[-1] = merge_histogram_intervals(merged[-1], pending)
        elif len(pending["contributorMasses"]) >= 3: merged.append(pending)
        else: raise ValueError("Histogram has insufficient contributor diversity")
    initial_count = len(merged)
    masses = rounded_interval_masses(merged)
    represented_maximum = maximum_represented_share(merged, masses)
    while represented_maximum > .25 + 1e-10 and len(merged) > 1:
        candidates = []
        for index in range(len(merged) - 1):
            replacement = merge_histogram_intervals(merged[index], merged[index + 1])
            intervals = merged[:index] + [replacement] + merged[index + 2:]
            rounded = rounded_interval_masses(intervals)
            maximum = maximum_represented_share(intervals, rounded)
            candidates.append((maximum, replacement["end"] - replacement["start"], index, intervals, rounded))
        represented_maximum, _, _, merged, masses = min(candidates, key=lambda candidate: candidate[:3])
    if represented_maximum > .25 + 1e-10: raise ValueError("Contributor cap fails after histogram rounding")
    audit = {"originalMaximumContributorShare": original_maximum, "representedMaximumContributorShare": represented_maximum,
             "initialIntervalCount": initial_count, "finalIntervalCount": len(merged), "roundingMerges": initial_count - len(merged)}
    return ([{"lower": item["start"] * 250, "upper": item["end"] * 250, "mass": float(mass)}
             for item, mass in zip(merged, masses)], audit)


def mixture_median(groups: list[dict], alphas: np.ndarray) -> float:
    boundaries = sorted({value for group in groups for cell in group["histogram"] for value in (cell["lower"], cell["upper"])})
    def cdf(price: float) -> float:
        return sum(float(alpha) * sum(cell["mass"] * np.clip((price - cell["lower"]) / (cell["upper"] - cell["lower"]), 0, 1)
                                     for cell in group["histogram"]) for alpha, group in zip(alphas, groups))
    for lower, upper in zip(boundaries, boundaries[1:]):
        lo, hi = cdf(lower), cdf(upper)
        if hi >= .5 - 1e-12 and hi > lo:
            return float(lower + (upper - lower) * np.clip((.5 - lo) / (hi - lo), 0, 1))
    return float(boundaries[-1])


def approximate_errors(groups: list[dict], queries: np.ndarray, reference: np.ndarray, prices: np.ndarray,
                       base: np.ndarray, contributors: list[str], bandwidth: float, max_distance: float) -> dict:
    errors = []
    priors = np.array([group["baseMass"] for group in groups]); priors /= priors.sum()
    priors = np.floor(priors * 20 + .5) / 20
    if np.any(priors == 0):
        return {"count": 0, "medianAbsoluteError": None, "p90AbsoluteError": None, "coverage": 0}
    priors /= priors.sum()
    centers = np.array([group["centroid"] for group in groups])
    for query in queries:
        distances = np.linalg.norm(reference - query, axis=1)
        mask = distances <= max_distance
        if np.sum(mask) < 10 or len(set(np.array(contributors)[mask])) < 5:
            continue
        private_base = base[mask] * np.exp(-distances[mask] ** 2 / (2 * bandwidth ** 2))
        private_weights = capped_weights(private_base, list(np.array(contributors)[mask]))
        private_median = quantile(prices[mask], private_weights)
        group_distances = np.linalg.norm(centers - query, axis=1)
        supported = group_distances <= max_distance
        if not np.any(supported):
            continue
        selected = [group for group, use in zip(groups, supported) if use]
        alphas = priors[supported] * np.exp(-group_distances[supported] ** 2 / (2 * bandwidth ** 2))
        alphas /= alphas.sum()
        errors.append(abs(private_median - mixture_median(selected, alphas)))
    return {"count": len(errors), "medianAbsoluteError": float(np.median(errors)) if errors else None,
            "p90AbsoluteError": float(np.quantile(errors, .9)) if errors else None,
            "coverage": len(errors) / len(queries) if len(queries) else 0}


def train_candidate(embeddings: np.ndarray, train: np.ndarray, dev: np.ndarray, equivalents: np.ndarray,
                    margin: float, regularization: float) -> tuple[np.ndarray, dict]:
    torch.manual_seed(SEED)
    values = torch.tensor(embeddings, dtype=torch.float32)
    theta = torch.nn.Parameter(torch.full((384,), -math.log(2), dtype=torch.float32))
    optimizer = torch.optim.Adam([theta], lr=.03)
    train_ids = torch.tensor(train, dtype=torch.long)
    equivalent_ids = torch.tensor(equivalents, dtype=torch.long)
    best_loss, best_scales, best_epoch, stale = float("inf"), np.ones(384), 0, 0
    history = []
    for epoch in range(1, 101):
        scales = .5 + 1.5 * torch.sigmoid(theta)
        adapted = torch.nn.functional.normalize(values * scales, p=2, dim=1)
        anchor, positive, negative = adapted[train_ids[:, 0]], adapted[train_ids[:, 1]], adapted[train_ids[:, 2]]
        triplet = torch.relu(margin + ((anchor - positive) ** 2).sum(1) - ((anchor - negative) ** 2).sum(1)).mean()
        equivalent_loss = ((adapted[equivalent_ids[:, 0]] - adapted[equivalent_ids[:, 1]]) ** 2).sum(1).mean() if len(equivalents) else torch.tensor(0.)
        loss = triplet + regularization * torch.log(scales).square().mean() + .1 * equivalent_loss
        optimizer.zero_grad(); loss.backward(); optimizer.step()
        with torch.no_grad():
            scales_after = (.5 + 1.5 * torch.sigmoid(theta)).numpy().copy()
            dev_vectors = adapt(embeddings, scales_after)
            ap = np.sum((dev_vectors[dev[:, 0]] - dev_vectors[dev[:, 1]]) ** 2, axis=1)
            an = np.sum((dev_vectors[dev[:, 0]] - dev_vectors[dev[:, 2]]) ** 2, axis=1)
            dev_loss = float(np.maximum(0, margin + ap - an).mean())
        history.append({"epoch": epoch, "trainLoss": float(loss.detach()), "developmentTripletLoss": dev_loss})
        if dev_loss < best_loss - 1e-6:
            best_loss, best_scales, best_epoch, stale = dev_loss, scales_after, epoch, 0
        else:
            stale += 1
        if stale >= 12:
            break
    return best_scales, {"margin": margin, "lambda": regularization, "gamma": .1, "epochs": len(history),
                         "selectedEpoch": best_epoch, "developmentTripletLoss": best_loss, "history": history,
                         "metrics": triplet_metrics(adapt(embeddings, best_scales), dev)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", default="generated/embedding-cache.json")
    parser.add_argument("--output-dir", default="generated")
    args = parser.parse_args()
    torch.set_num_threads(1); np.random.seed(SEED)
    cache_path, output_dir = Path(args.cache), Path(args.output_dir)
    raw = cache_path.read_bytes(); cache = json.loads(raw)
    items = cache["records"]; ids = {item["id"]: index for index, item in enumerate(items)}
    embeddings = np.array([item["embedding"] for item in items], dtype=np.float64)
    if embeddings.shape != (len(items), 384) or not np.isfinite(embeddings).all():
        raise ValueError("Cache must contain finite 384-dimensional embeddings")
    norms = np.linalg.norm(embeddings, axis=1)
    if not np.allclose(norms, 1, atol=1e-4):
        raise ValueError("Cached base encoder vectors must be normalized")
    triples_by_split = {split: [] for split in ("train", "dev", "test")}
    for triple in cache.get("triplets", []):
        triple_ids = [ids[triple[key]] for key in ("anchorId", "positiveId", "negativeId")]
        if any(items[index]["split"] != triple["split"] for index in triple_ids):
            raise ValueError("Triplet crosses a frozen data split")
        triples_by_split[triple["split"]].append(triple_ids)
    triples = {split: np.array(values, dtype=int).reshape((-1, 3)) for split, values in triples_by_split.items()}
    if not len(triples["train"]) or not len(triples["dev"]):
        raise ValueError("Actual train and development triplets are required")
    equivalents = []
    for pair in cache.get("equivalences", []):
        if pair.get("split") == "train" and independently_reviewed(pair):
            left, right = ids[pair["leftId"]], ids[pair["rightId"]]
            if items[left]["split"] != "train" or items[right]["split"] != "train":
                raise ValueError("Equivalence crosses training split")
            equivalents.append([left, right])
    equivalents_array = np.array(equivalents, dtype=int).reshape((-1, 2))
    candidates = []
    for margin in (.1, .2):
        for regularization in (.01, .1):
            scales, report = train_candidate(embeddings, triples["train"], triples["dev"], equivalents_array, margin, regularization)
            candidates.append((scales, report))
    for scales, report in candidates:
        report["acceptanceEvaluation"] = acceptance_decision(cache, ids, embeddings, adapt(embeddings, scales))
    # Prefer the predeclared primary metric when its reviewed denominator exists. Otherwise this is only an experimental checkpoint.
    best_scales, best = max(candidates, key=lambda candidate: (
        candidate[1]["acceptanceEvaluation"]["candidateDevelopmentRetrieval"]["precisionAt5"]
        if candidate[1]["acceptanceEvaluation"]["candidateDevelopmentRetrieval"]["reviewedQueryCount"] else -1.,
        candidate[1]["metrics"]["precisionAt5AmongLabeledCandidates"], candidate[1]["metrics"]["meanDistanceGap"]))
    baseline_dev = triplet_metrics(embeddings, triples["dev"])
    # All acceptance gates use development data only. Missing reviewed support fails closed, regardless of a diagnostic gain.
    acceptance = best["acceptanceEvaluation"]
    accepted = acceptance["accepted"]
    selected_scales = best_scales if accepted else np.ones(384)
    selected_vectors = adapt(embeddings, selected_scales)
    selected_id = hashlib.sha256(selected_scales.astype("<f4").tobytes()).hexdigest()[:16]
    adapter_version = ("experimental-adapter-" if accepted else "baseline-adapter-") + selected_id

    reputation = defaultdict(lambda: [0, 0]); seen_lots = set()
    for item in items:
        record = item["record"]; key = (record["contributorId"], record["lotId"])
        if key in seen_lots: continue
        seen_lots.add(key)
        reviews = [review for review in record["reviews"] if review.get("independent")]
        if reviews:
            latest = max(reviews, key=lambda review: review["reviewedAt"])
            reputation[record["contributorId"]][0 if latest["outcome"] == "valid" else 1] += 1
    eligible_indices, prices, base, contributors = [], [], [], []
    seen_lots = set()
    for index, item in enumerate(items):
        if item["split"] != "train": continue
        record = item["record"]; key = (record["contributorId"], record["lotId"])
        info = financial_info(item)
        if info is None or key in seen_lots: continue
        seen_lots.add(key); price, evidence_recency = info
        valid, invalid = reputation[record["contributorId"]]
        eligible_indices.append(index); prices.append(price); base.append(evidence_recency * (valid + 2) / (valid + invalid + 4))
        contributors.append(record["contributorId"])
    reference = selected_vectors[eligible_indices]; prices_array, base_array = np.array(prices), np.array(base)
    tfidf = TfidfVectorizer(ngram_range=(1, 2), stop_words="english", min_df=3, max_df=.85)
    phrase_vectors = tfidf.fit_transform([items[index]["descriptionText"] for index in eligible_indices])
    phrase_names = tfidf.get_feature_names_out()
    dev_queries = selected_vectors[[index for index, item in enumerate(items) if item["split"] == "dev" and financial_info(item) is not None]]
    group_candidates = []
    # All kernel/support choices use development only. Held-out results do not alter deployment decisions.
    for count in (2, 4, 8):
        assignment = KMeans(n_clusters=count, random_state=SEED, n_init=10).fit_predict(reference, sample_weight=base_array)
        groups, suppressed = [], []
        for group_index in range(count):
            positions = np.flatnonzero(assignment == group_index)
            users = [contributors[position] for position in positions]
            if len(positions) < 10 or len(set(users)) < 5:
                suppressed.append({"group": group_index, "reasons": ["minimum_lots_or_contributors"]}); continue
            weights = capped_weights(base_array[positions], users)
            shares = defaultdict(float)
            for weight, user in zip(weights, users): shares[user] += float(weight)
            if 1 / np.sum(weights ** 2) < 5 or 1 / sum(share ** 2 for share in shares.values()) < 4:
                suppressed.append({"group": group_index, "reasons": ["effective_support"]}); continue
            center = np.sum(reference[positions] * weights[:, None], axis=0)
            radius = math.ceil(float(np.max(np.linalg.norm(reference[positions] - center, axis=1))) * 100) / 100
            try:
                distribution, histogram_audit = histogram(prices_array[positions], weights, users)
            except ValueError as error:
                suppressed.append({"group": group_index, "reasons": ["histogram_publication_audit"], "detail": str(error)})
                continue
            groups.append({"id": f"group-{group_index + 1}", "centroid": center.tolist(), "radius": radius,
                           "topics": [], "context": {"species": "arabica", "productForm": "parchment",
                                                     "deliveryTerms": "buyer_collects", "paymentTerms": "immediate"},
                           "memberIds": [items[eligible_indices[position]]["id"] for position in positions],
                           "histogram": distribution, "histogramAudit": histogram_audit, "baseMass": float(base_array[positions].sum()),
                           "phraseCandidates": [str(phrase_names[position]) for position in np.argsort(
                               np.asarray(phrase_vectors[positions].mean(axis=0)).ravel())[-8:][::-1]]})
        if not groups: continue
        for bandwidth in (.1, .2, .3, .5):
            for max_distance in (.5, .75, 1.):
                error = approximate_errors(groups, dev_queries, reference, prices_array, base_array, contributors, bandwidth, max_distance)
                group_candidates.append({"k": count, "bandwidth": bandwidth, "maxDistance": max_distance,
                                         "groups": groups, "suppressed": suppressed, "error": error})
    viable = [candidate for candidate in group_candidates if candidate["error"]["count"] > 0]
    if not viable: raise ValueError("No supported development reference can be published")
    passing = [candidate for candidate in viable if candidate["error"]["medianAbsoluteError"] <= 250
               and candidate["error"]["p90AbsoluteError"] <= 500 and candidate["error"]["coverage"] >= .75]
    pool = passing or viable
    chosen = min(pool, key=lambda candidate: (-candidate["error"]["coverage"], candidate["error"]["medianAbsoluteError"], candidate["k"]))
    calibration_passed = bool(passing)
    deployment_groups = [{key: value for key, value in group.items() if key not in ("histogram", "histogramAudit", "baseMass", "phraseCandidates")}
                         for group in chosen["groups"]]
    calibration_version = "synthetic-development-" + hashlib.sha256(json.dumps({key: chosen[key] for key in ("k", "bandwidth", "maxDistance")}, sort_keys=True).encode()).hexdigest()[:12]
    model = {"encoderVersion": cache["encoderVersion"], "preprocessingVersion": cache["preprocessingVersion"],
             "adapterVersion": adapter_version, "trainingStatus": "accepted" if accepted else "baseline",
             "calibrationVersion": calibration_version, "adapter": selected_scales.tolist(),
             "calibration": {"status": "passed" if calibration_passed else "failed", "minSimilarity": -1., "minMargin": 0.,
                             "kernelTemperature": chosen["bandwidth"], "maxDistance": chosen["maxDistance"]},
             "groups": deployment_groups}
    heldout_queries = selected_vectors[[index for index, item in enumerate(items) if item["split"] == "test" and financial_info(item) is not None]]
    heldout_error = approximate_errors(chosen["groups"], heldout_queries, reference, prices_array, base_array, contributors,
                                      chosen["bandwidth"], chosen["maxDistance"])
    report = {"seed": SEED, "cacheSha256": hashlib.sha256(raw).hexdigest(), "encoderVersion": cache["encoderVersion"],
              "preprocessingVersion": cache["preprocessingVersion"], "adapterVersion": adapter_version,
              "labelSha256": hashlib.sha256(json.dumps(cache.get("triplets", []), sort_keys=True).encode()).hexdigest(),
              "labelReviewStatus": "synthetic_unreviewed", "independentAgriculturalReview": False,
              "splitPolicy": "Frozen contributor/lot/scenario/template train/dev/test cache; groups and reference use train only.",
              "optimizer": {"name": "Adam", "learningRate": .03, "maxEpochs": 100, "earlyStoppingPatience": 12,
                            "scaleBounds": [.5, 2], "torchVersion": torch.__version__, "device": "cpu", "threads": 1},
              "equivalenceCount": len(equivalents), "baselineDevelopment": baseline_dev,
              "selectedCandidate": best, "candidates": [candidate[1] for candidate in candidates],
              "trainingStatus": model["trainingStatus"], "acceptanceGates": acceptance,
              "acceptanceReason": "All independently reviewed development gates passed" if accepted else
                  "Baseline retained; unsupported or failed gates: " + ", ".join(acceptance["failedGates"]),
              "candidateCheckpointRole": "Actual bounded-scale experimental simulation checkpoint; diagnostic triplet gains do not justify deployment",
              "baselineTest": triplet_metrics(embeddings, triples["test"]),
              "selectedTest": triplet_metrics(selected_vectors, triples["test"]),
              "learnedCandidateTest": triplet_metrics(adapt(embeddings, best_scales), triples["test"]),
              "publicationTrainingLots": len(eligible_indices), "groupCount": len(deployment_groups),
              "clustering": {"method": "weighted KMeans", "candidateK": [2, 4, 8], "nInit": 10, "selectedK": chosen["k"], "suppressed": chosen["suppressed"]},
              "privateTopicCandidates": [{"groupId": group["id"], "phrases": group["phraseCandidates"],
                                          "reviewStatus": "synthetic_unreviewed", "publicTopics": []} for group in chosen["groups"]],
              "developmentApproximation": chosen["error"], "heldoutApproximation": heldout_error,
              "groupCandidateMetrics": [{key: value for key, value in candidate.items() if key != "groups"} for candidate in group_candidates],
              "histogramPolicy": {"grid": [0, 20000], "step": 250, "minimumContributorsPerInterval": 3, "massRounding": .05},
              "histogramRoundingAudits": [{"groupId": group["id"], **group["histogramAudit"]} for group in chosen["groups"]],
              "topicReviewStatus": "No labels published: recurring phrase candidates require human review",
              "limitations": ["All training sales, prices, labels and attestations are fictional.",
                              "Synthetic rule labels are not independent economic comparability review.",
                              "Missing independently reviewed precision@5, matched-coverage critical comparisons, and equivalence/negation cases prevent adapter acceptance.",
                              "No Kiswahili agricultural language reviewer or physical phone evaluation.",
                              "Held-out approximation is reported without retuning the development choices."]}
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "learned-groups.json").write_text(json.dumps(model, indent=2), encoding="utf8")
    (output_dir / "training-report.json").write_text(json.dumps(report, indent=2), encoding="utf8")
    (output_dir / "candidate-adapter.f32").write_bytes(best_scales.astype("<f4").tobytes())
    print(json.dumps({"trainingStatus": model["trainingStatus"], "groups": len(deployment_groups),
                      "development": chosen["error"], "heldout": heldout_error, "calibration": model["calibration"]["status"]}))


if __name__ == "__main__":
    main()
