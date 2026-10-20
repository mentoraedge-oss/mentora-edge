# Gmail Draft Workflow Setup and Operations

This feature creates a Gmail **draft** for an administrator to review and send manually. The Gmail worker calls only `users.drafts.create`; it has no Gmail message-send or draft-send code. The OAuth `gmail.compose` scope itself permits broader actions, including sending, so server-side code restrictions do not narrow the token's inherent scope. Keep Gmail credentials in Secret Manager and grant access only to the private worker and OAuth callback identities as described below.

## Source behavior

- `beginGmailDraftOAuth` requires a Firebase-authenticated admin using the existing `users/{uid}.role === "admin"` check. It stores a SHA-256 hash of a 32-byte random state in Firestore database `mentora-oauth-state`, with the initiating UID, the configured redirect URI, a 10-minute expiry, and an unconsumed marker.
- `gmailOAuthCallback` is the only explicitly public HTTP endpoint and runs as `mentora-oauth-callback@mentora-edge-v2.iam.gserviceaccount.com`. The authorization response uses `form_post`, so the one-time code and state are sent to the callback in the POST body rather than the callback URL. It consumes state in a Firestore transaction, exchanges the code on the server, verifies the Google ID token signature/audience/issuer/expiry and exact verified mailbox `mentoraedge@gmail.com`, then stores the refresh token as a new Secret Manager version. The callback page does not include credentials or provider error details.
- `createSalarySlipDraft` requires an admin. The trusted payroll orchestrator validates the request, reads the canonical salary record, generates the PDF, and stores provider `gmail` idempotency/result state in `salarySlipDraftRequests` in `(default)`. It sends only the validated recipient/message fields, payload hash, request ID, and server-generated PDF to a separate IAM-private worker using a Google-signed OIDC ID token. It does not alter SMTP delivery statuses. Repeated completed requests return the existing Gmail draft ID. `creating`/`unknown` requests are not retried automatically.
- `gmailDraftWorker` is deployed from the separate `functions-gmail-worker` codebase. It has no Firestore initialization or Firestore dependency. It verifies the OIDC token audience and expected orchestrator service-account email, validates its strict request schema and size limits, reads OAuth credentials from Secret Manager, and calls only `users.drafts.create`. Cloud Run IAM must grant `roles/run.invoker` on this worker only to `mentora-payroll-orchestrator@mentora-edge-v2.iam.gserviceaccount.com`.
- A confirmed Gmail 4xx rejection is recorded as retryable; a network failure, throttling response, server error, or other ambiguous result becomes `unknown` and requires manual reconciliation in Gmail Drafts using the payslip reference/request marker. No automatic Gmail retry occurs.
- The existing SMTP Send Payslip path remains available. Because it remains independently enabled, an administrator could deliberately create a Gmail draft and also use SMTP for the same salary slip; this implementation does not coordinate the two delivery paths. Check the salary record’s SMTP status before creating a draft; the draft callable rejects records already `sent`, `sending`, or `unknown`.

## Google Cloud and Google Auth Platform setup (manual)

Do not enter OAuth client secrets or refresh tokens in source, `.env` files, Firebase parameter files, or the browser. Secret IDs and OAuth client IDs are identifiers, not secret values.

1. Enable Gmail API and Secret Manager API in project `mentora-edge-v2`. Confirm the named Firestore database `mentora-oauth-state` exists in `asia-south1`; the application explicitly uses that database for OAuth state. Payroll continues to use `getFirestore()` for `(default)`.
2. Create a Google OAuth client of type **Web application**. Configure the consent screen, keep `mentoraedge@gmail.com` as an allowed test user while the app is in testing, and authorize `openid`, `email`, and `https://www.googleapis.com/auth/gmail.compose`. This Gmail scope is broad enough to send; the code restriction is not a token-scope restriction. In testing mode Google may expire refresh tokens after seven days for scopes beyond basic identity scopes; verify the applicable OAuth publishing/verification requirements before relying on long-term production credentials.
3. Create Secret Manager secret `gmail-oauth-client-secret` and add the OAuth client secret as a version. Create the `gmail-oauth-refresh-token` secret resource; the OAuth callback adds the first refresh-token version after successful authorization. Never print secret values.
4. Create service accounts `mentora-payroll-orchestrator@mentora-edge-v2.iam.gserviceaccount.com` and `mentora-gmail-draft@mentora-edge-v2.iam.gserviceaccount.com`. The orchestrator identity is explicitly assigned to `beginGmailDraftOAuth` and `createSalarySlipDraft`; it needs the default-database payroll role and the narrow OAuth-state role. The worker identity is explicitly assigned to `gmailDraftWorker`; it has no Firestore access. Do not create or download service-account keys.
5. Grant `roles/run.invoker` on the private `gmailDraftWorker` service to the orchestrator identity only. Use the actual deployed Cloud Run service name/region, verified from the deployed function; do not make the worker public. This enables the orchestrator's Google-signed OIDC request. The caller obtains an ID token for the exact worker URL as its audience.
6. Use project custom roles with only `secretmanager.versions.access` for secret payload reads and only `secretmanager.versions.add` for refresh-token writes, then bind them at the individual secret. Grant the callback identity read access only to `gmail-oauth-client-secret` and version-add access only to `gmail-oauth-refresh-token`. Grant the worker identity read access only to `gmail-oauth-client-secret` and `gmail-oauth-refresh-token`; it receives no version-add permission. The orchestrator receives no Secret Manager access. Do not grant project-wide Secret Manager roles.
7. Create the custom Firestore role `mentoraOauthStateStore` with `datastore.databases.get`, `datastore.entities.get`, `datastore.entities.create`, and `datastore.entities.update`. Grant it conditionally to the callback service account and orchestrator service account, restricted to `mentora-oauth-state`.
8. The orchestrator identity needs access to `(default)` for admin-profile lookup, payroll record/counter transactions, and draft idempotency transactions. These operations require `datastore.databases.get`, `datastore.entities.get`, `datastore.entities.create`, `datastore.entities.update`, and `datastore.entities.list` (reference allocation and salary history queries). Firestore IAM is database-scoped, not collection-scoped; this identity can therefore access all documents in `(default)`. Restrict the custom role binding to `(default)` with an IAM condition. Do not grant these permissions to the worker.
9. The deployer needs `iam.serviceAccounts.actAs`, normally via `roles/iam.serviceAccountUser`, on the callback, orchestrator, and worker service accounts, plus the separate function deployment permissions. Grant service-account access only on those identities. Do not grant Owner/Editor/Firebase Admin for this setup.

The following service-account creation commands are examples for the authorized cloud administrator only; they have not been run:

```powershell
gcloud iam service-accounts create mentora-payroll-orchestrator --project=mentora-edge-v2 --display-name="Mentora Payroll Draft Orchestrator"
gcloud iam service-accounts create mentora-gmail-draft --project=mentora-edge-v2 --display-name="Mentora Gmail Draft Worker"
```

Example IAM commands for the authorized project IAM administrator (these are documentation only; no command has been run):

```powershell
gcloud iam roles create mentoraOauthStateStore --project=mentora-edge-v2 --title="Mentora OAuth State Store" --description="Read and transactionally create/update short-lived OAuth state" --permissions="datastore.databases.get,datastore.entities.get,datastore.entities.create,datastore.entities.update" --stage=GA
gcloud projects add-iam-policy-binding mentora-edge-v2 --member="serviceAccount:mentora-oauth-callback@mentora-edge-v2.iam.gserviceaccount.com" --role="projects/mentora-edge-v2/roles/mentoraOauthStateStore" --condition="expression=resource.type == 'firestore.googleapis.com/Database' && resource.name == 'projects/mentora-edge-v2/databases/mentora-oauth-state',title=oauth-state-db-only,description=Only the OAuth state database"
gcloud projects add-iam-policy-binding mentora-edge-v2 --member="serviceAccount:mentora-payroll-orchestrator@mentora-edge-v2.iam.gserviceaccount.com" --role="projects/mentora-edge-v2/roles/mentoraOauthStateStore" --condition="expression=resource.type == 'firestore.googleapis.com/Database' && resource.name == 'projects/mentora-edge-v2/databases/mentora-oauth-state',title=oauth-state-db-only,description=Only the OAuth state database"

gcloud iam roles create mentoraSalaryDraftStore --project=mentora-edge-v2 --title="Mentora Salary Draft Store" --description="Read and write records required for authorized salary draft creation" --permissions="datastore.databases.get,datastore.entities.get,datastore.entities.create,datastore.entities.update,datastore.entities.list" --stage=GA
gcloud projects add-iam-policy-binding mentora-edge-v2 --member="serviceAccount:mentora-payroll-orchestrator@mentora-edge-v2.iam.gserviceaccount.com" --role="projects/mentora-edge-v2/roles/mentoraSalaryDraftStore" --condition="expression=resource.type == 'firestore.googleapis.com/Database' && resource.name == 'projects/mentora-edge-v2/databases/(default)',title=salary-db-only,description=Payroll and draft records in the default database"

gcloud iam roles create gmailSecretPayloadReader --project=mentora-edge-v2 --title="Gmail OAuth Secret Payload Reader" --description="Read secret payload versions only" --permissions="secretmanager.versions.access" --stage=GA
gcloud iam roles create gmailRefreshTokenVersionWriter --project=mentora-edge-v2 --title="Gmail Refresh Token Version Writer" --description="Add refresh token secret versions only" --permissions="secretmanager.versions.add" --stage=GA
gcloud secrets add-iam-policy-binding gmail-oauth-client-secret --project=mentora-edge-v2 --member="serviceAccount:mentora-oauth-callback@mentora-edge-v2.iam.gserviceaccount.com" --role="projects/mentora-edge-v2/roles/gmailSecretPayloadReader"
gcloud secrets add-iam-policy-binding gmail-oauth-refresh-token --project=mentora-edge-v2 --member="serviceAccount:mentora-oauth-callback@mentora-edge-v2.iam.gserviceaccount.com" --role="projects/mentora-edge-v2/roles/gmailRefreshTokenVersionWriter"
gcloud secrets add-iam-policy-binding gmail-oauth-client-secret --project=mentora-edge-v2 --member="serviceAccount:mentora-gmail-draft@mentora-edge-v2.iam.gserviceaccount.com" --role="projects/mentora-edge-v2/roles/gmailSecretPayloadReader"
gcloud secrets add-iam-policy-binding gmail-oauth-refresh-token --project=mentora-edge-v2 --member="serviceAccount:mentora-gmail-draft@mentora-edge-v2.iam.gserviceaccount.com" --role="projects/mentora-edge-v2/roles/gmailSecretPayloadReader"

gcloud run services add-iam-policy-binding WORKER_CLOUD_RUN_SERVICE_NAME --project=mentora-edge-v2 --region=asia-south1 --member="serviceAccount:mentora-payroll-orchestrator@mentora-edge-v2.iam.gserviceaccount.com" --role="roles/run.invoker"

gcloud iam service-accounts add-iam-policy-binding mentora-oauth-callback@mentora-edge-v2.iam.gserviceaccount.com --project=mentora-edge-v2 --member="REPLACE_WITH_VERIFIED_DEPLOYER_PRINCIPAL" --role="roles/iam.serviceAccountUser"
gcloud iam service-accounts add-iam-policy-binding mentora-payroll-orchestrator@mentora-edge-v2.iam.gserviceaccount.com --project=mentora-edge-v2 --member="REPLACE_WITH_VERIFIED_DEPLOYER_PRINCIPAL" --role="roles/iam.serviceAccountUser"
gcloud iam service-accounts add-iam-policy-binding mentora-gmail-draft@mentora-edge-v2.iam.gserviceaccount.com --project=mentora-edge-v2 --member="REPLACE_WITH_VERIFIED_DEPLOYER_PRINCIPAL" --role="roles/iam.serviceAccountUser"
```

The database-level condition is required on each Firestore binding. For the deployer binding, replace the principal with a complete member such as `user:verified-email@example.com` or `serviceAccount:verified-deployer@project.iam.gserviceaccount.com`. The custom roles should be created by an IAM administrator with permission to create project roles; project IAM policy and service-account policy updates also require their respective IAM policy permissions. Review inherited grants because a conditional binding does not revoke a broader existing role.

Firestore data methods used for OAuth state need the four state permissions above. Transaction retries repeat document reads and writes and do not need a different permission. The implementation does not query or delete OAuth state. If future code adds queries, cleanup deletes, or collection scans, review and add only the corresponding permissions (`datastore.entities.list` or `datastore.entities.delete`) to the custom role. Optional Firestore TTL on `gmailOAuthStates.expiresAt` can clean expired records; expiry is enforced by code even if TTL is not configured, and the function identity does not need delete permission for TTL cleanup.

The payroll orchestrator identity also has database-level access to `(default)` because the current admin profile, salary record, reference counter, and idempotency records all live there. Firestore IAM cannot limit those permissions to individual collections. The worker has no Firestore initialization, import, or IAM permission. It receives only the minimum validated message fields plus the canonical server-generated PDF over an authenticated private service-to-service request.

## Callback URL and deployment sequence

`firebase.json` now defines the existing payroll package as codebase `default` and the worker as codebase `gmail-worker`, both on Node.js 22. The source deliberately defaults `GMAIL_OAUTH_REDIRECT_URI` and `GMAIL_DRAFT_WORKER_URL` to empty values and fails closed until configured. Do not guess either URL. After separate deployment approval, deploy the worker codebase first, inspect its generated Gen 2 URI and Cloud Run service name, then configure the exact URI for both codebases and add the private invoker binding before allowing the orchestrator to call it. Deploy the worker again with its audience setting, then update the default codebase. Review the Firebase CLI deployment plan and existing function inventory before deployment; no deployment has been performed.

```powershell
gcloud functions describe gmailOAuthCallback --gen2 --project=mentora-edge-v2 --region=asia-south1 --format="value(serviceConfig.uri)"
gcloud functions describe gmailDraftWorker --gen2 --project=mentora-edge-v2 --region=asia-south1 --format="value(serviceConfig.uri,serviceConfig.service)"
```

Use the exact returned HTTPS URI as the OAuth client's **Authorized redirect URI** and as `GMAIL_OAUTH_REDIRECT_URI`. There are no authorized JavaScript origins required for this server-side authorization-code flow. Add only non-secret string parameters to the ignored project-specific `functions/.env.mentora-edge-v2` file:

```dotenv
GMAIL_OAUTH_CLIENT_ID=YOUR_WEB_OAUTH_CLIENT_ID
GMAIL_OAUTH_REDIRECT_URI=THE_VERIFIED_CALLBACK_URI
GMAIL_DRAFT_WORKER_URL=THE_VERIFIED_WORKER_SERVICE_URI
```

The client ID and secret ID parameters must also be present in `functions-gmail-worker/.env.mentora-edge-v2`; set `GMAIL_DRAFT_WORKER_URL` there to the same verified URI. The client secret and refresh token belong only in Secret Manager. Do not add credential values to either env file. The worker's URL must be read from its deployed `serviceConfig.uri`, then copied exactly to both codebases; this URL is also the OIDC token audience. Deploying the worker privately requires the invoker binding before the orchestrator can call it.

After separate deployment approval, use the `gmail-worker` codebase to deploy the worker and the `default` codebase to update payroll functions. Keep these as separate deployments so worker IAM and the generated URI can be verified before enabling orchestrator calls. No deployment has been performed for this implementation.

The callback URI comes from the deployed `gmailOAuthCallback` function. The OAuth begin callable fails closed until its exact redirect URI is configured. Verify the callback's unauthenticated HTTPS reachability because Google redirects a browser to it; its state/code checks are the application-level gate. Do not make the callable endpoints unauthenticated at the application level.

Read-only identity inspection examples:

```powershell
gcloud projects describe mentora-edge-v2 --format="value(projectNumber)"
gcloud functions describe beginGmailDraftOAuth --gen2 --project=mentora-edge-v2 --region=asia-south1 --format="value(serviceConfig.serviceAccountEmail)"
gcloud functions describe gmailOAuthCallback --gen2 --project=mentora-edge-v2 --region=asia-south1 --format="value(serviceConfig.serviceAccountEmail,serviceConfig.uri)"
gcloud functions describe createSalarySlipDraft --gen2 --project=mentora-edge-v2 --region=asia-south1 --format="value(serviceConfig.serviceAccountEmail)"
gcloud functions describe gmailDraftWorker --gen2 --project=mentora-edge-v2 --region=asia-south1 --format="value(serviceConfig.serviceAccountEmail,serviceConfig.uri,serviceConfig.service)"
```

Then verify deployed service identities before applying IAM bindings: `beginGmailDraftOAuth` and `createSalarySlipDraft` must run as the orchestrator identity; `gmailOAuthCallback` as the callback identity; and `gmailDraftWorker` as the worker identity. Verify the worker's generated Cloud Run service name and URI using the describe output. The exact invoker binding command, with that verified service name, is:

```powershell
gcloud run services add-iam-policy-binding VERIFIED_WORKER_CLOUD_RUN_SERVICE_NAME --project=mentora-edge-v2 --region=asia-south1 --member="serviceAccount:mentora-payroll-orchestrator@mentora-edge-v2.iam.gserviceaccount.com" --role="roles/run.invoker"
```

Confirm the callback has no broader Secret Manager grants, the worker has only secret payload-read access to the two OAuth secrets and no Firestore grants, and the orchestrator has no Secret Manager grants. IAM changes are manual and have not been applied.

## Recovery and limitations

- `draft_created` means a draft exists; it never means sent. The administrator must inspect the attachment and click Send in Gmail.
- A `creating` record left by a crash and any `unknown` record must be reconciled manually before retry. Search Gmail Drafts by the reference number or stable `X-Mentora-Request-ID`/`Message-ID`; do not reset the record or retry blindly.
- Google does not provide an idempotency key for `users.drafts.create`. The transaction claim prevents concurrent/repeated calls from issuing another create after a claim exists, but an ambiguous provider outcome requires human reconciliation.
- Gmail draft creation is not transactional with Firestore. A draft can exist even if recording its ID fails; in that case the claim stays non-retryable and must be reconciled manually.
- Existing SMTP records in `sending`, `unknown`, or `sent` are rejected for new draft creation. No record is reset or deleted.
