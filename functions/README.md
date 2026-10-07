# Mentora Edge payroll functions

The dashboard sends only entered salary fields and a stable UUID request ID. The Firebase callable functions independently validate the request, reserve a monthly reference, save a draft, generate the canonical A4 PDF with PDFKit, enforce admin authorization and App Check, then send that server-generated PDF through SMTP. Browser preview and download call the same PDF generator. No PDF bytes are accepted from the browser.

## Source configuration

- Functions and the browser use `asia-south1`.
- `users/{uid}.role == "admin"` is the primary access check. Its protection depends on deployed Firestore rules; those rules are not present in this repository.
- App Check is enforced by the deployed callables. For the Firebase Functions Emulator only, enforcement is disabled automatically.
- Add the registered reCAPTCHA v3 site key to the `firebase-app-check-site-key` meta tag in `admin.html`. The site key is public configuration; never put a secret key there.
- Sends are limited to 100 new send attempts per administrator per UTC day.
- Salary names and positions support Latin/Latin-1 characters compatible with PDFKit's built-in fonts. Enter names in Latin transliteration; non-Latin scripts need an embedded Unicode font before use.

## Dependencies and local checks

Direct dependency versions are exact-pinned in `package.json`; `package-lock.json` pins the complete dependency tree. The Functions runtime remains Node.js 20. The lockfile was installed and the payroll unit tests pass locally. `npm audit` currently reports seven moderate affected dependency entries through the Google Cloud Firestore/Storage dependency chain and `uuid@9.0.1`; do not bypass these findings with `--force` or a UUID major-version override. Before deployment, rerun the audit and review the advisory reachability when compatible upstream dependency releases are available:

1. Use Node.js 20 and npm.
2. Run `npm install --package-lock-only --prefix functions` to generate `functions/package-lock.json`.
3. Run `npm ci --prefix functions` and `npm audit --prefix functions`.
4. Run `npm test --prefix functions`.
5. Review the audit output and lockfile before deployment; do not assume the remaining UUID advisory is unreachable without verifying the dependency call paths.

## Email configuration

Create `functions/.env.<project-id>` with non-secret values, for example:

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=payroll@example.com
SMTP_FROM="Mentora Edge <payroll@example.com>"
```

Only ports 465 and 587 are accepted. Port 465 uses implicit TLS; port 587 requires STARTTLS. Certificate verification is enabled. Store the password only with `firebase functions:secrets:set SMTP_PASSWORD` for the selected project. The functions never return SMTP configuration to the browser.

## Firestore records and rules

- `salarySlips/{sendRequestId}` contains normalized payroll values, `payloadHash`, the strict `ME-PAY-YYYY-MM-NNN` reference, state (`draft`, `sending`, `sent`, `failed`, or `unknown`), timestamps, creator UID, a retry flag, and a sanitized error code when needed. Only the last four account digits are stored.
- `salarySlipCounters/{YYYY-MM}` allocates unique monthly references.
- `payrollRateLimits/{uid_YYYY-MM-DD}` enforces the per-admin daily quota.
- PDFs are generated for preview/download/send and are not stored in Firestore.
- Payroll records include salary and employee contact data. No automatic record-retention/TTL policy is configured in source; set and document a retention period in Firestore/operations policy before production, and verify cleanup covers drafts and completed records as required.
- SMTP timeouts or process failures after sending begins leave a request `unknown` or `sending`. The same request ID never triggers another automatic send. Check SMTP provider logs using the deterministic Message-ID before resolving an uncertain request; do not create a replacement request until delivery is known.

Merge `firestore.rules.payroll-snippet` into the deployed rules and exclude all three payroll collections from any broader wildcard read/write rule. Firestore combines matching allow rules with OR semantics, so the explicit deny blocks cannot override broader grants. Also confirm users cannot write or change `users/{uid}.role`. Do not deploy the snippet as a replacement for existing rules.

## Staging deployment (do not target the production default)

Create a separate Firebase staging project in the Console, register its Web app, configure Firestore, and register the App Check reCAPTCHA v3 provider for the staging domain. Then, from the repository root, use the new staging project ID explicitly:

```powershell
firebase use --add
# Select the staging project and save the alias as: staging
firebase functions:secrets:set SMTP_PASSWORD --project <staging-project-id>
firebase deploy --only functions --project <staging-project-id>
```

Create `functions/.env.<staging-project-id>` with staging SMTP settings, set the App Check site key in the staging admin build, and merge/deploy the payroll rules only after reviewing the existing staging rules. Test the callable emulator first when possible. The checked-in `.firebaserc` default remains `mentora-edge-v2`; do not use an unqualified production deploy command while validating this feature.
