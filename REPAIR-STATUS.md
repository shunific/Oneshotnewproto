# Customer-site repair handoff — 20 October 2026

This branch contains the customer website repairs. The matching POS and cloud SQL candidates are in the separate native repair PR: https://github.com/shunific/Oneshotnewproto/pull/1 . They target different source branches; review each against its own base.

Implemented customer changes:

- Owner-scoped authenticated booking reads and sanitized public availability.
- Reviewed schedule, price, deposit and terms validation through trusted booking RPC commands; revision checks and original-request recovery for interrupted writes.
- Private receipt upload/recovery, correct payment-credit summaries and owner-scoped final receipts.
- Account-change guards that discard stale private results, acknowledged feedback submission and consistent settings/table mapping.
- Dependency updates, a reproducible lockfile and 136 customer regression tests.

Validation: `npm test` passes all 136 tests; `npm run build` succeeds with a bundle-size warning. The repository already tracks `dist`, so refreshed output is included. Local browser traces and environment/database files are excluded.

These checks do not establish live cloud acceptance. The matching RPC/security/storage cutover must be applied and configured before deploying this customer candidate. Approved venue terms/capacity rules, physical table mappings and cloud staff/test accounts remain required. Staff booking/receipt/refund operations require the trusted backend; local POS credentials do not grant cloud authority.

Remaining functional work includes manual reservations, trusted hosted settings/content publication, transaction notifications, cash-booking/trusted-waiver gaps and final coordinated automated acceptance. The POS source's latest independent regression checkpoint is 747 passing tests. No blanket 75-item functional pass, release deployment, PR merge or credential revocation is claimed here.
