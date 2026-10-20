const { onRequest } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const { GoogleAuth, OAuth2Client } = require("google-auth-library");
const { createGmailDraftWorkerHandler } = require("./worker-core");
const { createSecretManagerClient } = require("./secret-manager");

const gmailOAuthClientId = defineString("GMAIL_OAUTH_CLIENT_ID", { default: "" });
const gmailOAuthClientSecretId = defineString("GMAIL_OAUTH_CLIENT_SECRET_ID", { default: "gmail-oauth-client-secret" });
const gmailOAuthRefreshTokenSecretId = defineString("GMAIL_OAUTH_REFRESH_TOKEN_SECRET_ID", { default: "gmail-oauth-refresh-token" });
const gmailDraftWorkerUrl = defineString("GMAIL_DRAFT_WORKER_URL", { default: "" });
const googleAuth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
const secrets = createSecretManagerClient(googleAuth);
const verifier = new OAuth2Client();

exports.gmailDraftWorker = onRequest({
  region: "asia-south1",
  serviceAccount: "mentora-gmail-draft@mentora-edge-v2.iam.gserviceaccount.com",
  invoker: "private",
  timeoutSeconds: 60,
  memory: "512MiB",
  maxInstances: 3
}, createGmailDraftWorkerHandler({
  verifier,
  secrets,
  fetchImpl: fetch,
  getConfig: () => ({
    clientId: gmailOAuthClientId.value(),
    clientSecretId: gmailOAuthClientSecretId.value(),
    refreshTokenSecretId: gmailOAuthRefreshTokenSecretId.value(),
    audience: gmailDraftWorkerUrl.value()
  })
}));
