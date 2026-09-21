import {
  GeminiResponse,
  IntencionDetectada,
  PrioridadSugerida,
  TipoEvento,
} from "../types.ts";

const VALID_INTENCIONES: IntencionDetectada[] = [
  "MENSAJE",
  "ALERTA_SOS",
  "RECORDATORIO",
  "AUDIO_DIRECTO",
];
const VALID_PRIORIDADES: PrioridadSugerida[] = ["NORMAL", "URGENTE"];

const SYSTEM_PROMPT = `Eres el asistente de voz de COCO, un dispositivo IoT orientado a adultos mayores en Chile.
Responde exclusivamente con JSON válido según el esquema proporcionado.
Tono proactivo, empático y natural para un adulto mayor chileno.
Respuestas breves y adecuadas para ser sintetizadas por voz.
No inventar destinatarios, nombres, fechas ni información ausente.
Identificar posibles emergencias como ALERTA_SOS.
No incluir Markdown, explicaciones ni texto fuera del JSON.`;

const RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    intencion_detectada: {
      type: "STRING",
      enum: ["MENSAJE", "ALERTA_SOS", "RECORDATORIO", "AUDIO_DIRECTO"],
    },
    destinatario_identificado: {
      type: "STRING",
      nullable: true,
    },
    prioridad_sugerida: {
      type: "STRING",
      enum: ["NORMAL", "URGENTE"],
    },
    respuesta_sintetizada: {
      type: "STRING",
    },
  },
  required: [
    "intencion_detectada",
    "destinatario_identificado",
    "prioridad_sugerida",
    "respuesta_sintetizada",
  ],
};

function getApiKey(): string {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    throw new GeminiConfigError("GEMINI_API_KEY is not configured");
  }
  return apiKey;
}

function getApiVersion(): string {
  return (Deno.env.get("GEMINI_API_VERSION") ?? "v1beta").trim();
}

function normalizeModelName(raw: string): string {
  let model = raw.trim();
  model = model.replace(/^['"]+|['"]+$/g, "");
  model = model.replace(/^models\//, "");
  return model;
}

function getModel(): string {
  const raw = Deno.env.get("GEMINI_MODEL");
  if (!raw) {
    throw new GeminiConfigError("GEMINI_MODEL is not configured");
  }
  return normalizeModelName(raw);
}

function buildUrl(
  apiVersion: string,
  model: string,
  action: string,
  apiKey: string
): string {
  return `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:${action}?key=${apiKey}`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + "...(truncated)";
}

interface GeminiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

function parseGeminiError(body: string): GeminiErrorBody {
  try {
    return JSON.parse(body) as GeminiErrorBody;
  } catch {
    return {};
  }
}

export async function diagnoseGeminiModels(): Promise<string[]> {
  const apiKey = getApiKey();
  const apiVersion = getApiVersion();
  const timeoutMs = parseInt(Deno.env.get("GEMINI_TIMEOUT_MS") ?? "10000", 10);

  const url = `https://generativelanguage.googleapis.com/${apiVersion}/models?key=${apiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const parsed = parseGeminiError(errorBody);
      console.error(
        `[gemini-diag] Failed to list models: HTTP ${response.status} - ${parsed.error?.message ?? "unknown"}`
      );
      return [];
    }

    const result = await response.json() as {
      models?: Array<{
        name: string;
        supportedGenerationMethods?: string[];
      }>;
    };

    if (!result.models) {
      return [];
    }

    const generateContentModels = result.models
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""));

    console.error(`[gemini-diag] Available models (${generateContentModels.length}):`);
    for (const name of generateContentModels) {
      console.error(`[gemini-diag]   - ${name}`);
    }

    const configured = getModel();
    const exactMatch = generateContentModels.includes(configured);
    if (!exactMatch) {
      console.error(
        `[gemini-diag] WARNING: Configured model "${configured}" NOT found in available models.`
      );
    } else {
      console.error(
        `[gemini-diag] Configured model "${configured}" is available.`
      );
    }

    return generateContentModels;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      console.error("[gemini-diag] Timeout listing models");
    } else {
      console.error(
        `[gemini-diag] Error listing models: ${error instanceof Error ? error.message : "unknown"}`
      );
    }
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function classifyTranscription(
  transcription: string,
  macAddress: string,
  tipoEvento: TipoEvento
): Promise<GeminiResponse> {
  const apiKey = getApiKey();
  const model = getModel();
  const apiVersion = getApiVersion();
  const timeoutMs = parseInt(Deno.env.get("GEMINI_TIMEOUT_MS") ?? "10000", 10);

  const userMessage = buildUserMessage(transcription, macAddress, tipoEvento);

  const requestBody = {
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }],
    },
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.3,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = buildUrl(apiVersion, model, "generateContent", apiKey);

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const parsed = parseGeminiError(errorBody);
      const status = response.status;
      const message = parsed.error?.message ?? "unknown";
      const errorCode = parsed.error?.status ?? "UNKNOWN";

      console.error(
        `[gemini] HTTP ${status} (${errorCode}) | model=${model} | apiVersion=${apiVersion} | message=${message} | body=${truncate(errorBody, 500)}`
      );

      if (status === 404) {
        const availableModels = await diagnoseGeminiModels();
        throw new GeminiModelNotFoundError(model, apiVersion, availableModels);
      }

      if (status === 400) {
        throw new GeminiBadRequestError(message);
      }

      if (status === 401 || status === 403) {
        throw new GeminiAuthError(message);
      }

      throw new GeminiError(`Gemini HTTP ${status}: ${message}`);
    }

    const result = await response.json();
    const text = extractTextFromGeminiResponse(result);
    const parsed = parseAndValidateResponse(text, tipoEvento);

    return parsed;
  } catch (error) {
    if (error instanceof GeminiServiceError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new GeminiTimeoutError(timeoutMs);
    }
    throw new GeminiError(
      `Gemini request failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildUserMessage(
  transcription: string,
  macAddress: string,
  tipoEvento: TipoEvento
): string {
  const parts = [
    `Transcripción del audio: "${transcription}"`,
    `Dirección MAC del dispositivo: ${macAddress}`,
    `Tipo de evento detectado por el dispositivo: ${tipoEvento}`,
  ];

  if (tipoEvento === "ALERTA_SOS") {
    parts.push(
      "IMPORTANTE: Este evento es una ALERTA SOS. La intencion_detectada debe ser ALERTA_SOS y la prioridad_sugerida debe ser URGENTE. No degradar esta alerta a otro tipo."
    );
  }

  return parts.join("\n");
}

function extractTextFromGeminiResponse(result: unknown): string {
  const r = result as Record<string, unknown>;
  const candidates = r.candidates as Array<Record<string, unknown>> | undefined;
  if (!candidates || candidates.length === 0) {
    throw new GeminiInvalidResponseError("Gemini returned no candidates");
  }

  const candidate = candidates[0];
  const content = candidate.content as Record<string, unknown> | undefined;
  if (!content) {
    throw new GeminiInvalidResponseError("Gemini returned no content");
  }

  const parts = content.parts as Array<Record<string, unknown>> | undefined;
  if (!parts || parts.length === 0) {
    throw new GeminiInvalidResponseError("Gemini returned no parts");
  }

  const text = parts[0].text;
  if (typeof text !== "string") {
    throw new GeminiInvalidResponseError("Gemini returned non-text part");
  }

  return text;
}

function parseAndValidateResponse(
  text: string,
  tipoEvento: TipoEvento
): GeminiResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiInvalidResponseError("Gemini response is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new GeminiInvalidResponseError("Gemini response is not an object");
  }

  const obj = parsed as Record<string, unknown>;

  if (!("intencion_detectada" in obj)) {
    throw new GeminiInvalidResponseError(
      "Gemini response missing 'intencion_detectada'"
    );
  }
  if (!("destinatario_identificado" in obj)) {
    throw new GeminiInvalidResponseError(
      "Gemini response missing 'destinatario_identificado'"
    );
  }
  if (!("prioridad_sugerida" in obj)) {
    throw new GeminiInvalidResponseError(
      "Gemini response missing 'prioridad_sugerida'"
    );
  }
  if (!("respuesta_sintetizada" in obj)) {
    throw new GeminiInvalidResponseError(
      "Gemini response missing 'respuesta_sintetizada'"
    );
  }

  const unexpectedKeys = Object.keys(obj).filter(
    (k) =>
      k !== "intencion_detectada" &&
      k !== "destinatario_identificado" &&
      k !== "prioridad_sugerida" &&
      k !== "respuesta_sintetizada"
  );
  if (unexpectedKeys.length > 0) {
    throw new GeminiInvalidResponseError(
      `Gemini response contains unexpected fields: ${unexpectedKeys.join(", ")}`
    );
  }

  if (!VALID_INTENCIONES.includes(obj.intencion_detectada as IntencionDetectada)) {
    throw new GeminiInvalidResponseError(
      `Invalid intencion_detectada: ${obj.intencion_detectada}`
    );
  }
  if (!VALID_PRIORIDADES.includes(obj.prioridad_sugerida as PrioridadSugerida)) {
    throw new GeminiInvalidResponseError(
      `Invalid prioridad_sugerida: ${obj.prioridad_sugerida}`
    );
  }
  if (
    obj.destinatario_identificado !== null &&
    typeof obj.destinatario_identificado !== "string"
  ) {
    throw new GeminiInvalidResponseError(
      `destinatario_identificado must be string or null, got ${typeof obj.destinatario_identificado}`
    );
  }
  if (typeof obj.respuesta_sintetizada !== "string") {
    throw new GeminiInvalidResponseError(
      `respuesta_sintetizada must be a string, got ${typeof obj.respuesta_sintetizada}`
    );
  }
  if ((obj.respuesta_sintetizada as string).trim().length === 0) {
    throw new GeminiInvalidResponseError(
      "respuesta_sintetizada must not be empty"
    );
  }

  if (tipoEvento === "ALERTA_SOS") {
    if (obj.intencion_detectada !== "ALERTA_SOS") {
      throw new GeminiInvalidResponseError(
        `ALERTA_SOS event forced intencion_detectada to ALERTA_SOS, got ${obj.intencion_detectada}`
      );
    }
    if (obj.prioridad_sugerida !== "URGENTE") {
      throw new GeminiInvalidResponseError(
        `ALERTA_SOS event forced prioridad_sugerida to URGENTE, got ${obj.prioridad_sugerida}`
      );
    }
  }

  return {
    intencion_detectada: obj.intencion_detectada as IntencionDetectada,
    destinatario_identificado: obj.destinatario_identificado as string | null,
    prioridad_sugerida: obj.prioridad_sugerida as PrioridadSugerida,
    respuesta_sintetizada: obj.respuesta_sintetizada as string,
  };
}

export class GeminiServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiServiceError";
  }
}

export class GeminiConfigError extends GeminiServiceError {
  constructor(message: string) {
    super(message);
    this.name = "GeminiConfigError";
  }
}

export class GeminiAuthError extends GeminiServiceError {
  constructor(message: string) {
    super(message);
    this.name = "GeminiAuthError";
  }
}

export class GeminiModelNotFoundError extends GeminiServiceError {
  model: string;
  apiVersion: string;
  availableModels: string[];

  constructor(model: string, apiVersion: string, availableModels: string[]) {
    super(
      `Model "${model}" not found (API ${apiVersion}). ` +
        `Available generateContent models: [${availableModels.join(", ")}]`
    );
    this.name = "GeminiModelNotFoundError";
    this.model = model;
    this.apiVersion = apiVersion;
    this.availableModels = availableModels;
  }
}

export class GeminiBadRequestError extends GeminiServiceError {
  constructor(message: string) {
    super(message);
    this.name = "GeminiBadRequestError";
  }
}

export class GeminiTimeoutError extends GeminiServiceError {
  constructor(timeoutMs: number) {
    super(`Gemini request timed out after ${timeoutMs}ms`);
    this.name = "GeminiTimeoutError";
  }
}

export class GeminiInvalidResponseError extends GeminiServiceError {
  constructor(message: string) {
    super(message);
    this.name = "GeminiInvalidResponseError";
  }
}

export class GeminiError extends GeminiServiceError {
  constructor(message: string) {
    super(message);
    this.name = "GeminiError";
  }
}
