import { createClient } from "npm:@supabase/supabase-js";

// 1. Importaciones de la IA
import { transcribeAudio } from "./services/sttService.ts";
import { classifyTranscription } from "./services/llmService.ts";
import { synthesizeSpeech} from "./services/ttsService.ts";
import { AwsClient } from "npm:aws4fetch";

// 2. Funciones auxiliares para manejar el audio
function decodeBase64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/* =========================================================================
   SECCIÓN 1: CONFIGURACIÓN E INICIALIZACIÓN
   ========================================================================= */
const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const supabase = createClient(supabaseUrl, supabaseKey);

Deno.serve(async (req) => {
  /* =========================================================================
     SECCIÓN 2: VALIDACIÓN DEL WEBHOOK Y CONTRATO DE ENTRADA (Tx)
     ========================================================================= */
  console.log(`\n=== NUEVA PETICIÓN ENTRANTE ===`);
  console.log(`[HTTP] Método: ${req.method} | URL: ${req.url}`);

  if (req.method !== "POST") {
    console.warn(`[BLOQUEO] Método ${req.method} no permitido.`);
    return new Response(JSON.stringify({ error: "Método no permitido" }), { status: 405 });
  }

  try {
    // Leemos el payload como texto crudo para auditarlo antes de que falle
    const bodyText = await req.text();
    console.log(`[PAYLOAD CRUDO RECIBIDO]:\n`, bodyText);

    const payload = JSON.parse(bodyText); 
    const { mac_address, tipo_evento, formato_payload, data } = payload;

    if (!mac_address || !tipo_evento || !data || !formato_payload) {
      console.warn(`[BLOQUEO] Contrato JSON inválido o incompleto. Faltan campos.`);
      return new Response(JSON.stringify({ error: "Contrato JSON inválido o incompleto" }), { status: 400 });
    }

    if (formato_payload !== "AUDIO_B64" && formato_payload !== "TEXTO") {
      console.warn(`[BLOQUEO] Formato de payload no soportado: ${formato_payload}`);
      return new Response(JSON.stringify({ error: "Formato de payload no soportado" }), { status: 400 });
    }

    /* =========================================================================
       SECCIÓN 3: SEGURIDAD Y VERIFICACIÓN DEL GEMELO DIGITAL
       ========================================================================= */
    const { data: dispositivo, error: errorDispositivo } = await supabase
      .from("dispositivos_coco")
      .select("id, adulto_mayor_id")
      .eq("mac_address", mac_address)
      .single();

    if (errorDispositivo || !dispositivo) {
      console.warn(`[BLOQUEO] Dispositivo no registrado en BD: ${mac_address}`);
      return new Response(JSON.stringify({ error: "Dispositivo no autorizado" }), { status: 403 });
    }

    /* =========================================================================
       SECCIÓN 4: ORQUESTACIÓN IA Y BYPASS DE HARDWARE
       ========================================================================= */
    // TypeScript requiere que el objeto sea 'const' si no lo reasignamos por completo.
    const resultadoIA = {
      intencion_detectada: "",
      texto_procesado: null as string | null,
      destinatario_identificado: null as string | null,
      prioridad_sugerida: "NORMAL",
      audio_respuesta_b64: "",
      url_storage: null as string | null,
      tipo_evento_bajada: "RESPUESTA_IA" 
    };

    if (tipo_evento === "ALERTA_SOS" && formato_payload === "TEXTO" && data === "EMERGENCIA_BOTON_PANICO") {
      // CASO 1: BYPASS Botón físico (Saltamos Deepgram y Gemini)
      console.log(`[BYPASS IA] Botón de pánico físico presionado para MAC: ${mac_address}`);
      resultadoIA.intencion_detectada = "ALERTA_SOS";
      resultadoIA.prioridad_sugerida = "URGENTE";
      resultadoIA.texto_procesado = "Emergencia activada mecánicamente mediante botón de pánico.";
      
      const synthesizedAudio = await synthesizeSpeech("Alerta de emergencia enviada a tu familia. Mantén la calma.");
      resultadoIA.audio_respuesta_b64 = uint8ArrayToBase64(synthesizedAudio);

    } else if (tipo_evento === "AUDIO_DIRECTO" && formato_payload === "AUDIO_B64") {
      // CASO 2: BYPASS Nota de Voz (Sube al Bucket audios_directos_coco)
      console.log(`[STORAGE] Recibiendo nota de voz directa para MAC: ${mac_address}`);
      
      const audioBytes = decodeBase64ToUint8Array(data);
      const fileName = `${mac_address}_${Date.now()}.wav`;

      const { error: uploadError } = await supabase
        .storage
        .from('audios_directos_coco')
        .upload(fileName, audioBytes, { contentType: 'audio/wav' });

      if (uploadError) throw new Error(`Fallo al subir a Storage: ${uploadError.message}`);

      const { data: publicUrlData } = supabase
        .storage
        .from('audios_directos_coco')
        .getPublicUrl(fileName);

      resultadoIA.intencion_detectada = "AUDIO_DIRECTO";
      resultadoIA.texto_procesado = "🎤 Nota de voz entrante";
      resultadoIA.url_storage = publicUrlData.publicUrl; // Guardamos la URL pública
      resultadoIA.tipo_evento_bajada = "RESPUESTA_IA"; // Retorna a la normalidad el hardware
      
      const synthesizedAudio = await synthesizeSpeech("Audio enviado a tu familia exitosamente.");
      resultadoIA.audio_respuesta_b64 = uint8ArrayToBase64(synthesizedAudio);

    } else if (formato_payload === "AUDIO_B64") {
      // CASO 3: FLUJO NORMAL Procesamiento de Voz con IA
      console.log(`[PROCESAMIENTO IA] Audio recibido para MAC: ${mac_address}`);
      const decodedAudio = decodeBase64ToUint8Array(data);
      const transcription = await transcribeAudio(decodedAudio);
      
      const classification = await classifyTranscription(transcription, mac_address, tipo_evento);
      const synthesizedAudio = await synthesizeSpeech(classification.respuesta_sintetizada);
      
      resultadoIA.intencion_detectada = classification.intencion_detectada;
      resultadoIA.texto_procesado = transcription;
      resultadoIA.destinatario_identificado = classification.destinatario_identificado;
      resultadoIA.prioridad_sugerida = classification.prioridad_sugerida;
      resultadoIA.audio_respuesta_b64 = uint8ArrayToBase64(synthesizedAudio);

      // LA MAGIA DE LA OPCIÓN A: Si la IA detecta que el abuelo quiere enviar un mensaje directo (Nota de voz)
      if (classification.intencion_detectada === "AUDIO_DIRECTO" && classification.destinatario_identificado) {
        resultadoIA.tipo_evento_bajada = "CONFIRMACION_ESCUCHA"; // Gatillo para el simulador de Andrés
        console.log(`[TRIGGER HARDWARE] Solicitando modo grabación a la placa mediante CONFIRMACION_ESCUCHA`);
      }
    } else {
      return new Response(JSON.stringify({ error: "Combinación de payload no válida" }), { status: 400 });
    }

    /* =========================================================================
       SECCIÓN 5: LÓGICA DE ENRUTAMIENTO Y PERSISTENCIA (El Cerebro)
       ========================================================================= */
       
    const tipo_evento_db: string = resultadoIA.intencion_detectada;

    let destinatario_uuid = null;
    
    if (tipo_evento_db === "MENSAJE" && resultadoIA.destinatario_identificado) {
      console.log(`[RUTEO] Buscando UUID para el apodo/rol: ${resultadoIA.destinatario_identificado}`);
      const { data: contacto } = await supabase
        .from("red_apoyo")
        .select("usuario_app_id")
        .eq("dispositivo_id", dispositivo.id)
        .eq("activo", true)
        .or(`rol.ilike.%${resultadoIA.destinatario_identificado}%,apodos_reconocimiento.cs.{${resultadoIA.destinatario_identificado}}`)
        .limit(1)
        .single();
        
      if (contacto) destinatario_uuid = contacto.usuario_app_id;
    }

    const metadata_payload = {
      texto_procesado: resultadoIA.texto_procesado,
      url_audio_referencia: resultadoIA.url_storage, // Mapea la URL del bucket si existe
      procesado_por_ia: formato_payload === "AUDIO_B64" && !resultadoIA.url_storage
    };

    const { error: errorInsert } = await supabase
      .from("historial_interacciones")
      .insert({
        dispositivo_id: dispositivo.id,
        emisor: 'COCO',
        destinatario_id: destinatario_uuid,
        tipo_evento: tipo_evento_db,
        metadata_payload: metadata_payload,
        estado_reproduccion: 'PENDIENTE',
        prioridad: resultadoIA.prioridad_sugerida
      });

    if (errorInsert) throw new Error(`Fallo al guardar en historial: ${errorInsert.message}`);

    switch (tipo_evento_db) {
      case "ALERTA_SOS":
        console.log(`[EMERGENCIA] Alerta SOS registrada para el dispositivo ${dispositivo.id}.`);
        break;
      case "MENSAJE":
        console.log(`[MENSAJE] Entregado al buzón asíncrono del UUID: ${destinatario_uuid || 'Desconocido'}.`);
        break;
      case "AUDIO_DIRECTO":
        console.log(`[AUDIO DIRECTO] Rutina ejecutada (Charla o Nota de Voz).`);
        break;
      case "RECORDATORIO":
        console.log(`[RECORDATORIO] Lógica de agendamiento pospuesta para Fase 2.`);
        break;
    }

/* =========================================================================
       SECCIÓN 6: ENRUTAMIENTO Y CANAL DE BAJADA (Rx) HACIA AWS IOT CORE
       =====================================================================
       FIX: Se reemplazó la función signRequest manual por aws4fetch.
       La firma SigV4 manual calculaba mal el canonical URI (slashes del
       tópico MQTT), el query string (?qos=1) y/o el hash del body,
       causando un 403 Signature Mismatch permanente.
       aws4fetch delega todo el proceso de firma a SubtleCrypto nativo.
       ========================================================================= */
    const payloadDescendente = {
      mac_address: mac_address,
      tipo_evento: resultadoIA.tipo_evento_bajada, 
      formato_payload: "AUDIO_B64",
      data: resultadoIA.audio_respuesta_b64,
      prioridad: resultadoIA.prioridad_sugerida
    };
    // Leer credenciales de AWS IoT Core desde los secrets de Supabase
    const rawEndpoint = Deno.env.get("AWS_IOT_ENDPOINT") || "";
    const cleanEndpoint = rawEndpoint.replace(/^https?:\/\//, '');
    const iotRegion = Deno.env.get("AWS_IOT_REGION") ?? "us-east-2";
    const iotAccessKey = Deno.env.get("AWS_IOT_ACCESS_KEY_ID") ?? "";
    const iotSecretKey = Deno.env.get("AWS_IOT_SECRET_ACCESS_KEY") ?? "";
    if (!cleanEndpoint || !iotAccessKey || !iotSecretKey) {
      throw new Error("Faltan credenciales de AWS IoT Core en los secrets");
    }
    // Instanciar el cliente aws4fetch con servicio 'iotdata' explícito
    // aws4fetch usa SubtleCrypto (Web API nativa de Deno) para la firma SigV4
    const awsClient = new AwsClient({
      accessKeyId: iotAccessKey,
      secretAccessKey: iotSecretKey,
      region: iotRegion,
      service: "iotdata",
    });
    // Construir la URL de publicación
    // aws4fetch maneja la canonicalización de los slashes '/' en el tópico
    // MQTT internamente de forma segura — NO usar encodeURIComponent aquí
    const topicRx = `coco/dispositivos/${mac_address}/rx`;
    const publishUrl = `https://${cleanEndpoint}/topics/${topicRx}?qos=1`;
    const bodyStr = JSON.stringify(payloadDescendente);
    console.log(`[IoT TX] Enviando audio de vuelta en tópico: ${topicRx}`);
    console.log(`[IoT TX] URL: ${publishUrl}`);
    console.log(`[IoT TX] Payload size: ${bodyStr.length} bytes`);
    // aws4fetch.fetch() firma automáticamente:
    // - Canonical URI (con slashes intactos)
    // - Canonical Query String (qos=1)
    // - Hash SHA-256 del body
    // - Headers requeridos (Host, X-Amz-Date, Authorization)
    const iotResponse = await awsClient.fetch(publishUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bodyStr,
    });
    if (!iotResponse.ok) {
      const errTexto = await iotResponse.text();
      console.error(`[IoT TX ERROR] Status: ${iotResponse.status}`);
      console.error(`[IoT TX ERROR] Body: ${errTexto}`);
      console.error(`[IoT TX ERROR] Headers:`, Object.fromEntries(iotResponse.headers.entries()));
      throw new Error("No se pudo entregar el mensaje al dispositivo físico");
    }
    console.log(`[IoT TX OK] Mensaje entregado exitosamente al dispositivo.`);
    return new Response(JSON.stringify({ success: true, message: "Orquestación exitosa" }), { 
      status: 200, 
      headers: { "Content-Type": "application/json" } 
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error crítico en orquestador_iot:", errorMessage);
    return new Response(JSON.stringify({ error: "Fallo interno en el orquestador" }), { status: 500 });
  }
});