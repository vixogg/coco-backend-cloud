import { createClient } from "@supabase/supabase-js";
import { AwsClient } from "npm:aws4fetch";
import { synthesizeSpeech } from "./services/ttsService.ts";

/* =========================================================================
   SECCIÓN 1: HELPERS DE AUDIO
   ========================================================================= */

/**
 * Convierte un Uint8Array a string Base64 puro.
 * CRÍTICO: usar btoa() sobre string binario, no sobre el array directamente.
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Concatena dos Uint8Array en memoria.
 * Se usa para pegar la introducción de voz (Polly) con la nota de audio (Supabase Storage).
 */
function concatenarUint8Arrays(a: Uint8Array, b: Uint8Array): Uint8Array {
  const resultado = new Uint8Array(a.length + b.length);
  resultado.set(a, 0);
  resultado.set(b, a.length);
  return resultado;
}

/* =========================================================================
   SECCIÓN 2: CONFIGURACIÓN SUPABASE
   ========================================================================= */
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(supabaseUrl, supabaseKey);

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

  console.log(`\n=== app_mensajeria — NUEVA PETICIÓN ===`);

  try {
    /* -----------------------------------------------------------------------
       PASO 1: Validación del contrato de entrada
       ----------------------------------------------------------------------- */
    const bodyText = await req.text();
    console.log(`[PAYLOAD RECIBIDO]:\n`, bodyText);

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      return new Response(
        JSON.stringify({ error: "Body no es JSON válido" }),
        { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
      );
    }

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
        JSON.stringify({ error: "Campos obligatorios faltantes: mac_address, emisor_id, tipo_mensaje" }),
        { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
      );
    }

    if (tipo_mensaje !== "TEXTO" && tipo_mensaje !== "AUDIO") {
      return new Response(
        JSON.stringify({ error: "tipo_mensaje debe ser 'TEXTO' o 'AUDIO'" }),
        { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
      );
    }

    if (tipo_mensaje === "TEXTO" && !texto) {
      return new Response(
        JSON.stringify({ error: "Se requiere 'texto' cuando tipo_mensaje es TEXTO" }),
        { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
      );
    }

    if (tipo_mensaje === "AUDIO" && !audio_url) {
      return new Response(
        JSON.stringify({ error: "Se requiere 'audio_url' cuando tipo_mensaje es AUDIO" }),
        { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
      );
    }

    /* -----------------------------------------------------------------------
       PASO 2: Consulta BD — Nombre del adulto mayor via mac_address
       Ruta: dispositivos_coco → adultos_mayores (FK: adulto_mayor_id)
       ----------------------------------------------------------------------- */
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
        { status: 403, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } },
      );
    }

    // Extraer el nombre del adulto mayor del join anidado de Supabase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adultoMayorData = (dispositivo as any).adultos_mayores;
    const nombreAbuelo: string = adultoMayorData?.nombre ?? "Estimado";
    console.log(`[BD] Adulto mayor encontrado: ${nombreAbuelo}`);

    /* -----------------------------------------------------------------------
       PASO 3: Consulta BD — Rol y apodos del emisor en la red de apoyo
       Ruta: red_apoyo WHERE dispositivo_id + usuario_app_id = emisor_id
       ----------------------------------------------------------------------- */
    console.log(`[BD] Buscando emisor ${emisor_id} en red de apoyo del dispositivo ${dispositivo.id}`);
    const { data: contacto, error: errorContacto } = await supabase
      .from("red_apoyo")
      .select("rol, apodos_reconocimiento")
      .eq("dispositivo_id", dispositivo.id)
      .eq("usuario_app_id", emisor_id)
      .eq("activo", true)
      .maybeSingle(); // maybeSingle() para no lanzar error si no existe (fallback graceful)

    // errorContacto puede ser un error real de BD (distinto de "no rows")
    if (errorContacto) {
      console.error(`[BD ERROR] Error consultando red_apoyo: ${errorContacto.message}`);
      throw new Error(`Error consultando red de apoyo: ${errorContacto.message}`);
    }

    /* -----------------------------------------------------------------------
       PASO 4: Construcción de la frase introductoria dinámica
       ----------------------------------------------------------------------- */
    const tipoContenido = tipo_mensaje === "AUDIO" ? "audio" : "mensaje";
    let fraseIntroductoria: string;

    if (contacto && contacto.rol) {
      // Obtener el primer apodo del array si existe, o usar el rol como fallback
      const apodos: string[] = contacto.apodos_reconocimiento ?? [];
      const nombreFamiliar = apodos.length > 0 ? apodos[0] : contacto.rol;
      fraseIntroductoria = `Hola ${nombreAbuelo}, tu ${contacto.rol} ${nombreFamiliar} te envió un ${tipoContenido}.`;
      console.log(`[INTRO] Con datos del emisor: "${fraseIntroductoria}"`);
    } else {
      // Fallback: emisor no encontrado en red de apoyo
      fraseIntroductoria = `Hola ${nombreAbuelo}, te enviaron un ${tipoContenido}.`;
      console.log(`[INTRO] Fallback (emisor sin contacto): "${fraseIntroductoria}"`);
    }

    /* -----------------------------------------------------------------------
       PASO 5: Generación del audio final (Polly + concatenación si es AUDIO)
       ----------------------------------------------------------------------- */
    let audioFinalBytes: Uint8Array;

    if (tipo_mensaje === "TEXTO") {
      // TEXTO: concatenar frase + texto en un solo string → un solo TTS
      const textoCompleto = `${fraseIntroductoria} ${texto!}`;
      console.log(`[TTS] Sintetizando texto completo (${textoCompleto.length} chars)`);
      audioFinalBytes = await synthesizeSpeech(textoCompleto);
      console.log(`[TTS] Audio sintetizado: ${audioFinalBytes.length} bytes`);

    } else {
      // AUDIO: TTS para la intro + descarga del audio original → concatenar bytes
      console.log(`[TTS] Sintetizando frase introductoria para modo AUDIO`);
      const audioIntroBytes = await synthesizeSpeech(fraseIntroductoria);
      console.log(`[TTS] Audio intro sintetizado: ${audioIntroBytes.length} bytes`);

      console.log(`[STORAGE] Descargando nota de voz desde: ${audio_url}`);
      const audioResponse = await fetch(audio_url!);
      if (!audioResponse.ok) {
        throw new Error(`No se pudo descargar el audio desde la URL provista. Status: ${audioResponse.status}`);
      }
      const audioBuffer = await audioResponse.arrayBuffer();
      const audioOriginalBytes = new Uint8Array(audioBuffer);
      console.log(`[STORAGE] Audio descargado: ${audioOriginalBytes.length} bytes`);

      // Concatenar: [intro Polly MP3] + [nota de voz original]
      audioFinalBytes = concatenarUint8Arrays(audioIntroBytes, audioOriginalBytes);
      console.log(`[AUDIO] Audio final concatenado: ${audioFinalBytes.length} bytes`);
    }

    // Convertir el Uint8Array final a Base64 puro para el payload MQTT
    const audioBase64 = uint8ArrayToBase64(audioFinalBytes);

    /* -----------------------------------------------------------------------
       PASO 6: Persistencia en historial_interacciones
       emisor: 'APP' (viene de la app de Martín)
       destinatario_id: el adulto mayor (el dispositivo es el receptor final)
       ----------------------------------------------------------------------- */
    console.log(`[BD] Insertando en historial_interacciones`);
    const { error: errorInsert } = await supabase
      .from("historial_interacciones")
      .insert({
        dispositivo_id: dispositivo.id,
        emisor: "APP",
        destinatario_id: emisor_id, // El familiar que envía queda registrado
        tipo_evento: "MENSAJE",
        metadata_payload: {
          texto_procesado: tipo_mensaje === "TEXTO" ? texto : null,
          url_audio_referencia: tipo_mensaje === "AUDIO" ? audio_url : null,
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

    /* -----------------------------------------------------------------------
       PASO 7: Publicación en AWS IoT Core — Canal de bajada (Rx)
       Reglas SigV4 estrictas (AGENTS.md):
         - host SIN https://
         - service = "iotdata"
         - tópico SIN encodeURIComponent
         - Content-Type dentro de la firma (aws4fetch lo incluye automáticamente)
       ----------------------------------------------------------------------- */
    const rawEndpoint = Deno.env.get("AWS_IOT_ENDPOINT") ?? "";
    const cleanEndpoint = rawEndpoint.replace(/^https?:\/\//, "");
    const iotRegion = Deno.env.get("AWS_IOT_REGION") ?? "us-east-2";
    const iotAccessKey = Deno.env.get("AWS_IOT_ACCESS_KEY_ID") ?? "";
    const iotSecretKey = Deno.env.get("AWS_IOT_SECRET_ACCESS_KEY") ?? "";

    if (!cleanEndpoint || !iotAccessKey || !iotSecretKey) {
      throw new Error("Faltan credenciales de AWS IoT Core en los secrets");
    }

    // Instanciar aws4fetch con service: "iotdata" — CRÍTICO para SigV4 correcto
    const awsClient = new AwsClient({
      accessKeyId: iotAccessKey,
      secretAccessKey: iotSecretKey,
      region: iotRegion,
      service: "iotdata",
    });

    // NUNCA usar encodeURIComponent en el tópico — rompería el hash del canonical URI
    const topicRx = `coco/dispositivos/${mac_address}/rx`;
    const publishUrl = `https://${cleanEndpoint}/topics/${topicRx}?qos=1`;

    const payloadDescendente = {
      mac_address: mac_address,
      tipo_evento: "MENSAJE",
      formato_payload: "AUDIO_B64",
      data: audioBase64,
      prioridad: "NORMAL",
    };

    const bodyStr = JSON.stringify(payloadDescendente);
    console.log(`[IoT TX] Publicando en tópico: ${topicRx}`);
    console.log(`[IoT TX] URL: ${publishUrl}`);
    console.log(`[IoT TX] Payload size: ${bodyStr.length} bytes`);

    // aws4fetch firma automáticamente: canonical URI (slashes intactos),
    // query string (?qos=1), SHA-256 del body y headers obligatorios
    const iotResponse = await awsClient.fetch(publishUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyStr,
    });

    if (!iotResponse.ok) {
      const errTexto = await iotResponse.text();
      console.error(`[IoT TX ERROR] Status: ${iotResponse.status}`);
      console.error(`[IoT TX ERROR] Body: ${errTexto}`);
      throw new Error("No se pudo entregar el mensaje al dispositivo físico via IoT Core");
    }

    console.log(`[IoT TX OK] Mensaje entregado exitosamente al dispositivo ${mac_address}`);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Mensaje procesado y entregado al hardware.",
        dispositivo_id: dispositivo.id,
        adulto_mayor: nombreAbuelo,
        tipo_mensaje,
        audio_bytes_total: audioFinalBytes.length,
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
