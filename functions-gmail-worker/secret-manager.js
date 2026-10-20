const PROJECT_ID = "mentora-edge-v2";

function createSecretManagerClient(auth, fetchImpl = fetch) {
  async function request(method, url, body) {
    const client = await auth.getClient();
    const headers = await client.getRequestHeaders(url);
    if (body !== undefined) headers.set("content-type", "application/json");
    const response = await fetchImpl(url, {
      method, headers, redirect: "error", signal: AbortSignal.timeout(10000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      const error = new Error("Secret Manager request failed.");
      error.code = `SECRET_MANAGER_${response.status}`;
      throw error;
    }
    return response.json();
  }
  function resource(secretId) {
    if (typeof secretId !== "string" || !/^[A-Za-z0-9_-]{1,255}$/.test(secretId)) throw new Error("Invalid secret resource identifier.");
    return `projects/${PROJECT_ID}/secrets/${secretId}`;
  }
  return {
    async read(secretId) {
      const payload = await request("GET", `https://secretmanager.googleapis.com/v1/${resource(secretId)}/versions/latest:access`);
      const value = Buffer.from(payload?.payload?.data || "", "base64").toString("utf8");
      if (!value) throw new Error("Required Gmail secret is unavailable.");
      return value;
    }
  };
}

module.exports = { createSecretManagerClient };
