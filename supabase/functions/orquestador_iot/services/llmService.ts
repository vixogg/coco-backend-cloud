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

const SYSTEM_PROMPT = `Eres el asistente de voz de COCO, un dispositivo IoT de hardware (altavoz inteligente) orientado a adultos mayores en Chile. Tu rol es procesar los mensajes que el adulto mayor envía a través de COCO y generar respuestas apropiadas.

═══════════════════════════════════════════════════════
REGLAS GENERALES
═══════════════════════════════════════════════════════

1. Responde EXCLUSIVAMENTE con JSON válido según el esquema de abajo. NUNCA incluyas Markdown, explicaciones, backticks ni texto fuera del JSON.
2. Tono proactivo, empático y natural para un adulto mayor chileno. Usa "usted" y lenguaje cálido.
3. Respuestas breves y claras, pensadas para ser sintetizadas por voz. Máximo 2-3 oraciones.
4. No inventes destinatarios, nombres, fechas, medicamentos ni información que no esté en el mensaje del usuario.
5. No afirmes que un mensaje fue enviado o que familiares fueron notificados, a menos que el flujo confirme realmente esa acción. Evita prometer acciones que el backend no ejecutó.
6. Identifica posibles emergencias y responde con intencion_detectada "ALERTA_SOS" si detectas peligro, caída, dolor fuerte o pedido de ayuda urgente.

═══════════════════════════════════════════════════════
ESQUEMA JSON DE RESPUESTA
═══════════════════════════════════════════════════════

{
  "intencion_detectada": "<string>",
  "destinatario_identificado": "<string o null>",
  "prioridad_sugerida": "<string>",
  "respuesta_sintetizada": "<string: tu respuesta hablada>"
}

═══════════════════════════════════════════════════════
CAMPOS Y VALORES PERMITIDOS
═══════════════════════════════════════════════════════

intencion_detectada — Determina la intención del mensaje del adulto mayor:

  • "MENSAJE"
    → El adulto mayor quiere enviar un mensaje a un familiar o conocido.
    → Ejemplos: "Quiero mandarle un saludo a mi hija", "Dile que voy a almorzar".

  • "ALERTA_SOS"
    → Emergencia detectada. Se notifica inmediatamente a los familiares.
    → Usa esto cuando detectes caídas, dolor, pedido de auxilio o peligro.
    → prioridad_sugerida DEBE ser "URGENTE".

  • "RECORDATORIO"
    → El adulto mayor pide que le recuerden algo (medicamentos, citas, eventos).
    → Ejemplos: "Recuérdame tomar mi pastilla", "Avísame de mi cita mañana".

  • "AUDIO_DIRECTO"
    → El adulto mayor solicita enviar un audio como mensaje.
    → Ejemplos: "Quiero mandar un audio a mi nieto", "Envía mi voz a María".

destinatario_identificado — Nombre de la persona a la que va dirigido el mensaje. Devuelve null si no está explícito en el mensaje.

prioridad_sugerida:
  • "NORMAL" → Para conversación regular.
  • "URGENTE" → Para emergencias (ALERTA_SOS) o interrupciones importantes.

respuesta_sintetizada — Tu respuesta en texto plano. Será sintetizada a voz. No uses emojis, asteriscos ni formato.

═══════════════════════════════════════════════════════
EJEMPLOS
═══════════════════════════════════════════════════════

Entrada: "Quiero mandarle un mensaje a mi hija María"
Respuesta:
{
  "intencion_detectada": "MENSAJE",
  "destinatario_identificado": "María",
  "prioridad_sugerida": "NORMAL",
  "respuesta_sintetizada": "Por supuesto. Dígame, ¿qué le quiere decir a su hija María?"
}

Entrada: "Recuérdame tomar mi pastilla de la presión"
Respuesta:
{
  "intencion_detectada": "RECORDATORIO",
  "destinatario_identificado": null,
  "prioridad_sugerida": "NORMAL",
  "respuesta_sintetizada": "Listo. Le recuerdo tomar su pastilla de la presión. ¿A qué hora prefiere que se lo recuerde?"
}

Entrada: "Quiero mandar un audio a mi nieto"
Respuesta:
{
  "intencion_detectada": "AUDIO_DIRECTO",
  "destinatario_identificado": "nieto",
  "prioridad_sugerida": "NORMAL",
  "respuesta_sintetizada": "Perfecto. Voy a preparar el micrófono para que grabe su mensaje para el nieto."
}

Entrada: "Me caí y no me puedo levantar"
Respuesta:
{
  "intencion_detectada": "ALERTA_SOS",
  "destinatario_identificado": null,
  "prioridad_sugerida": "URGENTE",
  "respuesta_sintetizada": "Tranquilo, ya estoy avisando a su familia. No se mueva, la ayuda va en camino."
}

Entrada: "Hola COCO, ¿cómo estás?"
Respuesta:
{
  "intencion_detectada": "MENSAJE",
  "destinatario_identificado": null,
  "prioridad_sugerida": "NORMAL",
  "respuesta_sintetizada": "Hola, qué gusto saludarlo. Cuénteme, ¿en qué le puedo ayudar hoy?"
}`;

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

export function validateLLMResponse(
  raw: unknown,
  tipoEvento: TipoEvento
): GeminiResponse {
  if (typeof raw !== "object" || raw === null) {
    throw new LLMInvalidResponseError("LLM response is not an object");
  }

  const obj = raw as Record<string, unknown>;

  if (!("intencion_detectada" in obj)) {
    throw new LLMInvalidResponseError(
      "LLM response missing 'intencion_detectada'"
    );
  }
  if (!("destinatario_identificado" in obj)) {
    throw new LLMInvalidResponseError(
      "LLM response missing 'destinatario_identificado'"
    );
  }
  if (!("prioridad_sugerida" in obj)) {
    throw new LLMInvalidResponseError(
      "LLM response missing 'prioridad_sugerida'"
    );
  }
  if (!("respuesta_sintetizada" in obj)) {
    throw new LLMInvalidResponseError(
      "LLM response missing 'respuesta_sintetizada'"
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
    throw new LLMInvalidResponseError(
      `LLM response contains unexpected fields: ${unexpectedKeys.join(", ")}`
    );
  }

  if (!VALID_INTENCIONES.includes(obj.intencion_detectada as IntencionDetectada)) {
    throw new LLMInvalidResponseError(
      `Invalid intencion_detectada: ${obj.intencion_detectada}`
    );
  }
  if (!VALID_PRIORIDADES.includes(obj.prioridad_sugerida as PrioridadSugerida)) {
    throw new LLMInvalidResponseError(
      `Invalid prioridad_sugerida: ${obj.prioridad_sugerida}`
    );
  }
  if (
    obj.destinatario_identificado !== null &&
    typeof obj.destinatario_identificado !== "string"
  ) {
    throw new LLMInvalidResponseError(
      `destinatario_identificado must be string or null, got ${typeof obj.destinatario_identificado}`
    );
  }
  if (typeof obj.respuesta_sintetizada !== "string") {
    throw new LLMInvalidResponseError(
      `respuesta_sintetizada must be a string, got ${typeof obj.respuesta_sintetizada}`
    );
  }
  if ((obj.respuesta_sintetizada as string).trim().length === 0) {
    throw new LLMInvalidResponseError(
      "respuesta_sintetizada must not be empty"
    );
  }

  if (tipoEvento === "ALERTA_SOS") {
    if (obj.intencion_detectada !== "ALERTA_SOS") {
      throw new LLMInvalidResponseError(
        `ALERTA_SOS event forced intencion_detectada to ALERTA_SOS, got ${obj.intencion_detectada}`
      );
    }
    if (obj.prioridad_sugerida !== "URGENTE") {
      throw new LLMInvalidResponseError(
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

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen) + "...(truncated)";
}

function parseJSONBody(body: string): Record<string, unknown> {
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ── Gemini ────────────────────────────────────────────────────────────────────

function getGeminiApiKey(): string {
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    throw new LLMConfigError("GEMINI_API_KEY is not configured");
  }
  return apiKey;
}

function getGeminiApiVersion(): string {
  return (Deno.env.get("GEMINI_API_VERSION") ?? "v1beta").trim();
}

function normalizeModelName(raw: string): string {
  let model = raw.trim();
  model = model.replace(/^['\"]+|['\"]+$/g, "");
  model = model.replace(/^models\//, "");
  return model;
}

function getGeminiModel(): string {
  const raw = Deno.env.get("GEMINI_MODEL");
  if (!raw) {
    throw new LLMConfigError("GEMINI_MODEL is not configured");
  }
  return normalizeModelName(raw);
}

function buildGeminiUrl(
  apiVersion: string,
  model: string,
  action: string,
  apiKey: string
): string {
  return `https://generativelanguage.googleapis.com/${apiVersion}/models/${model}:${action}?key=${apiKey}`;
}

export async function diagnoseGeminiModels(): Promise<string[]> {
  const apiKey = getGeminiApiKey();
  const apiVersion = getGeminiApiVersion();
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
      const parsed = parseJSONBody(errorBody);
      const err = parsed.error as { message?: string } | undefined;
      console.error(
        `[gemini-diag] Failed to list models: HTTP ${response.status} - ${err?.message ?? "unknown"}`
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

    const configured = getGeminiModel();
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

function extractTextFromGeminiResponse(result: unknown): string {
  const r = result as Record<string, unknown>;
  const candidates = r.candidates as Array<Record<string, unknown>> | undefined;
  if (!candidates || candidates.length === 0) {
    throw new LLMInvalidResponseError("Gemini returned no candidates");
  }

  const candidate = candidates[0];
  const content = candidate.content as Record<string, unknown> | undefined;
  if (!content) {
    throw new LLMInvalidResponseError("Gemini returned no content");
  }

  const parts = content.parts as Array<Record<string, unknown>> | undefined;
  if (!parts || parts.length === 0) {
    throw new LLMInvalidResponseError("Gemini returned no parts");
  }

  const text = parts[0].text;
  if (typeof text !== "string") {
    throw new LLMInvalidResponseError("Gemini returned non-text part");
  }

  return text;
}

async function callGemini(
  transcription: string,
  macAddress: string,
  tipoEvento: TipoEvento
): Promise<GeminiResponse> {
  const apiKey = getGeminiApiKey();
  const model = getGeminiModel();
  const apiVersion = getGeminiApiVersion();
  const timeoutMs = parseInt(Deno.env.get("GEMINI_TIMEOUT_MS") ?? "45000", 10);
  const maxRetries = parseInt(Deno.env.get("GEMINI_MAX_RETRIES") ?? "3", 10);
  const retryDelayMs = parseInt(Deno.env.get("GEMINI_RETRY_DELAY_MS") ?? "2000", 10);

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

  const url = buildGeminiUrl(apiVersion, model, "generateContent", apiKey);
  const bodyJson = JSON.stringify(requestBody);

  let lastError: Error = new LLMError("No attempts performed");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      console.log(`[gemini] Attempt ${attempt}/${maxRetries} | model=${model} | timeout=${timeoutMs}ms`);

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyJson,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        const parsed = parseJSONBody(errorBody);
        const err = parsed.error as { message?: string; status?: string } | undefined;
        const status = response.status;
        const message = err?.message ?? "unknown";
        const errorCode = err?.status ?? "UNKNOWN";

        console.error(
          `[gemini] HTTP ${status} (${errorCode}) | attempt=${attempt}/${maxRetries} | model=${model} | apiVersion=${apiVersion} | message=${message} | body=${truncate(errorBody, 500)}`
        );

        if (status === 404) {
          const availableModels = await diagnoseGeminiModels();
          throw new LLMModelNotFoundError("gemini", model, apiVersion, availableModels);
        }
        if (status === 400) throw new LLMBadRequestError("gemini", message);
        if (status === 401 || status === 403) throw new LLMAuthError("gemini", message);

        if (status === 503 || status === 429) {
          lastError = new LLMError(`Gemini HTTP ${status} (${errorCode}): ${message}`);
          if (attempt < maxRetries) {
            console.warn(`[gemini] Transient error ${status}. Retrying in ${retryDelayMs}ms... (${attempt}/${maxRetries})`);
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            continue;
          }
          throw lastError;
        }

        throw new LLMError(`Gemini HTTP ${status}: ${message}`);
      }

      const result = await response.json();
      const text = extractTextFromGeminiResponse(result);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new LLMInvalidResponseError("Gemini response is not valid JSON");
      }

      const validated = validateLLMResponse(parsed, tipoEvento);

      if (attempt > 1) {
        console.log(`[gemini] Success on attempt ${attempt}/${maxRetries}.`);
      }
      return validated;

    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof LLMServiceError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        lastError = new LLMTimeoutError("gemini", timeoutMs);
        console.warn(`[gemini] Timeout (${timeoutMs}ms) on attempt ${attempt}/${maxRetries}.`);
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
          continue;
        }
        throw lastError;
      }
      throw new LLMError(
        `Gemini request failed: ${error instanceof Error ? error.message : "unknown error"}`
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError;
}

// ── Groq ──────────────────────────────────────────────────────────────────────

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

function getGroqApiKey(): string {
  const apiKey = Deno.env.get("GROQ_API_KEY");
  if (!apiKey) {
    throw new LLMConfigError("GROQ_API_KEY is not configured");
  }
  return apiKey;
}

function getGroqModel(): string {
  const raw = Deno.env.get("GROQ_MODEL");
  if (!raw) {
    throw new LLMConfigError("GROQ_MODEL is not configured");
  }
  return raw.trim().replace(/^['\"]+|['\"]+$/g, "");
}

async function callGroq(
  transcription: string,
  macAddress: string,
  tipoEvento: TipoEvento
): Promise<GeminiResponse> {
  const apiKey = getGroqApiKey();
  const model = getGroqModel();
  const timeoutMs = parseInt(Deno.env.get("GROQ_TIMEOUT_MS") ?? "10000", 10);

  const userMessage = buildUserMessage(transcription, macAddress, tipoEvento);

  const requestBody = {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    temperature: 0.3,
    response_format: { type: "json_object" },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    console.log(`[groq] Attempting classification | model=${model} | timeout=${timeoutMs}ms`);

    const response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      const parsed = parseJSONBody(errorBody);
      const err = parsed.error as { message?: string; type?: string } | undefined;
      const status = response.status;
      const message = err?.message ?? "unknown";

      console.error(
        `[groq] HTTP ${status} | model=${model} | message=${message} | body=${truncate(errorBody, 500)}`
      );

      if (status === 404) {
        throw new LLMModelNotFoundError(
          "groq",
          model,
          "n/a",
          []
        );
      }
      if (status === 400) throw new LLMBadRequestError("groq", message);
      if (status === 401 || status === 403) throw new LLMAuthError("groq", message);

      throw new LLMError(`Groq HTTP ${status}: ${message}`);
    }

    const result = await response.json() as {
      choices?: Array<{
        message?: { content?: string };
      }>;
    };

    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new LLMInvalidResponseError("Groq returned no message content");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      throw new LLMInvalidResponseError("Groq response is not valid JSON");
    }

    return validateLLMResponse(parsed, tipoEvento);
  } catch (error) {
    if (error instanceof LLMServiceError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new LLMTimeoutError("groq", timeoutMs);
    }
    throw new LLMError(
      `Groq request failed: ${error instanceof Error ? error.message : "unknown error"}`
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Fallback logic ────────────────────────────────────────────────────────────

export async function classifyTranscription(
  transcription: string,
  macAddress: string,
  tipoEvento: TipoEvento
): Promise<GeminiResponse> {
  try {
    return await callGemini(transcription, macAddress, tipoEvento);
  } catch (geminiError) {
    if (geminiError instanceof LLMServiceError) {
      const errorName = geminiError.name;
      const canFallback =
        geminiError instanceof LLMTimeoutError ||
        geminiError instanceof LLMInvalidResponseError ||
        (geminiError instanceof LLMError &&
          !(geminiError instanceof LLMConfigError) &&
          !(geminiError instanceof LLMAuthError) &&
          !(geminiError instanceof LLMModelNotFoundError) &&
          !(geminiError instanceof LLMBadRequestError));

      if (canFallback) {
        console.error(
          `[llm-fallback] Gemini failed (${errorName}). Attempting Groq fallback...`
        );
        try {
          return await callGroq(transcription, macAddress, tipoEvento);
        } catch (groqError) {
          console.error(
            `[llm-fallback] Groq also failed: ${groqError instanceof Error ? groqError.message : "unknown"}`
          );
          throw groqError;
        }
      }
    }
    throw geminiError;
  }
}

// ── Error classes ─────────────────────────────────────────────────────────────

export class LLMServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMServiceError";
  }
}

export class LLMConfigError extends LLMServiceError {
  constructor(message: string) {
    super(message);
    this.name = "LLMConfigError";
  }
}

export class LLMAuthError extends LLMServiceError {
  provider: string;
  constructor(provider: string, message: string) {
    super(`[${provider}] ${message}`);
    this.name = "LLMAuthError";
    this.provider = provider;
  }
}

export class LLMModelNotFoundError extends LLMServiceError {
  provider: string;
  model: string;
  apiVersion: string;
  availableModels: string[];

  constructor(
    provider: string,
    model: string,
    apiVersion: string,
    availableModels: string[]
  ) {
    super(
      `[${provider}] Model "${model}" not found (API ${apiVersion}). ` +
        `Available models: [${availableModels.join(", ")}]`
    );
    this.name = "LLMModelNotFoundError";
    this.provider = provider;
    this.model = model;
    this.apiVersion = apiVersion;
    this.availableModels = availableModels;
  }
}

export class LLMBadRequestError extends LLMServiceError {
  provider: string;
  constructor(provider: string, message: string) {
    super(`[${provider}] ${message}`);
    this.name = "LLMBadRequestError";
    this.provider = provider;
  }
}

export class LLMTimeoutError extends LLMServiceError {
  provider: string;
  constructor(provider: string, timeoutMs: number) {
    super(`[${provider}] Request timed out after ${timeoutMs}ms`);
    this.name = "LLMTimeoutError";
    this.provider = provider;
  }
}

export class LLMInvalidResponseError extends LLMServiceError {
  constructor(message: string) {
    super(message);
    this.name = "LLMInvalidResponseError";
  }
}

export class LLMError extends LLMServiceError {
  constructor(message: string) {
    super(message);
    this.name = "LLMError";
  }
}
