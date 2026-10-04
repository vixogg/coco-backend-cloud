const ELEVENLABS_API_BASE = "https://api.elevenlabs.io/v1";

export async function synthesizeSpeech(text: string): Promise<Uint8Array> {
  const apiKey = Deno.env.get("ELEVENLABS_API_KEY");
  const voiceId = Deno.env.get("ELEVENLABS_VOICE_ID");
  const modelId = Deno.env.get("ELEVENLABS_MODEL_ID") ?? "eleven_v4_turbo";
  const timeoutMs = parseInt(Deno.env.get("ELEVENLABS_TIMEOUT_MS") ?? "10000", 10);

  if (!apiKey) throw new TTSServiceError("ELEVENLABS_API_KEY is not configured");
  if (!voiceId) throw new TTSServiceError("ELEVENLABS_VOICE_ID is not configured");

  const url = `${ELEVENLABS_API_BASE}/text-to-speech/${voiceId}?output_format=mp3_44100_128`;

  const body = JSON.stringify({
    text,
    model_id: modelId,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(
        `[elevenlabs] HTTP ${response.status} ${response.statusText}\n` +
        `[elevenlabs] VoiceId: ${voiceId} | ModelId: ${modelId}\n` +
        `[elevenlabs] Body: ${errorBody}`
      );
      throw new TTSServiceError(
        `ElevenLabs returned HTTP ${response.status} (${response.statusText}): ${errorBody}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength === 0) {
      throw new TTSServiceError("ElevenLabs returned empty audio");
    }

    return new Uint8Array(arrayBuffer);
  } catch (error) {
    if (error instanceof TTSServiceError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      console.error(`[elevenlabs] Request timed out after ${timeoutMs}ms`);
      throw new TTSServiceError(
        `ElevenLabs request timed out after ${timeoutMs}ms`
      );
    }
    console.error(
      `[elevenlabs] Request failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
    throw new TTSServiceError(
      `ElevenLabs request failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

export class TTSServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TTSServiceError";
  }
}
