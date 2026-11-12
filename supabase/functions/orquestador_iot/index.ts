import { createClient } from "npm:@supabase/supabase-js";

// 1. Importaciones de la IA y utilitarios de alto rendimiento
import { transcribeAudio } from "./services/sttService.ts";
import { classifyTranscription } from "./services/llmService.ts";
import { synthesizeSpeech } from "./services/ttsService.ts";
import { AwsClient } from "npm:aws4fetch";
import {
  computeWebhookRequestHash,
  decodeBase64ToUint8ArrayFast,
  ensureSafeAudioPayloadSize,
  findBestContactMatch,
  getCachedDevice,
  getOrSynthesizeTtsBase64,
  isDuplicateInMemoryL1,
  logSafePayload,
  RedApoyoContact,
  runInBackground,
  setCachedDevice,
  truncateTextBySentences,
  uint8ArrayToBase64Fast,
} from "./services/performanceUtils.ts";

/* =========================================================================
   SECCIÓN 1: CONFIGURACIÓN E INICIALIZACIÓN GLOBAL POR ISOLATE
   ========================================================================= */
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

// Límites deterministas para evitar errores de exceso de bytes en AWS IoT Core (límite duro MQTT: 128 KB)
// 65,000 bytes crudos en MP3 (32 kbps) ≈ 16.25s de voz ≈ 86.6 KB en Base64 (holgura total bajo 128 KB)
const MAX_RAW_AUDIO_BYTES = parseInt(Deno.env.get("MAX_RAW_AUDIO_BYTES") ?? "65000", 10);
const MAX_TTS_CHARS = parseInt(Deno.env.get("MAX_TTS_CHARS") ?? "240", 10);

// Frases estáticas cacheadas en la memoria RAM del isolate tras su primera síntesis (0ms en peticiones siguientes)
const FRASE_SOS_ESTATICA = "Alerta de emergencia enviada a tu familia. Mantén la calma.";
const FRASE_CONFIRMACION_AUDIO = "Tu mensaje fue enviado exitosamente.";
const FRASE_CONTINGENCIA_ERROR =
  "Disculpe, tuve un inconveniente al procesar su consulta. Por favor intente de nuevo.";

// Singleton perezoso para AwsClient (reutiliza configuración y evita re-instanciar en cada request)
let cachedAwsClient: AwsClient | null = null;
let cachedCleanEndpoint = "";

function getAwsIotClient(): { awsClient: AwsClient; cleanEndpoint: string } {
  const rawEndpoint = Deno.env.get("AWS_IOT_ENDPOINT") || "";
  const cleanEndpoint = rawEndpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const iotRegion = Deno.env.get("AWS_IOT_REGION") ?? "us-east-2";
  const iotAccessKey = Deno.env.get("AWS_IOT_ACCESS_KEY_ID") ?? "";
  const iotSecretKey = Deno.env.get("AWS_IOT_SECRET_ACCESS_KEY") ?? "";

  if (!cleanEndpoint || !iotAccessKey || !iotSecretKey) {
    throw new Error("Faltan credenciales de AWS IoT Core en los secrets");
  }

  if (!cachedAwsClient || cachedCleanEndpoint !== cleanEndpoint) {
    cachedAwsClient = new AwsClient({
      accessKeyId: iotAccessKey,
      secretAccessKey: iotSecretKey,
      region: iotRegion,
      service: "iotdata", // CRÍTICO: "iotdata" — no cambiar
    });
    cachedCleanEndpoint = cleanEndpoint;
  }

  return { awsClient: cachedAwsClient, cleanEndpoint: cachedCleanEndpoint };
}

/**
 * Publica un payload de audio Base64 hacia el tópico descendente del dispositivo en AWS IoT Core
 * aplicando firma criptográfica AWS SigV4 con aws4fetch.
 */
async function publicarEnAwsIot(
  macAddress: string,
  tipoEventoBajada: string,
  audioB64: string,
  prioridad: string,
  etiquetaLog: string,
): Promise<void> {
  const { awsClient, cleanEndpoint } = getAwsIotClient();

  // NUNCA usar encodeURIComponent en el tópico — rompería el hash del canonical URI en SigV4
  const topicRx = `coco/dispositivos/${macAddress}/rx`;
  const publishUrl = `https://${cleanEndpoint}/topics/${topicRx}?qos=1`;

  const payloadDescendente = {
    mac_address: macAddress,
    tipo_evento: tipoEventoBajada,
    formato_payload: "AUDIO_B64",
    data: audioB64,
    prioridad,
  };

  const bodyStr = JSON.stringify(payloadDescendente);
  console.log(
    `[IoT TX] (${etiquetaLog}) Tópico: ${topicRx} | Payload total: ${bodyStr.length} bytes (Límite AWS: 131072 bytes)`,
  );

  const iotResponse = await awsClient.fetch(publishUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: bodyStr,
  });

  if (!iotResponse.ok) {
    const errTexto = await iotResponse.text();
    console.error(`[IoT TX ERROR] (${etiquetaLog}) Status: ${iotResponse.status} | Body: ${errTexto}`);
    throw new Error(`No se pudo entregar el mensaje al dispositivo (${iotResponse.status})`);
  }

  console.log(`[IoT TX OK] (${etiquetaLog}) Audio entregado exitosamente al dispositivo ${macAddress}.`);
}

Deno.serve(async (req) => {
  /* =========================================================================
     SECCIÓN 2: VALIDACIÓN DEL WEBHOOK, LOG SEGURO E IDEMPOTENCIA L1
     ========================================================================= */
  const requestStartMs = performance.now();
  console.log(`\n=== NUEVA PETICIÓN ENTRANTE (orquestador_iot) ===`);
  console.log(`[HTTP] Método: ${req.method} | URL: ${req.url}`);

  if (req.method !== "POST") {
    console.warn(`[BLOQUEO] Método ${req.method} no permitido.`);
    return new Response(JSON.stringify({ error: "Método no permitido" }), { status: 405 });
  }

  let macAddressValidada: string | null = null;

  try {
    const bodyText = await req.text();
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      console.warn(`[BLOQUEO] El cuerpo recibido no es un JSON válido.`);
      return new Response(JSON.stringify({ error: "Contrato JSON inválido" }), { status: 400 });
    }

    // Log estructurado sin volcar cientos de KB de Base64 en stdout
    logSafePayload("orquestador_iot", "Payload recibido", payload);

    const { mac_address, tipo_evento, formato_payload, data } = payload as {
      mac_address?: string;
      tipo_evento?: string;
      formato_payload?: string;
      data?: string;
    };

    if (!mac_address || !tipo_evento || !data || !formato_payload) {
      console.warn(`[BLOQUEO] Contrato JSON inválido o incompleto. Faltan campos.`);
      return new Response(JSON.stringify({ error: "Contrato JSON inválido o incompleto" }), {
        status: 400,
      });
    }

    if (formato_payload !== "AUDIO_B64" && formato_payload !== "TEXTO") {
      console.warn(`[BLOQUEO] Formato de payload no soportado: ${formato_payload}`);
      return new Response(JSON.stringify({ error: "Formato de payload no soportado" }), {
        status: 400,
      });
    }

    // --- Compuerta de Idempotencia L1 en Memoria (Frena reintentos de AWS IoT Core) ---
    const requestHash = await computeWebhookRequestHash(
      mac_address,
      tipo_evento,
      formato_payload,
      data,
    );

    if (isDuplicateInMemoryL1(requestHash, 60_000)) {
      console.warn(
        `[IDEMPOTENCIA L1] Reintento duplicado de AWS IoT Core detectado para MAC ${mac_address} (hash=${requestHash}). Retornando 200 OK para detener tormenta de reintentos.`,
      );
      return new Response(
        JSON.stringify({
          success: true,
          deduplicated: true,
          message: "Petición duplicada ignorada de forma segura.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    /* =========================================================================
       SECCIÓN 3: SEGURIDAD Y VERIFICACIÓN DEL GEMELO DIGITAL (CON CACHÉ RAM)
       ========================================================================= */
    let dispositivo = getCachedDevice(mac_address);

    if (!dispositivo) {
      const { data: dispDb, error: errorDispositivo } = await supabase
        .from("dispositivos_coco")
        .select("id, adulto_mayor_id")
        .eq("mac_address", mac_address)
        .single();

      if (errorDispositivo || !dispDb) {
        console.warn(`[BLOQUEO] Dispositivo no registrado en BD: ${mac_address}`);
        return new Response(JSON.stringify({ error: "Dispositivo no autorizado" }), {
          status: 403,
        });
      }

      setCachedDevice(mac_address, {
        id: dispDb.id,
        adulto_mayor_id: dispDb.adulto_mayor_id,
      });
      dispositivo = getCachedDevice(mac_address)!;
    } else {
      console.log(`[DEVICE CACHE HIT] Dispositivo ${mac_address} validado en memoria (0ms).`);
    }

    macAddressValidada = mac_address;

    /* =========================================================================
       SECCIÓN 4: ORQUESTACIÓN IA Y BYPASS DE HARDWARE
       ========================================================================= */

    // -------------------------------------------------------------------------
    // CASO 1: BYPASS Botón físico SOS (Saltamos Deepgram y LLM + TTS en Caché RAM)
    // -------------------------------------------------------------------------
    if (
      tipo_evento === "ALERTA_SOS" &&
      formato_payload === "TEXTO" &&
      data === "EMERGENCIA_BOTON_PANICO"
    ) {
      console.log(`[BYPASS IA] Botón de pánico físico presionado para MAC: ${mac_address}`);

      const audioSosB64 = await getOrSynthesizeTtsBase64(
        FRASE_SOS_ESTATICA,
        synthesizeSpeech,
        MAX_RAW_AUDIO_BYTES,
      );

      // Camino Crítico: Publicamos de inmediato en AWS IoT Core hacia el parlante
      await publicarEnAwsIot(
        mac_address,
        "RESPUESTA_IA",
        audioSosB64,
        "URGENTE",
        "BYPASS_SOS",
      );

      // Camino Background (waitUntil): Guardamos la alerta SOS en historial_interacciones
      runInBackground(
        (async () => {
          const { error: errorInsertSos } = await supabase
            .from("historial_interacciones")
            .insert({
              dispositivo_id: dispositivo.id,
              emisor: "COCO",
              destinatario_id: null,
              tipo_evento: "ALERTA_SOS",
              metadata_payload: {
                texto_procesado: "Emergencia activada mecánicamente mediante botón de pánico.",
                url_audio_referencia: null,
                procesado_por_ia: false,
              },
              estado_reproduccion: "PENDIENTE",
              prioridad: "URGENTE",
            });

          if (errorInsertSos) {
            console.error(`[BD ERROR SOS] Fallo al guardar en historial: ${errorInsertSos.message}`);
          } else {
            console.log(`[EMERGENCIA] Alerta SOS registrada para el dispositivo ${dispositivo.id}.`);
          }
        })(),
        "persistencia_sos",
      );

      const elapsedMs = Math.round(performance.now() - requestStartMs);
      console.log(`[FIN BYPASS SOS] Completado en ${elapsedMs}ms.`);
      return new Response(
        JSON.stringify({ success: true, message: "Alerta SOS procesada exitosamente" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // -------------------------------------------------------------------------
    // CASO 2: BYPASS AUDIO_DIRECTO — Nota de Voz del hardware hacia la App
    // -------------------------------------------------------------------------
    if (tipo_evento === "AUDIO_DIRECTO" && formato_payload === "AUDIO_B64") {
      console.log(`[BYPASS AUDIO_DIRECTO] Recibiendo nota de voz para MAC: ${mac_address}`);
      const rutaStorage = `mensajes/coco_audio_rx_${Date.now()}.wav`;

      // 1. Obtenemos el audio de confirmación desde caché en RAM (0ms si ya fue sintetizado)
      const audioConfirmacionB64 = await getOrSynthesizeTtsBase64(
        FRASE_CONFIRMACION_AUDIO,
        synthesizeSpeech,
        MAX_RAW_AUDIO_BYTES,
      );

      // 2. Despachamos de inmediato la confirmación al hardware para no hacer esperar al abuelo
      await publicarEnAwsIot(
        mac_address,
        "RESPUESTA_IA",
        audioConfirmacionB64,
        "NORMAL",
        "BYPASS_AUDIO_DIRECTO",
      );

      // 3. Subida al bucket 'audios_directos_coco' + INSERT en historial_interacciones en segundo plano
      runInBackground(
        (async () => {
          const audioBytes = decodeBase64ToUint8ArrayFast(data);
          let uploadOk = false;

          try {
            const { error: uploadError } = await supabase
              .storage
              .from("audios_directos_coco")
              .upload(rutaStorage, audioBytes, { contentType: "audio/wav" });

            if (uploadError) {
              console.error(`[STORAGE ERROR] Fallo al subir '${rutaStorage}': ${uploadError.message}`);
            } else {
              uploadOk = true;
              console.log(`[STORAGE OK] Nota de voz guardada en: ${rutaStorage}`);
            }
          } catch (storageEx) {
            const msg = storageEx instanceof Error ? storageEx.message : String(storageEx);
            console.error(`[STORAGE EXCEPTION] ${msg}`);
          }

          const { error: errorInsertAudio } = await supabase
            .from("historial_interacciones")
            .insert({
              dispositivo_id: dispositivo.id,
              emisor: "COCO",
              destinatario_id: null,
              tipo_evento: "AUDIO_DIRECTO",
              metadata_payload: {
                url_audio_referencia: uploadOk ? rutaStorage : null,
                texto_procesado: "🎤 Nota de voz entrante",
                procesado_por_ia: false,
              },
              estado_reproduccion: "PENDIENTE",
              prioridad: "NORMAL",
            });

          if (errorInsertAudio) {
            console.error(`[BD ERROR] No se pudo insertar en historial: ${errorInsertAudio.message}`);
          } else {
            console.log(`[BD OK] AUDIO_DIRECTO registrado en historial_interacciones`);
          }
        })(),
        "storage_e_historial_audio_directo",
      );

      const elapsedMs = Math.round(performance.now() - requestStartMs);
      console.log(`[FIN BYPASS AUDIO_DIRECTO] Confirmación entregada en ${elapsedMs}ms.`);
      return new Response(
        JSON.stringify({
          success: true,
          message: "Nota de voz procesada y confirmación enviada al hardware.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // -------------------------------------------------------------------------
    // CASO 3: FLUJO NORMAL — Procesamiento de Voz con IA (STT -> LLM -> TTS + BD Paralela)
    // -------------------------------------------------------------------------
    if (formato_payload === "AUDIO_B64") {
      console.log(`[PROCESAMIENTO IA] Audio recibido para MAC: ${mac_address}`);
      const decodedAudio = decodeBase64ToUint8ArrayFast(data);
      const transcription = await transcribeAudio(decodedAudio);

      const classification = await classifyTranscription(
        transcription,
        mac_address,
        tipo_evento as "MENSAJE" | "ALERTA_SOS",
      );

      // Segunda barrera determinista de longitud de texto antes de ElevenLabs
      const textoSeguroTts = truncateTextBySentences(
        classification.respuesta_sintetizada,
        MAX_TTS_CHARS,
      );

      // CONFIRMACION_ESCUCHA — Gatillo para que Andrés abra el micrófono
      const tipoEventoBajada =
        classification.intencion_detectada === "AUDIO_DIRECTO"
          ? "CONFIRMACION_ESCUCHA"
          : "RESPUESTA_IA";

      if (tipoEventoBajada === "CONFIRMACION_ESCUCHA") {
        console.log(
          `[TRIGGER HARDWARE] Intención AUDIO_DIRECTO detectada → forzando tipo_evento_bajada: CONFIRMACION_ESCUCHA`,
        );
      }

      /* =======================================================================
         SECCIÓN 5 (PARALELA / BACKGROUND): ENRUTAMIENTO Y PERSISTENCIA EN BD
         Se lanza en segundo plano mediante EdgeRuntime.waitUntil para no sumar
         los ~300-450ms de PostgreSQL al tiempo de respuesta del parlante.
         ======================================================================= */
      const tipo_evento_db: string = classification.intencion_detectada;
      const destinatarioIdentificado = classification.destinatario_identificado;
      const prioridadSugerida = classification.prioridad_sugerida;

      runInBackground(
        (async () => {
          let destinatario_uuid: string | null = null;

          if (tipo_evento_db === "MENSAJE" && destinatarioIdentificado) {
            console.log(
              `[RUTEO] Buscando UUID en red_apoyo para el apodo/rol: "${destinatarioIdentificado}"`,
            );
            const { data: contactosActivos, error: errContactos } = await supabase
              .from("red_apoyo")
              .select("usuario_app_id, rol, apodos_reconocimiento")
              .eq("dispositivo_id", dispositivo.id)
              .eq("activo", true);

            if (errContactos) {
              console.warn(`[RUTEO WARN] Error consultando red_apoyo: ${errContactos.message}`);
            } else if (contactosActivos && contactosActivos.length > 0) {
              destinatario_uuid = findBestContactMatch(
                contactosActivos as RedApoyoContact[],
                destinatarioIdentificado,
              );
            }
          }

          const metadata_payload = {
            texto_procesado: transcription,
            url_audio_referencia: null,
            procesado_por_ia: true,
          };

          const { error: errorInsert } = await supabase
            .from("historial_interacciones")
            .insert({
              dispositivo_id: dispositivo.id,
              emisor: "COCO",
              destinatario_id: destinatario_uuid,
              tipo_evento: tipo_evento_db,
              metadata_payload: metadata_payload,
              estado_reproduccion: "PENDIENTE",
              prioridad: prioridadSugerida,
            });

          if (errorInsert) {
            console.error(`[BD ERROR] Fallo al guardar en historial: ${errorInsert.message}`);
          } else {
            switch (tipo_evento_db) {
              case "ALERTA_SOS":
                console.log(`[EMERGENCIA] Alerta SOS registrada para el dispositivo ${dispositivo.id}.`);
                break;
              case "MENSAJE":
                console.log(
                  `[MENSAJE] Entregado al buzón asíncrono del UUID: ${destinatario_uuid || "Desconocido"}.`,
                );
                break;
              case "AUDIO_DIRECTO":
                console.log(`[AUDIO DIRECTO] Solicitud de apertura de micrófono registrada.`);
                break;
              case "RECORDATORIO":
                console.log(`[RECORDATORIO] Lógica de agendamiento pospuesta para Fase 2.`);
                break;
            }
          }
        })(),
        "ruteo_e_historial_ia",
      );

      /* =======================================================================
         SECCIÓN 6 (CAMINO CRÍTICO): TTS ELEVENLABS + SALVAGUARDA MP3 + AWS IOT
         ======================================================================= */
      const rawSynthesizedAudio = await synthesizeSpeech(textoSeguroTts);

      // Tercera barrera determinista: corte exacto en límite de frame MP3 si supera MAX_RAW_AUDIO_BYTES
      const safeSynthesizedAudio = ensureSafeAudioPayloadSize(
        rawSynthesizedAudio,
        MAX_RAW_AUDIO_BYTES,
      );
      const audioRespuestaB64 = uint8ArrayToBase64Fast(safeSynthesizedAudio);

      await publicarEnAwsIot(
        mac_address,
        tipoEventoBajada,
        audioRespuestaB64,
        prioridadSugerida,
        `FLUJO_IA_${tipoEventoBajada}`,
      );

      const elapsedMs = Math.round(performance.now() - requestStartMs);
      console.log(`[FIN ORQUESTACIÓN IA] Completada exitosamente en ${elapsedMs}ms.`);

      return new Response(
        JSON.stringify({ success: true, message: "Orquestación exitosa" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: "Combinación de payload no válida" }), {
      status: 400,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error crítico en orquestador_iot:", errorMessage);

    // SALVAGUARDA ANTI-REINTENTOS Y ANTI-SILENCIO:
    // Si la petición provino de un dispositivo válido pero falló un servicio aguas abajo,
    // enviamos un audio corto de contingencia y respondemos HTTP 200 OK para que el Rules Engine
    // de AWS IoT Core NO reintente el Webhook 2 veces más.
    if (macAddressValidada) {
      const macDestino = macAddressValidada;
      runInBackground(
        (async () => {
          const audioContingenciaB64 = await getOrSynthesizeTtsBase64(
            FRASE_CONTINGENCIA_ERROR,
            synthesizeSpeech,
            MAX_RAW_AUDIO_BYTES,
          );
          await publicarEnAwsIot(
            macDestino,
            "RESPUESTA_IA",
            audioContingenciaB64,
            "NORMAL",
            "CONTINGENCIA_ERROR",
          );
        })(),
        "contingencia_error_audio",
      );

      return new Response(
        JSON.stringify({
          success: false,
          handled_error: true,
          error: "Fallo controlado en el orquestador (contingencia activada)",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify({ error: "Fallo interno en el orquestador" }), {
      status: 500,
    });
  }
});
