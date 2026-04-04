import { strFromU8, unzipSync } from "fflate";
import { processPatch, type PatchProcessingContext } from "./patch-processor";

interface Env {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_API_BASE?: string;
}

interface WorkflowRunPayload {
  action: string;
  installation?: { id: number };
  repository?: {
    name: string;
    full_name: string;
    owner: { login: string };
  };
  workflow_run?: {
    id: number;
    name?: string;
    head_branch?: string;
    pull_requests?: Array<{ number?: number }>;
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }

      const event = request.headers.get("x-github-event");
      const signature = request.headers.get("x-hub-signature-256");
      const rawBody = await request.text();

      const isValid = await verifyWebhookSignature(
        rawBody,
        signature,
        env.GITHUB_WEBHOOK_SECRET,
      );
      if (!isValid) {
        return json({ error: "Invalid webhook signature" }, 401);
      }

      if (event !== "workflow_run") {
        return json({ ignored: true, reason: `event=${event}` }, 202);
      }

      const payload = JSON.parse(rawBody) as WorkflowRunPayload;
      if (payload.action !== "completed") {
        return json({ ignored: true, reason: `action=${payload.action}` }, 202);
      }

      const installationId = payload.installation?.id;
      const run = payload.workflow_run;
      const repository = payload.repository;
      if (!installationId || !run?.id || !repository?.name || !repository.owner?.login) {
        return json({ error: "Missing required workflow_run fields" }, 400);
      }

      const owner = repository.owner.login;
      const repo = repository.name;
      const repoFullName = repository.full_name;
      const runId = run.id;
      const branch = run.head_branch;
      const prNumber = run.pull_requests?.[0]?.number;

      const appJwt = await createGitHubAppJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
      const installationToken = await createInstallationToken(
        installationId,
        appJwt,
        env.GITHUB_API_BASE,
      );

      const artifacts = await listRunArtifacts(
        owner,
        repo,
        runId,
        installationToken,
        env.GITHUB_API_BASE,
      );

      let patchCount = 0;
      for (const artifact of artifacts) {
        const zipBytes = await downloadArtifactZip(
          owner,
          repo,
          artifact.id,
          installationToken,
          env.GITHUB_API_BASE,
        );
        const entries = unzipSync(new Uint8Array(zipBytes));

        for (const [path, bytes] of Object.entries(entries)) {
          if (!path.endsWith(".patch")) {
            continue;
          }

          const context: PatchProcessingContext = {
            repoFullName,
            owner,
            repo,
            workflowRunId: runId,
            workflowName: run.name,
            branch,
            prNumber,
            artifactId: artifact.id,
            artifactName: artifact.name,
            patchPath: path,
          };

          await processPatch(context, {
            filename: path,
            content: strFromU8(bytes),
          });
          patchCount += 1;
        }
      }

      return json({
        ok: true,
        repository: repoFullName,
        workflowRunId: runId,
        branch: branch ?? null,
        prNumber: prNumber ?? null,
        artifactsScanned: artifacts.length,
        patchesProcessed: patchCount,
      });
    } catch (error) {
      return json(
        {
          error: "Webhook processing failed",
          detail: error instanceof Error ? error.message : String(error),
        },
        500,
      );
    }
  },
};

async function verifyWebhookSignature(
  body: string,
  receivedSignature: string | null,
  secret: string,
): Promise<boolean> {
  if (!receivedSignature?.startsWith("sha256=")) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = `sha256=${toHex(new Uint8Array(digest))}`;
  return timingSafeEqual(expected, receivedSignature);
}

async function createGitHubAppJwt(appId: string, privateKeyPem: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await importPkcs8PrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function importPkcs8PrivateKey(pem: string): Promise<CryptoKey> {
  const cleaned = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replaceAll(/\s+/g, "");
  const der = Uint8Array.from(atob(cleaned), (c) => c.charCodeAt(0));

  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

async function createInstallationToken(
  installationId: number,
  appJwt: string,
  apiBase = "https://api.github.com",
): Promise<string> {
  const res = await fetch(`${apiBase}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cf-github-app-webhook",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed creating installation token: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { token: string };
  if (!data.token) {
    throw new Error("Installation token missing in response");
  }
  return data.token;
}

async function listRunArtifacts(
  owner: string,
  repo: string,
  runId: number,
  token: string,
  apiBase = "https://api.github.com",
): Promise<Array<{ id: number; name: string }>> {
  const artifacts: Array<{ id: number; name: string }> = [];
  let page = 1;

  while (true) {
    const url = new URL(`${apiBase}/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "cf-github-app-webhook",
      },
    });
    if (!res.ok) {
      throw new Error(`Failed listing artifacts: ${res.status} ${await res.text()}`);
    }

    const data = (await res.json()) as {
      artifacts?: Array<{ id: number; name: string; expired: boolean }>;
      total_count?: number;
    };
    const batch = (data.artifacts ?? [])
      .filter((a) => !a.expired)
      .map((a) => ({ id: a.id, name: a.name }));
    artifacts.push(...batch);

    if ((data.artifacts?.length ?? 0) < 100) {
      break;
    }
    page += 1;
  }

  return artifacts;
}

async function downloadArtifactZip(
  owner: string,
  repo: string,
  artifactId: number,
  token: string,
  apiBase = "https://api.github.com",
): Promise<ArrayBuffer> {
  const res = await fetch(`${apiBase}/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cf-github-app-webhook",
    },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`Failed downloading artifact ${artifactId}: ${res.status} ${await res.text()}`);
  }
  return res.arrayBuffer();
}

function base64UrlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
