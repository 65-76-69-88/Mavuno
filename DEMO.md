# Demonstrate the prototype

Use the production build at `http://127.0.0.1:3001`. All people, evidence, prices and markets are fictional. The app compares an offer with a synthetic reference; it does not determine a fair market price.

## Farmer comparison

1. Choose Farmer A and English. Select **Install offline assets** while connected. The first installation is approximately 161 MiB; the recurring comparison pack is much smaller. Wait for **Offline assets installed**.
2. Disable networking in the browser developer tools and reload. Enter a new description, for example:

   > I have 50 kg of dry Arabica parchment coffee, carefully hand-sorted and kept in clean sacks in Ondera-Demo. The buyer collects from the farm and pays immediately. The offer is TZS 4800 per kg on 2026-10-04. Sale costs are 0 and loan repayment is 0.

3. Review and correct the extracted money and context. Optional characteristics can remain unknown. Confirm the details and compare. Describe the result as an approximate median and middle half of reviewed fictional sales.
4. Edit only the offer amount. The reference stays the same because offered prices are removed before semantic inference. A known incompatible form such as coffee cherry should refuse a parchment reference.
5. Record the actual sale. Upload and aggregate-use consent are separate choices. While offline, the consented contribution waits in the local outbox. Farmer B has separate personal records.

The initial reference is dated 4 October 2026 and expires after its declared validity period. An expired pack must refuse comparison; changing the system clock is not a production refresh strategy.

## Contribution and publication

1. Reconnect Farmer A and select **Sync my records**. Upload does not approve or publish the sale.
2. Open **Publisher workspace**. Use the private `REVIEWER_SECRET` configured in the server environment. The credential is never included in the frontend bundle.
3. Inspect the report, its money/context and any private PNG/JPEG attachment. Correct consequential errors, give a review reason, and approve or reject. A photo is evidence for review; it is not automatically interpreted by OCR or a visual model.
4. Select **Publish aggregate pack**. The publisher embeds newly eligible price-free descriptions under the deployed model and rebuilds protected distributions. It does not retrain the similarity adapter on every upload.
5. Sync Farmer A again to see whether the report was included. An approved report can still be excluded by support or publication policies.
6. Switch to Farmer B, check for an update, then disable networking and reload. Enter another new description and compare with the installed version. A single contribution need not move the median.

Publishing one fictional contribution immediately is a demonstration exception. Real releases need batching and additional disclosure analysis.

## Languages and limits to show

English and French support actual local input inference. For Kiswahili, use a new input and show correction plus the actual result or refusal. Wording is provisional and has no independent fluent agricultural review. The frozen language evaluation contains unsupported Kiswahili comparisons; do not claim general Kiswahili price accuracy.

The CPU adapter experiment uses derived, unreviewed synthetic labels. The deployment retains the base encoder until the declared development ranking and critical-error gates have sufficient evidence. Learned aggregate grouping still runs on genuine embeddings. Explain this decision and show the training/evaluation artifacts rather than claiming a proven learned improvement.

Voice, receipt OCR, visual grading and price regression are outside this release. Physical phone performance, real-market validity and farmer income effects are unmeasured.

## Capture evidence

Start the application separately, then use `npm run test:browser` to reproduce the integrated workflow. Browser screenshots, traces and the HTML report are written under `output/browser`. `EVIDENCE.md` records the measured release and known failures. The implementation plan specifies the required short clips and longer World Bank video; actual team names, hosted links and submission details must come from the team.
