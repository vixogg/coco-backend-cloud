import { createClient } from "@supabase/supabase-js";
import { AwsClient } from "npm:aws4fetch";
import { synthesizeSpeech } from "./services/ttsService.ts";
import {
  ensureSafeAudioPayloadSize,
  getCachedDevice,
  getOrSynthesizeTtsBase64,
  logSafePayload,
  setCachedDevice,
  truncateTextBySentences,
  uint8ArrayToBase64Fast,
} from "./services/performanceUtils.ts";
import { construirFraseIntroductoria } from "./services/introService.ts";

/* =========================================================================
   SECCIÓN 1: ERRORES TIPADOS DE DOMINIO
   ========================================================================= */

/**
 * Error semántico lanzado cuando un archivo no se encuentra en el bucket
 * de Supabase Storage. Permite diferenciarlo de errores genéricos de BD o TTS
 * y devolver un mensaje claro en los logs sin exponer detalles internos.
 */
class StorageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageNotFoundError";
  }
}

/* =========================================================================
   SECCIÓN 2: CONFIGURACIÓN GLOBAL SUPABASE Y AWS IOT CORE (REUTILIZACIÓN TLS)
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

// Cotas deterministas de seguridad para no superar jamás los 128 KB (131,072 bytes) de AWS IoT Core MQTT
const MAX_RAW_MP3_BYTES = parseInt(Deno.env.get("MAX_RAW_AUDIO_BYTES") ?? "65000", 10);
// 94,000 bytes crudos ≈ 125.3 KB en Base64 (máximo seguro para notas de voz WAV/AAC bajo 128 KB)
const MAX_RAW_VOICE_NOTE_BYTES = parseInt(
  Deno.env.get("MAX_RAW_VOICE_NOTE_BYTES") ?? "94000",
  10,
);
const MAX_TEXTO_COMPLETO_CHARS = parseInt(
  Deno.env.get("MAX_MENS_TEXTO_CHARS") ?? "340",
  10,
);

let cachedAwsClient: AwsClient | null = null;
let cachedCleanEndpoint = "";

function getAwsIotClient(): { awsClient: AwsClient; cleanEndpoint: string } {
  const rawEndpoint = Deno.env.get("AWS_IOT_ENDPOINT") ?? "";
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
      service: "iotdata", // CRÍTICO para SigV4 correcto
    });
    cachedCleanEndpoint = cleanEndpoint;
  }

  return { awsClient: cachedAwsClient, cleanEndpoint: cachedCleanEndpoint };
}

/* =========================================================================
   SECCIÓN 3: HANDLER PRINCIPAL
   ========================================================================= */
Deno.serve(async (req) => {
  // Preflight CORS — obligatorio para clientes móviles/web
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers":
          "authorization, x-client-info, apikey, content-type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Método no permitido" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }

  const requestStartMs = performance.now();
  console.log(`\n=== app_mensajeria — NUEVA PETICIÓN ===`);

  try {
    /* -----------------------------------------------------------------------
       PASO 1: Validación del contrato de entrada
       ----------------------------------------------------------------------- */
    const bodyText = await req.text();

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return new Response(
        JSON.stringify({ error: "Body no es JSON válido" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    logSafePayload("app_mensajeria", "Payload recibido", payload);

    const { mac_address, emisor_id, tipo_mensaje, texto, audio_url } = payload as {
      mac_address?: string;
      emisor_id?: string;
      tipo_mensaje?: string;
      texto?: string | null;
      audio_url?: string | null;
    };

    if (!mac_address || !emisor_id || !tipo_mensaje) {
      console.warn(`[BLOQUEO] Faltan campos obligatorios: mac_address, emisor_id, tipo_mensaje`);
      return new Response(
        JSON.stringify({
          error: "Campos obligatorios faltantes: mac_address, emisor_id, tipo_mensaje",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    if (tipo_mensaje !== "TEXTO" && tipo_mensaje !== "AUDIO") {
      return new Response(
        JSON.stringify({ error: "tipo_mensaje debe ser 'TEXTO' o 'AUDIO'" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    if (tipo_mensaje === "TEXTO" && !texto) {
      return new Response(
        JSON.stringify({ error: "Se requiere 'texto' cuando tipo_mensaje es TEXTO" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    if (tipo_mensaje === "AUDIO" && !audio_url) {
      return new Response(
        JSON.stringify({ error: "Se requiere 'audio_url' cuando tipo_mensaje es AUDIO" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
        },
      );
    }

    /* -----------------------------------------------------------------------
       PASO 2: Consulta BD (con Caché RAM) — Nombre del adulto mayor via mac_address
       Ruta: dispositivos_coco → adultos_mayores (FK: adulto_mayor_id)
       ----------------------------------------------------------------------- */
    let cachedDisp = getCachedDevice(mac_address);

    if (!cachedDisp) {
      console.log(`[BD] Buscando dispositivo con MAC: ${mac_address}`);
      const { data: dispositivo, error: errorDispositivo } = await supabase
        .from("dispositivos_coco")
        .select("id, adulto_mayor_id, adultos_mayores(nombre)")
        .eq("mac_address", mac_address)
        .single();

      if (errorDispositivo || !dispositivo) {
        console.warn(`[BLOQUEO] Dispositivo no registrado: ${mac_address}`);
        return new Response(
          JSON.stringify({ error: "Dispositivo no autorizado o no registrado" }),
          {
            status: 403,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          },
        );
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adultoMayorData = (dispositivo as any).adultos_mayores;
      const nombreAbueloDb: string = adultoMayorData?.nombre ?? "Estimado";

      setCachedDevice(mac_address, {
        id: dispositivo.id,
        adulto_mayor_id: dispositivo.adulto_mayor_id,
        nombre_adulto: nombreAbueloDb,
      });
      cachedDisp = getCachedDevice(mac_address)!;
    } else {
      console.log(
        `[DEVICE CACHE HIT] Dispositivo ${mac_address} (${cachedDisp.nombre_adulto}) resuelto en 0ms.`,
      );
    }

    const dispositivoId = cachedDisp.id;
    const nombreAbuelo = cachedDisp.nombre_adulto;

    /* -----------------------------------------------------------------------
       PASO 3: Consulta BD — Apodos del emisor en la red de apoyo + su nombre real
       Ruta: red_apoyo WHERE dispositivo_id + usuario_app_id = emisor_id
             └─ usuarios_app(nombre) vía FK usuario_app_id
       NOTA: red_apoyo.rol es un nivel de permiso (ADMINISTRADOR|CONTACTO), no un
       parentesco, por eso ya no se consulta ni se pronuncia.
       ----------------------------------------------------------------------- */
    console.log(`[BD] Buscando emisor ${emisor_id} en red de apoyo del dispositivo ${dispositivoId}`);
    const { data: contacto, error: errorContacto } = await supabase
      .from("red_apoyo")
      .select("apodos_reconocimiento, usuarios_app(nombre)")
      .eq("dispositivo_id", dispositivoId)
      .eq("usuario_app_id", emisor_id)
      .eq("activo", true)
      .maybeSingle();

    if (errorContacto) {
      console.error(`[BD ERROR] Error consultando red_apoyo: ${errorContacto.message}`);
      throw new Error(`Error consultando red de apoyo: ${errorContacto.message}`);
    }

    /* -----------------------------------------------------------------------
       PASO 4: Construcción de la frase introductoria dinámica
       "Hola Don Carlos, tu sobrino José te envió un audio."
       ----------------------------------------------------------------------- */
    const tipoContenido = tipo_mensaje === "AUDIO" ? "audio" : "mensaje";
    // El embebido many-to-one puede venir como objeto o como arreglo según el tipado.
    const usuarioEmbebido = (contacto as { usuarios_app?: unknown } | null)?.usuarios_app;
    const usuarioEmisor = (Array.isArray(usuarioEmbebido) ? usuarioEmbebido[0] : usuarioEmbebido) as
      | { nombre?: string | null }
      | null
      | undefined;

    const fraseIntroductoria = construirFraseIntroductoria({
      nombreAbuelo,
      emisorEnRed: !!contacto,
      nombreFamiliar: usuarioEmisor?.nombre ?? null,
      apodos: (contacto?.apodos_reconocimiento as string[] | null | undefined) ?? [],
      tipoContenido,
    });
    console.log(
      `[INTRO] ${contacto ? "Con datos del emisor" : "Fallback (emisor fuera de red_apoyo)"}: "${fraseIntroductoria}"`,
    );

    /* -----------------------------------------------------------------------
       PASO 5 + 6 + 7 (PARALELIZADO): Generación de audio, Persistencia en BD y Despacho MQTT
       ----------------------------------------------------------------------- */
    const { awsClient, cleanEndpoint } = getAwsIotClient();

    // NUNCA usar encodeURIComponent en el tópico — rompería el hash del canonical URI
    const topicRx = `coco/dispositivos/${mac_address}/rx`;
    const publishUrl = `https://${cleanEndpoint}/topics/${topicRx}?qos=1`;

    async function publicarEnIoT(
      audioB64: string,
      etiquetaLog: string,
    ): Promise<void> {
      const payloadDescendente = {
        mac_address: mac_address,
        tipo_evento: "MENSAJE",
        formato_payload: "AUDIO_B64",
        data: audioB64,
        prioridad: "NORMAL",
      };
      const bodyStr = JSON.stringify(payloadDescendente);
      console.log(`[IoT TX] ${etiquetaLog} — publicando en tópico: ${topicRx}`);
      console.log(`[IoT TX] Payload size: ${bodyStr.length} bytes (Límite AWS: 131072 bytes)`);

      const iotResponse = await awsClient.fetch(publishUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: bodyStr,
      });

      if (!iotResponse.ok) {
        const errTexto = await iotResponse.text();
        console.error(`[IoT TX ERROR] ${etiquetaLog} — Status: ${iotResponse.status}`);
        console.error(`[IoT TX ERROR] Body: ${errTexto}`);
        throw new Error(`No se pudo entregar el ${etiquetaLog} al dispositivo vía IoT Core`);
      }
      console.log(`[IoT TX OK] ${etiquetaLog} entregado al dispositivo ${mac_address}`);
    }

    // Función auxiliar que inserta el registro en historial_interacciones
    // preservando el contrato exacto de metadata_payload requerido por la App de Martín
    async function guardarEnHistorial(): Promise<void> {
      console.log(`[BD] Insertando en historial_interacciones (en paralelo)`);
      const { error: errorInsert } = await supabase
        .from("historial_interacciones")
        .insert({
          dispositivo_id: dispositivoId,
          emisor: "APP",
          destinatario_id: emisor_id,
          tipo_evento: "MENSAJE",
          metadata_payload: {
            texto_procesado: tipo_mensaje === "TEXTO" ? texto : null,
            url_audio_referencia: tipo_mensaje === "AUDIO" ? audio_url : null,
            procesado_por_ia: false,
            duracion_segundos: null,
            tipo_mensaje_original: tipo_mensaje,
            frase_introductoria: fraseIntroductoria,
          },
          estado_reproduccion: "PENDIENTE",
          prioridad: "NORMAL",
        });

      if (errorInsert) {
        throw new Error(`Fallo al guardar en historial: ${errorInsert.message}`);
      }
      console.log(`[BD] Registro guardado en historial_interacciones`);
    }

    // --- CASO A: tipo_mensaje === "TEXTO" (TTS+MQTT en paralelo con INSERT BD) ---
    if (tipo_mensaje === "TEXTO") {
      const textoCompleto = truncateTextBySentences(
        `${fraseIntroductoria} ${texto!}`,
        MAX_TEXTO_COMPLETO_CHARS,
      );

      await Promise.all([
        (async () => {
          console.log(`[TTS] Sintetizando texto completo (${textoCompleto.length} chars)`);
          const audioRawBytes = await synthesizeSpeech(textoCompleto);
          const audioSafeBytes = ensureSafeAudioPayloadSize(audioRawBytes, MAX_RAW_MP3_BYTES);
          console.log(`[TTS] Audio sintetizado y validado: ${audioSafeBytes.length} bytes`);

          const audioBase64 = uint8ArrayToBase64Fast(audioSafeBytes);
          await publicarEnIoT(audioBase64, "TEXTO-Único");
        })(),
        guardarEnHistorial(),
      ]);

    // --- CASO B: tipo_mensaje === "AUDIO" — Doble Despacho Secuencial con Pre-descarga Paralela ---
    } else {
      const DELAY_MS = 3500;

      // Ejecutamos simultáneamente desde el segundo cero:
      // 1) Síntesis (o lectura en caché RAM) de la frase introductoria + Despacho MQTT 1
      // 2) Pre-descarga de la nota de voz desde Supabase Storage + salvaguarda de bytes
      // 3) Inserción del registro en historial_interacciones
      const [dispatch1EndTime, audioNotaB64] = await Promise.all([
        (async () => {
          console.log(`[TTS] Obteniendo/sintetizando frase introductoria para Despacho 1`);
          const audioIntroB64 = await getOrSynthesizeTtsBase64(
            fraseIntroductoria,
            synthesizeSpeech,
            MAX_RAW_MP3_BYTES,
          );
          await publicarEnIoT(audioIntroB64, "Despacho-1-INTRO");
          return performance.now();
        })(),
        (async () => {
          console.log(
            `[STORAGE] Pre-descargando en paralelo nota de voz del bucket 'audios_directos_coco', path: ${audio_url}`,
          );
          const { data: blobDescargado, error: errorStorage } = await supabase
            .storage
            .from("audios_directos_coco")
            .download(audio_url!);

          if (errorStorage || !blobDescargado) {
            const motivo = errorStorage?.message ?? "Archivo no encontrado en el bucket";
            console.error(`[STORAGE ERROR] No se pudo descargar '${audio_url}': ${motivo}`);
            throw new StorageNotFoundError(`No se encontró el audio en Storage: ${motivo}`);
          }

          const audioBuffer = await blobDescargado.arrayBuffer();
          const audioOriginalBytes = new Uint8Array(audioBuffer);
          console.log(`[STORAGE] Nota pre-descargada en RAM: ${audioOriginalBytes.length} bytes`);

          // Salvaguarda para que incluso notas WAV grandes no fallen con 413 en AWS IoT Core (128 KB)
          const safeVoiceBytes = ensureSafeAudioPayloadSize(
            audioOriginalBytes,
            MAX_RAW_VOICE_NOTE_BYTES,
          );
          return uint8ArrayToBase64Fast(safeVoiceBytes);
        })(),
        guardarEnHistorial(),
      ]);

      // Calculamos únicamente el tiempo restante de los 3500ms desde que se entregó el Despacho 1
      // (gran parte de ese tiempo ya se aprovechó si la descarga de Storage demoró más que el Despacho 1)
      const elapsedSinceDispatch1 = Math.round(performance.now() - dispatch1EndTime);
      const remainingWaitMs = Math.max(0, DELAY_MS - elapsedSinceDispatch1);

      if (remainingWaitMs > 0) {
        console.log(
          `[DELAY] Nota ya lista en RAM. Esperando ${remainingWaitMs}ms restantes (de ${DELAY_MS}ms) para que el hardware reproduzca la intro...`,
        );
        await new Promise((resolve) => setTimeout(resolve, remainingWaitMs));
      }

      // ── Despacho 2: Nota de voz original ya lista en memoria ────────────────
      await publicarEnIoT(audioNotaB64, "Despacho-2-NOTA");
    }

    const totalMs = Math.round(performance.now() - requestStartMs);
    console.log(`[FIN app_mensajeria] Completado exitosamente en ${totalMs}ms.`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Mensaje procesado y entregado al hardware.",
        dispositivo_id: dispositivoId,
        adulto_mayor: nombreAbuelo,
        tipo_mensaje,
        despachos_mqtt: tipo_mensaje === "AUDIO" ? 2 : 1,
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[CRÍTICO] Error en app_mensajeria: ${errorMessage}`);
    return new Response(
      JSON.stringify({ error: "Fallo interno en el servidor al procesar el mensaje." }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      },
    );
  }
});
