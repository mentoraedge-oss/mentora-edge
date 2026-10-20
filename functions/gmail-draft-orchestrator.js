const MAX_WORKER_RESPONSE_BYTES = 16 * 1024;

async function claimSalarySlipDraft({ db, FieldValue, adminUid, requestId, payloadHash, claimDraftDisposition, assertDraftPayloadCompatible }) {
  const draftRef = db.collection("salarySlipDraftRequests").doc(requestId);
  const salaryRef = db.collection("salarySlips").doc(requestId);
  return db.runTransaction(async (transaction) => {
    const [draftSnap, salarySnap] = await Promise.all([transaction.get(draftRef), transaction.get(salaryRef)]);
    const existing = draftSnap.exists ? draftSnap.data() : null;
    const disposition = claimDraftDisposition(existing, adminUid, payloadHash);
    if (disposition === "already-created") return { created: false, record: existing };
    if (disposition === "in-progress" || disposition === "uncertain") {
      throw workerError("failed-precondition", "A Gmail draft request is already in progress or has an uncertain outcome.");
    }
    if (disposition === "retry" && existing?.retryable !== true) {
      throw workerError("failed-precondition", "This Gmail draft request cannot be retried safely.");
    }
    if (!salarySnap.exists) throw workerError("not-found", "The salary-slip request was not found.");
    const salary = salarySnap.data();
    assertDraftPayloadCompatible(salary, payloadHash);
    if (!existing && salary.gmailDraftPayloadHash) {
      throw workerError("failed-precondition", "The Gmail draft record is missing for a previously claimed salary slip.");
    }
    if (salary.createdBy !== adminUid) throw workerError("permission-denied", "This salary-slip request belongs to another administrator.");
    if (salary.payloadHash !== payloadHash) throw workerError("failed-precondition", "Salary details changed after preparation.");
    if (["sent", "sending", "unknown"].includes(salary.status)) {
      throw workerError("failed-precondition", "This salary slip has an existing or uncertain SMTP outcome.");
    }
    const next = {
      provider: "gmail", requestId, createdBy: adminUid, payloadHash, referenceNumber: salary.referenceNumber,
      status: "creating", retryable: false,
      attemptCount: Number(existing?.attemptCount || 0) + 1,
      createdAt: existing?.createdAt || FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    };
    if (existing) transaction.set(draftRef, next, { merge: true });
    else transaction.create(draftRef, next);
    transaction.update(salaryRef, {
      gmailDraftPayloadHash: payloadHash,
      gmailDraftClaimedAt: FieldValue.serverTimestamp()
    });
    return { created: true, record: next, salary };
  });
}

function workerUrlOrThrow(value) {
  let url;
  try { url = new URL(value); } catch { throw workerError("GMAIL_WORKER_CONFIG", "The private Gmail worker URL is not configured.", false); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw workerError("GMAIL_WORKER_CONFIG", "The private Gmail worker URL is invalid.", false);
  }
  return url.toString();
}

function workerError(code, message, dispatched, { ambiguous = false, retryable = true } = {}) {
  const error = new Error(message);
  error.code = code;
  error.workerRequestDispatched = dispatched;
  error.ambiguous = ambiguous;
  error.retryable = retryable;
  return error;
}

async function invokePrivateGmailDraftWorker({ workerUrl, googleAuth, payload, fetchImpl = fetch, onDispatched = () => {} }) {
  const url = workerUrlOrThrow(workerUrl);
  let client;
  let headers;
  try {
    client = await googleAuth.getIdTokenClient(url);
    headers = new Headers(await client.getRequestHeaders(url));
  } catch {
    throw workerError("GMAIL_WORKER_AUTH", "Could not authenticate the private Gmail worker request.", false);
  }
  headers.set("content-type", "application/json");
  let response;
  try {
    onDispatched();
    response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(35000)
    });
  } catch {
    throw workerError("GMAIL_WORKER_UNAVAILABLE", "The Gmail worker did not return a definitive result.", true, { ambiguous: true, retryable: false });
  }

  let raw = "";
  try {
    const declaredLength = Number(response.headers?.get?.("content-length") || 0);
    if (declaredLength > MAX_WORKER_RESPONSE_BYTES) {
      throw workerError("GMAIL_WORKER_RESPONSE", "The Gmail worker returned an invalid response.", true, { ambiguous: true, retryable: false });
    }
    raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_WORKER_RESPONSE_BYTES) {
      throw workerError("GMAIL_WORKER_RESPONSE", "The Gmail worker returned an invalid response.", true, { ambiguous: true, retryable: false });
    }
  } catch (error) {
    if (error?.code === "GMAIL_WORKER_RESPONSE") throw error;
    throw workerError("GMAIL_WORKER_RESPONSE", "The Gmail worker did not return a definitive result.", true, { ambiguous: true, retryable: false });
  }
  let result;
  try { result = JSON.parse(raw); } catch { result = null; }
  if (response.ok && typeof result?.draftId === "string" && result.draftId.length > 0 && result.draftId.length <= 512) {
    return { draftId: result.draftId };
  }

  const platformRejected = [401, 403, 404].includes(response.status);
  const outcomeUnknown = result?.outcome === "unknown" ||
    (!result?.outcome && !platformRejected && response.status >= 500);
  const error = workerError(
    typeof result?.code === "string" && /^[A-Z0-9_-]{1,48}$/.test(result.code) ? result.code : `GMAIL_WORKER_${response.status}`,
    outcomeUnknown
      ? "Gmail may have created the draft, but the worker result is uncertain. Reconcile before retrying."
      : "The Gmail worker rejected the draft request.",
    true,
    { ambiguous: outcomeUnknown, retryable: outcomeUnknown ? false : (result?.retryable !== false) }
  );
  throw error;
}

module.exports = { claimSalarySlipDraft, invokePrivateGmailDraftWorker, workerUrlOrThrow };
