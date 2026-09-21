const DEEPGRAM_API_URL = "https://api.deepgram.com/v1/listen";

function uint8ArrayToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function transcribeAudio(audio: Uint8Array): Promise<string> {
  const apiKey = Deno.env.get("DEEPGRAM_API_KEY");
  if (!apiKey) {
    throw new DeepgramServiceError("DEEPGRAM_API_KEY is not configured");
  }

  const contentType = Deno.env.get("DEEPGRAM_CONTENT_TYPE") ?? "audio/wav";
  const timeoutMs = parseInt(
    Deno.env.get("DEEPGRAM_TIMEOUT_MS") ?? "10000",
    10
  );

  const params = new URLSearchParams();
  const encoding = Deno.env.get("DEEPGRAM_ENCODING");
  const sampleRate = Deno.env.get("DEEPGRAM_SAMPLE_RATE");
  const channels = Deno.env.get("DEEPGRAM_CHANNELS");
  const language = Deno.env.get("DEEPGRAM_LANGUAGE") ?? "es";

  if (encoding) params.set("encoding", encoding);
  if (sampleRate) params.set("sample_rate", sampleRate);
  if (channels) params.set("channels", channels);
  params.set("language", language);
  params.set("model", Deno.env.get("DEEPGRAM_MODEL") ?? "nova-2");

  const url = `${DEEPGRAM_API_URL}?${params.toString()}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const requestBody = uint8ArrayToArrayBuffer(audio);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Token ${apiKey}`,
        "Content-Type": contentType,
      },
      body: requestBody,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new DeepgramServiceError(
        `Deepgram returned status ${response.status}: ${errorBody}`
      );
    }

    const result = await response.json();

    const channels = result?.results?.channels;
    if (!channels || channels.length === 0) {
      throw new DeepgramServiceError("Deepgram returned no channels");
    }

    const alternatives = channels[0]?.alternatives;
    if (!alternatives || alternatives.length === 0) {
      throw new DeepgramServiceError("Deepgram returned no alternatives");
    }

    const transcript = alternatives[0]?.transcript;
    if (typeof transcript !== "string" || transcript.trim().length === 0) {
      throw new DeepgramServiceError("Deepgram returned empty transcript");
    }

    return transcript.trim();
  } catch (error) {
    if (error instanceof DeepgramServiceError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new DeepgramServiceError(
        `Deepgram request timed out after ${timeoutMs}ms`
      );
    }
    throw new DeepgramServiceError(
      `Deepgram request failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export class DeepgramServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepgramServiceError";
  }
}
