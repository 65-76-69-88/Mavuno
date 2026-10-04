"""Focused checks for deployment acceptance and post-rounding influence protection."""
import unittest
import numpy as np
from train import acceptance_decision, histogram


class PublicationPolicies(unittest.TestCase):
    def test_rounding_cannot_inflate_a_capped_contributor(self):
        users = ['B', 'C', 'D', 'A', 'B', 'C', 'D', 'E']
        weights = np.array([.1, .1, .06, .25, .07, .07, .16, .19])
        prices = np.array([5000, 5000, 5000, 6000, 6000, 6000, 6000, 6000])
        self.assertGreater(.75 * .25 / .74, .25)
        bins, audit = histogram(prices, weights, users)
        self.assertEqual(bins, [{'lower': 5000, 'upper': 6250, 'mass': 1.}])
        self.assertEqual(audit['roundingMerges'], 1)
        self.assertLessEqual(audit['representedMaximumContributorShare'], .25 + 1e-10)

    def test_diagnostic_improvement_with_unreviewed_labels_retains_baseline(self):
        cache = {'records': [{'id': 'a', 'split': 'dev'}, {'id': 'p', 'split': 'dev'}, {'id': 'n', 'split': 'dev'}],
                 'independentReview': False, 'triplets': [{'split': 'train', 'reviewStatus': 'synthetic_unreviewed'}]}
        baseline = np.array([[1., 0.], [0., 1.], [1., 0.]])
        improved = np.array([[1., 0.], [1., 0.], [0., 1.]])
        result = acceptance_decision(cache, {'a': 0, 'p': 1, 'n': 2}, baseline, improved)
        self.assertFalse(result['accepted'])
        self.assertEqual(result['baselineDevelopmentRetrieval']['reviewedQueryCount'], 0)
        self.assertFalse(result['gates']['independentReviewedTrainingLabels'])
        self.assertFalse(result['gates']['developmentPrecisionAt5Improves'])
        self.assertFalse(result['gates']['noNewReviewedEquivalenceOrNegationFailures'])

    def test_primary_gain_cannot_hide_more_critical_false_comparisons(self):
        keys = ['a', 'p1', 'p2', 'b', 'c', 'd', 'e', 'n', 'train-a', 'train-p', 'train-n']
        ids = {key: index for index, key in enumerate(keys)}
        case = {'anchorId': 'a', 'candidateIds': ['p1', 'p2', 'b', 'c', 'd', 'e', 'n'],
                'relevantIds': ['p1', 'p2'], 'criticalNegativeIds': ['n'], 'split': 'dev',
                'reviewStatus': 'reviewed', 'independent': True, 'complete': True}
        cache = {'records': [{'id': key, 'split': 'train' if key.startswith('train') else 'dev'} for key in keys],
                 'independentReview': True, 'relevanceSets': [case], 'acceptanceCoverage': .8,
                 'triplets': [{'anchorId': 'train-a', 'positiveId': 'train-p', 'negativeId': 'train-n',
                               'split': 'train', 'reviewStatus': 'reviewed', 'independent': True}],
                 'semanticChecks': [{'anchorId': 'a', 'positiveId': 'p1', 'negativeId': 'n', 'kind': kind,
                                     'split': 'dev', 'reviewStatus': 'reviewed', 'independent': True}
                                    for kind in ['equivalence', 'negation']]}
        baseline = np.array([0., 1., 6., .5, 2., 3., 4., 7., 0., 1., 2.]).reshape((-1, 1))
        risky = np.array([0., .2, .3, .5, 2., 3., 7., 4., 0., 1., 2.]).reshape((-1, 1))
        rejected = acceptance_decision(cache, ids, baseline, risky)
        self.assertTrue(rejected['gates']['developmentPrecisionAt5Improves'])
        self.assertFalse(rejected['gates']['criticalFalseComparisonsDoNotIncreaseAtMatchedCoverage'])
        self.assertFalse(rejected['accepted'])
        safe = risky.copy(); safe[ids['n']] = 8.
        accepted = acceptance_decision(cache, ids, baseline, safe)
        self.assertTrue(accepted['accepted'])
        self.assertEqual(accepted['baselineCriticalAtMatchedCoverage']['acceptedComparisons'],
                         accepted['candidateCriticalAtMatchedCoverage']['acceptedComparisons'])


if __name__ == '__main__':
    unittest.main()
