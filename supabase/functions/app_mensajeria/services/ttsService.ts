const POLLY_ENDPOINT = "https://polly.{region}.amazonaws.com/v1/speech";

export async function synthesizeSpeech(text: string): Promise<Uint8Array> {
  const region = Deno.env.get("AWS_REGION");
  const accessKeyId = Deno.env.get("AWS_ACCESS_KEY_ID");
  const secretAccessKey = Deno.env.get("AWS_SECRET_ACCESS_KEY");
  const voiceId = Deno.env.get("POLLY_VOICE_ID");
  const outputFormat = Deno.env.get("POLLY_OUTPUT_FORMAT") ?? "mp3";
  const timeoutMs = parseInt(Deno.env.get("POLLY_TIMEOUT_MS") ?? "10000", 10);

  if (!region) throw new TTSServiceError("AWS_REGION is not configured");
  if (!accessKeyId)
    throw new TTSServiceError("AWS_ACCESS_KEY_ID is not configured");
  if (!secretAccessKey)
    throw new TTSServiceError("AWS_SECRET_ACCESS_KEY is not configured");
  if (!voiceId) throw new TTSServiceError("POLLY_VOICE_ID is not configured");

  const url = POLLY_ENDPOINT.replace("{region}", region);
  const body = JSON.stringify({
    Text: text,
    TextType: "text",
    OutputFormat: outputFormat,
    VoiceId: voiceId,
    LanguageCode: "es-MX",
  });

  const now = new Date();
  const headers = await signRequest({
    method: "POST",
    url,
    body,
    region,
    service: "polly",
    accessKeyId,
    secretAccessKey,
    now,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `[polly] HTTP ${response.status} ${response.statusText}\n` +
          `[polly] Region: ${region} | VoiceId: ${voiceId} | OutputFormat: ${outputFormat}\n` +
          `[polly] Body: ${errorBody}`,
      );
      throw new TTSServiceError(
        `Polly returned HTTP ${response.status} (${response.statusText}): ${errorBody}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  } catch (error) {
    if (error instanceof TTSServiceError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      console.error(`[polly] Request timed out after ${timeoutMs}ms`);
      throw new TTSServiceError(`Polly request timed out after ${timeoutMs}ms`);
    }
    console.error(
      `[polly] Request failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    throw new TTSServiceError(
      `Polly request failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

interface SignRequestParams {
  method: string;
  url: string;
  body: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: Date;
}

export async function signRequest(
  params: SignRequestParams,
): Promise<Record<string, string>> {
  const {
    method,
    url,
    body,
    region,
    service,
    accessKeyId,
    secretAccessKey,
    now,
  } = params;

  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname;
  const path = parsedUrl.pathname;

  const dateStamp = formatDateStamp(now);
  const amzDate = formatAmzDate(now);

  const payloadHash = await sha256Hex(body);

  const canonicalHeaders = [
    `content-type:application/json`,
    `host:${hostname}`,
    `x-amz-date:${amzDate}`,
    `x-amz-target:XAmazonPollySynthesizeSpeech`,
  ].join("\n");

  const signedHeaders = [
    "content-type",
    "host",
    "x-amz-date",
    "x-amz-target",
  ].join(";");

  const canonicalRequest = [
    method,
    path,
    "",
    canonicalHeaders,
    "",
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = await getSignatureKey(
    secretAccessKey,
    dateStamp,
    region,
    service,
  );
  const signature = await hmacSha256Hex(signingKey, stringToSign);

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    Authorization: authorization,
    "X-Amz-Date": amzDate,
    "X-Amz-Target": "XAmazonPollySynthesizeSpeech",
  };
}

function formatDateStamp(date: Date): string {
  return (
    date.getUTCFullYear().toString() +
    pad(date.getUTCMonth() + 1) +
    pad(date.getUTCDate())
  );
}

function formatAmzDate(date: Date): string {
  return (
    formatDateStamp(date) +
    "T" +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    "Z"
  );
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

async function sha256Hex(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
  return bufferToHex(hashBuffer);
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array): ArrayBuffer {
  const source = value instanceof Uint8Array ? value : new Uint8Array(value);
  const copy = new ArrayBuffer(source.byteLength);
  new Uint8Array(copy).set(source);
  return copy;
}

async function hmacSha256(
  key: ArrayBuffer | Uint8Array,
  data: string,
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const keyBuffer = toArrayBuffer(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, dataBuffer);
}

async function hmacSha256Hex(
  key: ArrayBuffer | Uint8Array,
  data: string,
): Promise<string> {
  const result = await hmacSha256(key, data);
  return bufferToHex(result);
}

function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getSignatureKey(
  key: string,
  dateStamp: string,
  region: string,
  service: string,
): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  const kDate = await hmacSha256(encoder.encode("AWS4" + key), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  return hmacSha256(kService, "aws4_request");
}

export class TTSServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TTSServiceError";
  }
}
