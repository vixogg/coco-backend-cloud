/**
 * Utilitarios de alto rendimiento, control determinista de tamaño de payload,
 * caché en memoria del isolate e idempotencia para Supabase Edge Functions (Deno 2).
 */

export interface CachedDevice {
  id: string;
  adulto_mayor_id: string;
  nombre_adulto?: string;
  expiresAt: number;
}

export interface RedApoyoContact {
  usuario_app_id: string;
  rol: string | null;
  apodos_reconocimiento: string[] | null;
}

// Interfaces tipadas para las APIs nativas V8 en Deno 2 (Uint8Array <-> Base64)
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
   1. CODIFICACIÓN Y DECODIFICACIÓN BASE64 ULTRARRÁPIDA (NATIVA V8 + CHUNKED FALLBACK)
   ============================================================================ */

export function uint8ArrayToBase64Fast(bytes: Uint8Array): string {
  const typedBytes = bytes as Uint8ArrayWithNativeBase64;
  if (typeof typedBytes.toBase64 === "function") {
    return typedBytes.toBase64();
  }

  // Fallback por bloques de 32 KB (evita concatenación carácter por carácter O(N^2) en heap)
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
   2. LOGGER ESTRUCTURADO SEGURO (EVITA SERIALIZAR MEGABYTES DE BASE64 EN STDOUT)
   ============================================================================ */

export function logSafePayload(
  scope: string,
  event: string,
  payload: Record<string, unknown>,
): void {
  const safeCopy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (
      (key === "data" || key === "audio_respuesta_b64") &&
      typeof value === "string" &&
      value.length > 120
    ) {
      const approxBytes = Math.floor((value.length * 3) / 4);
      safeCopy[key] = `${value.slice(0, 24)}... [BASE64_OMITIDO chars=${value.length} ~bytes=${approxBytes}]`;
    } else {
      safeCopy[key] = value;
    }
  }
  console.log(`[${scope}] ${event}:`, JSON.stringify(safeCopy));
}

/* ============================================================================
   3. IDEMPOTENCIA L1 EN MEMORIA DEL ISOLATE (ANTI-TORMENTA DE REINTENTOS AWS IOT)
   ============================================================================ */

const L1_IDEMPOTENCY_MAP = new Map<string, number>();
const MAX_L1_CACHE_SIZE = 500;

export async function computeWebhookRequestHash(
  macAddress: string,
  tipoEvento: string,
  formatoPayload: string,
  data: string,
): Promise<string> {
  // Muestra de inicio, centro, fin y longitud total para hashear en < 0.2ms incluso con audios de 500 KB
  let sample = data;
  if (data.length > 1536) {
    const mid = Math.floor(data.length / 2);
    sample = `${data.slice(0, 512)}:${data.slice(mid - 256, mid + 256)}:${data.slice(-512)}:${data.length}`;
  }
  const rawKey = `${macAddress}|${tipoEvento}|${formatoPayload}|${sample}`;
  const encoded = new TextEncoder().encode(rawKey);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return uint8ArrayToBase64Fast(new Uint8Array(digest));
}

export function isDuplicateInMemoryL1(requestHash: string, ttlMs = 60_000): boolean {
  const now = Date.now();
  const expiresAt = L1_IDEMPOTENCY_MAP.get(requestHash);
  if (expiresAt !== undefined && expiresAt > now) {
    return true;
  }

  if (L1_IDEMPOTENCY_MAP.size >= MAX_L1_CACHE_SIZE) {
    for (const [k, exp] of L1_IDEMPOTENCY_MAP.entries()) {
      if (exp <= now) L1_IDEMPOTENCY_MAP.delete(k);
    }
  }

  L1_IDEMPOTENCY_MAP.set(requestHash, now + ttlMs);
  return false;
}

/* ============================================================================
   4. CACHÉ EN MEMORIA DEL ISOLATE PARA DISPOSITIVOS Y AUDIOS TTS ESTÁTICOS
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
  device: { id: string; adulto_mayor_id: string; nombre_adulto?: string },
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
    console.log(`[TTS CACHE HIT] Reutilizando audio en RAM (${cacheKey.slice(0, 35)}...)`);
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
   5. TRUNCAMIENTO SEMÁNTICO DE TEXTO POR ORACIONES PRE-TTS
   ============================================================================ */

export function truncateTextBySentences(text: string, maxChars = 240): string {
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

  const commaIdx = Math.max(slice.lastIndexOf("; "), slice.lastIndexOf(", "));
  if (commaIdx >= Math.floor(maxChars * 0.55)) {
    return `${slice.slice(0, commaIdx).trim()}.`;
  }

  const spaceIdx = slice.lastIndexOf(" ");
  if (spaceIdx > 0) {
    return `${slice.slice(0, spaceIdx).trim()}.`;
  }
  return `${slice}.`;
}

/* ============================================================================
   6. SALVAGUARDA BINARIA DE BYTES PARA MP3 Y WAV (LÍMITE 128 KB AWS IOT CORE)
   ============================================================================ */

const MPEG1_L3_BITRATES = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MPEG2_L3_BITRATES = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  0: [11025, 12000, 8000, 0], // MPEG 2.5
  2: [22050, 24000, 16000, 0], // MPEG 2 (usado por ElevenLabs mp3_22050_32)
  3: [44100, 48000, 32000, 0], // MPEG 1
};

/**
 * Garantiza que un buffer de audio binario (MP3 o WAV) nunca supere `maxBytes`
 * (por defecto 65 KB crudos ≈ 86.6 KB en Base64, o 94 KB crudos ≈ 125 KB en Base64 para WAV),
 * evitando el error HTTP 413 Payload Too Large de AWS IoT Core (límite duro 128 KB)
 * sin corromper la estructura del archivo.
 */
export function ensureSafeAudioPayloadSize(
  audioBytes: Uint8Array,
  maxBytes = 65_000,
): Uint8Array {
  const totalLen = audioBytes.byteLength;
  if (totalLen <= maxBytes) {
    return audioBytes;
  }

  console.warn(
    `[PAYLOAD GUARD] Audio binario (${totalLen} bytes) excede el umbral seguro (${maxBytes} bytes). Ajustando en límite de frame/muestra...`,
  );

  // Caso A: Archivo RIFF/WAV ("RIFF" ... "WAVE")
  if (
    totalLen > 44 &&
    audioBytes[0] === 0x52 && // 'R'
    audioBytes[1] === 0x49 && // 'I'
    audioBytes[2] === 0x46 && // 'F'
    audioBytes[3] === 0x46 && // 'F'
    audioBytes[8] === 0x57 && // 'W'
    audioBytes[9] === 0x41 && // 'A'
    audioBytes[10] === 0x56 && // 'V'
    audioBytes[11] === 0x45 // 'E'
  ) {
    // Alinear el corte de datos PCM a múltiplo de 4 bytes después de los 44 bytes de cabecera WAV
    const safeDataBytes = Math.floor((maxBytes - 44) / 4) * 4;
    const newTotalLen = 44 + Math.max(0, safeDataBytes);
    const wavCopy = new Uint8Array(newTotalLen);
    wavCopy.set(audioBytes.subarray(0, newTotalLen));

    const view = new DataView(wavCopy.buffer, wavCopy.byteOffset, wavCopy.byteLength);
    // Actualizar ChunkSize (offset 4) = fileSize - 8
    view.setUint32(4, newTotalLen - 8, true);
    // Actualizar Subchunk2Size (offset 40) = dataSize ( si el subchunk 'data' está en la posición estándar 36 )
    if (
      wavCopy[36] === 0x64 && // 'd'
      wavCopy[37] === 0x61 && // 'a'
      wavCopy[38] === 0x74 && // 't'
      wavCopy[39] === 0x61 // 'a'
    ) {
      view.setUint32(40, newTotalLen - 44, true);
    }
    return wavCopy;
  }

  // Caso B: Stream MP3 (MPEG-1 / MPEG-2 / MPEG-2.5 Layer III)
  let offset = 0;
  if (
    totalLen > 10 &&
    audioBytes[0] === 0x49 && // 'I'
    audioBytes[1] === 0x44 && // 'D'
    audioBytes[2] === 0x33 // '3'
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

    // Sync word de 11 bits: 0xFF y (b1 & 0xE0) === 0xE0
    if (b0 === 0xff && (b1 & 0xe0) === 0xe0) {
      const versionId = (b1 >> 3) & 0x03;
      const layer = (b1 >> 1) & 0x03; // 1 = Layer III
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

  // Fallback general alineado a 4 bytes
  const alignedMax = Math.floor(maxBytes / 4) * 4;
  return audioBytes.subarray(0, alignedMax);
}

/* ============================================================================
   7. RESOLUCIÓN DIFUSA DE CONTACTOS EN RED DE APOYO (INSENSIBLE A TILDES/MAYÚSCULAS)
   ============================================================================ */

export function normalizeSpanishText(input: string | null | undefined): string {
  if (!input) return "";
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function findBestContactMatch(
  contacts: RedApoyoContact[],
  destinatarioIdentificado: string | null | undefined,
): string | null {
  const queryNorm = normalizeSpanishText(destinatarioIdentificado);
  if (!queryNorm || !contacts || contacts.length === 0) return null;

  // Paso 1: Coincidencia exacta en rol o en cualquiera de los apodos
  for (const c of contacts) {
    const rolNorm = normalizeSpanishText(c.rol);
    if (rolNorm && rolNorm === queryNorm) {
      return c.usuario_app_id;
    }
    const apodos = c.apodos_reconocimiento ?? [];
    for (const apodo of apodos) {
      const apodoNorm = normalizeSpanishText(apodo);
      if (apodoNorm && apodoNorm === queryNorm) {
        return c.usuario_app_id;
      }
    }
  }

  // Paso 2: Coincidencia parcial (ej. "mi hija María" contiene "maria" o "hija")
  for (const c of contacts) {
    const apodos = c.apodos_reconocimiento ?? [];
    for (const apodo of apodos) {
      const apodoNorm = normalizeSpanishText(apodo);
      if (
        apodoNorm &&
        (queryNorm.includes(apodoNorm) || apodoNorm.includes(queryNorm))
      ) {
        return c.usuario_app_id;
      }
    }
    const rolNorm = normalizeSpanishText(c.rol);
    if (
      rolNorm &&
      (queryNorm.includes(rolNorm) || rolNorm.includes(queryNorm))
    ) {
      return c.usuario_app_id;
    }
  }

  return null;
}

/* ============================================================================
   8. EJECUCIÓN SEGURA EN SEGUNDO PLANO (EdgeRuntime.waitUntil)
   ============================================================================ */

declare const EdgeRuntime: {
  waitUntil?: (promise: Promise<unknown>) => void;
} | undefined;

export function runInBackground(promise: Promise<unknown>, taskName: string): void {
  const safePromise = promise.catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[BACKGROUND ERROR][${taskName}]: ${msg}`);
  });

  if (
    typeof EdgeRuntime !== "undefined" &&
    EdgeRuntime !== null &&
    typeof EdgeRuntime.waitUntil === "function"
  ) {
    EdgeRuntime.waitUntil(safePromise);
  }
}

