/**
 * Utilitarios de alto rendimiento, control determinista de tamaño de payload
 * y caché en memoria del isolate para app_mensajeria (Deno 2).
 */

export interface CachedDevice {
  id: string;
  adulto_mayor_id: string;
  nombre_adulto: string;
  expiresAt: number;
}

interface Uint8ArrayWithNativeBase64 extends Uint8Array {
  toBase64?: (options?: { alphabet?: "base64" | "base64url"; omitPadding?: boolean }) => string;
}

interface Uint8ArrayConstructorWithNativeBase64 {
  fromBase64?: (
    base64String: string,
    options?: { alphabet?: "base64" | "base64url" },
  ) => Uint8Array;
}

/* ============================================================================
   1. CODIFICACIÓN BASE64 ULTRARRÁPIDA (NATIVA V8 + CHUNKED FALLBACK)
   ============================================================================ */

export function uint8ArrayToBase64Fast(bytes: Uint8Array): string {
  const typedBytes = bytes as Uint8ArrayWithNativeBase64;
  if (typeof typedBytes.toBase64 === "function") {
    return typedBytes.toBase64();
  }

  const CHUNK_SIZE = 0x8000;
  const chunks: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
    const sub = bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.byteLength));
    chunks.push(String.fromCharCode.apply(null, sub as unknown as number[]));
  }
  return btoa(chunks.join(""));
}

export function decodeBase64ToUint8ArrayFast(base64String: string): Uint8Array {
  const cleanB64 = base64String.includes(",")
    ? base64String.slice(base64String.indexOf(",") + 1).trim()
    : base64String.trim();

  const ctor = Uint8Array as unknown as Uint8ArrayConstructorWithNativeBase64;
  if (typeof ctor.fromBase64 === "function") {
    return ctor.fromBase64(cleanB64);
  }

  const binaryString = atob(cleanB64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/* ============================================================================
   2. LOGGER ESTRUCTURADO SEGURO
   ============================================================================ */

export function logSafePayload(
  scope: string,
  event: string,
  payload: Record<string, unknown>,
): void {
  const safeCopy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "data" && typeof value === "string" && value.length > 120) {
      const approxBytes = Math.floor((value.length * 3) / 4);
      safeCopy[key] = `${value.slice(0, 24)}... [BASE64_OMITIDO chars=${value.length} ~bytes=${approxBytes}]`;
    } else {
      safeCopy[key] = value;
    }
  }
  console.log(`[${scope}] ${event}:`, JSON.stringify(safeCopy));
}

/* ============================================================================
   3. CACHÉ EN MEMORIA DEL ISOLATE PARA DISPOSITIVOS E INTROS TTS
   ============================================================================ */

const DEVICE_CACHE = new Map<string, CachedDevice>();
const DEVICE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

export function getCachedDevice(macAddress: string): CachedDevice | null {
  const entry = DEVICE_CACHE.get(macAddress);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    DEVICE_CACHE.delete(macAddress);
    return null;
  }
  return entry;
}

export function setCachedDevice(
  macAddress: string,
  device: { id: string; adulto_mayor_id: string; nombre_adulto: string },
): void {
  DEVICE_CACHE.set(macAddress, {
    ...device,
    expiresAt: Date.now() + DEVICE_CACHE_TTL_MS,
  });
}

const TTS_B64_CACHE = new Map<string, string>();
const MAX_TTS_CACHE_ITEMS = 60;

export async function getOrSynthesizeTtsBase64(
  text: string,
  synthesizeFn: (txt: string) => Promise<Uint8Array>,
  maxRawBytes = 65_000,
): Promise<string> {
  const cacheKey = text.trim();
  const cached = TTS_B64_CACHE.get(cacheKey);
  if (cached) {
    console.log(`[TTS CACHE HIT] Reutilizando intro en RAM: "${cacheKey}"`);
    return cached;
  }

  const rawAudio = await synthesizeFn(cacheKey);
  const safeAudio = ensureSafeAudioPayloadSize(rawAudio, maxRawBytes);
  const b64 = uint8ArrayToBase64Fast(safeAudio);

  if (TTS_B64_CACHE.size >= MAX_TTS_CACHE_ITEMS) {
    const oldestKey = TTS_B64_CACHE.keys().next().value;
    if (oldestKey) TTS_B64_CACHE.delete(oldestKey);
  }
  TTS_B64_CACHE.set(cacheKey, b64);
  return b64;
}

/* ============================================================================
   4. TRUNCAMIENTO SEMÁNTICO Y SALVAGUARDA BINARIA DE PAYLOAD (MP3 / WAV)
   ============================================================================ */

export function truncateTextBySentences(text: string, maxChars = 320): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;

  const slice = clean.slice(0, maxChars);
  const sentenceMatch = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("."),
    slice.lastIndexOf("!"),
    slice.lastIndexOf("?"),
  );

  if (sentenceMatch >= Math.floor(maxChars * 0.4)) {
    return slice.slice(0, sentenceMatch + 1).trim();
  }

  const spaceIdx = slice.lastIndexOf(" ");
  if (spaceIdx > 0) {
    return `${slice.slice(0, spaceIdx).trim()}.`;
  }
  return `${slice}.`;
}

const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  0: [11025, 12000, 8000, 0],
  2: [22050, 24000, 16000, 0],
  3: [44100, 48000, 32000, 0],
};

export function ensureSafeAudioPayloadSize(
  audioBytes: Uint8Array,
  maxBytes = 94_000,
): Uint8Array {
  const totalLen = audioBytes.byteLength;
  if (totalLen <= maxBytes) {
    return audioBytes;
  }

  console.warn(
    `[PAYLOAD GUARD] Audio binario (${totalLen} bytes) supera el límite seguro (${maxBytes} bytes). Ajustando en límite de frame/muestra...`,
  );

  // Caso A: Archivo RIFF/WAV ("RIFF" ... "WAVE")
  if (
    totalLen > 44 &&
    audioBytes[0] === 0x52 &&
    audioBytes[1] === 0x49 &&
    audioBytes[2] === 0x46 &&
    audioBytes[3] === 0x46 &&
    audioBytes[8] === 0x57 &&
    audioBytes[9] === 0x41 &&
    audioBytes[10] === 0x56 &&
    audioBytes[11] === 0x45
  ) {
    const safeDataBytes = Math.floor((maxBytes - 44) / 4) * 4;
    const newTotalLen = 44 + Math.max(0, safeDataBytes);
    const wavCopy = new Uint8Array(newTotalLen);
    wavCopy.set(audioBytes.subarray(0, newTotalLen));

    const view = new DataView(wavCopy.buffer, wavCopy.byteOffset, wavCopy.byteLength);
    view.setUint32(4, newTotalLen - 8, true);
    if (
      wavCopy[36] === 0x64 &&
      wavCopy[37] === 0x61 &&
      wavCopy[38] === 0x74 &&
      wavCopy[39] === 0x61
    ) {
      view.setUint32(40, newTotalLen - 44, true);
    }
    return wavCopy;
  }

  // Caso B: Stream MP3
  let offset = 0;
  if (
    totalLen > 10 &&
    audioBytes[0] === 0x49 &&
    audioBytes[1] === 0x44 &&
    audioBytes[2] === 0x33
  ) {
    const id3Size =
      ((audioBytes[6] & 0x7f) << 21) |
      ((audioBytes[7] & 0x7f) << 14) |
      ((audioBytes[8] & 0x7f) << 7) |
      (audioBytes[9] & 0x7f);
    offset = 10 + id3Size;
  }

  let lastValidFrameEnd = 0;

  while (offset < totalLen - 4) {
    const b0 = audioBytes[offset];
    const b1 = audioBytes[offset + 1];

    if (b0 === 0xff && (b1 & 0xe0) === 0xe0) {
      const versionId = (b1 >> 3) & 0x03;
      const layer = (b1 >> 1) & 0x03;
      const b2 = audioBytes[offset + 2];
      const bitrateIdx = (b2 >> 4) & 0x0f;
      const srIdx = (b2 >> 2) & 0x03;
      const padding = (b2 >> 1) & 0x01;

      if (
        versionId !== 1 &&
        layer === 1 &&
        bitrateIdx > 0 &&
        bitrateIdx < 15 &&
        srIdx < 3
      ) {
        const bitrateKbps = versionId === 3
          ? MPEG1_L3_BITRATES[bitrateIdx]
          : MPEG2_L3_BITRATES[bitrateIdx];
        const sampleRate = SAMPLE_RATES[versionId]?.[srIdx] ?? 0;

        if (bitrateKbps > 0 && sampleRate > 0) {
          const coeff = versionId === 3 ? 144 : 72;
          const frameLen = Math.floor((coeff * bitrateKbps * 1000) / sampleRate) + padding;

          if (frameLen > 24 && offset + frameLen <= totalLen) {
            if (offset + frameLen > maxBytes) {
              break;
            }
            lastValidFrameEnd = offset + frameLen;
            offset += frameLen;
            continue;
          }
        }
      }
    }
    offset += 1;
  }

  if (lastValidFrameEnd > 0) {
    return audioBytes.subarray(0, lastValidFrameEnd);
  }

  const alignedMax = Math.floor(maxBytes / 4) * 4;
  return audioBytes.subarray(0, alignedMax);
}

