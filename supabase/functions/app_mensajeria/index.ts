import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  // Configuración de CORS para permitir que la App de Flutter se conecte
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" } });
  }

  try {
    // 1. Recibir la petición POST desde la App Móvil de Martín
    const payloadApp = await req.json();
    const { mac_address, tipo_mensaje, texto, audio_url } = payloadApp;

    if (!mac_address || !tipo_mensaje) {
      return new Response(JSON.stringify({ error: "Faltan parámetros requeridos por el backend." }), { status: 400 });
    }

    let audioBase64ParaHardware = "";

    // 2. Procesamiento de Texto a Voz (Flujo Descendente)
    if (tipo_mensaje === "TEXTO" || tipo_mensaje === "RECORDATORIO") {
      console.log(`Convirtiendo texto a voz para el dispositivo: ${mac_address}`);
      // TODO: Llamada a Amazon Polly o al modelo TTS de Diego para convertir 'texto' a audio Base64
      /*
      const responseTTS = await fetch("URL_DEL_SERVICIO_TTS", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: texto, voice: "Lupe" })
      });
      const dataTTS = await responseTTS.json();
      audioBase64ParaHardware = dataTTS.audio_b64;
      */
      
      // Simulación temporal para pruebas
      audioBase64ParaHardware = "U0lNVUxBQ0lPTl9BVURJT19CQVNFNjQ="; 
      
    } else if (tipo_mensaje === "AUDIO_NATIVO" && audio_url) {
      // TODO: Descargar el archivo de Supabase Storage y convertirlo a Base64
      console.log(`Procesando nota de voz nativa desde URL: ${audio_url}`);
    }

    // 3. Enviar el audio procesado al hardware vía AWS IoT Core (Tópico Rx)
    // El backend actúa como puente inyectando el dato en el túnel MQTT de bajada
    /*
    const awsEndpoint = Deno.env.get("AWS_IOT_ENDPOINT");
    await fetch(`${awsEndpoint}/topics/coco/dispositivos/${mac_address}/rx`, {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        // Aquí se requiere firma AWS SigV4 en producción
      },
      body: JSON.stringify({
        mac_address: mac_address,
        tipo_evento: "MENSAJE_FAMILIAR",
        formato_payload: "AUDIO_B64",
        data: audioBase64ParaHardware,
        prioridad: tipo_mensaje === "RECORDATORIO" ? "URGENTE" : "NORMAL"
      })
    });
    */

    console.log(`[Éxito] Mensaje enrutado hacia el dispositivo ${mac_address}`);

    return new Response(
      JSON.stringify({ status: "success", message: "Mensaje procesado y enviado a la cola MQTT." }),
      { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );

  } catch (error) {
    console.error("Error en app_mensajeria:", error.message);
    return new Response(
      JSON.stringify({ error: "Fallo interno procesando el mensaje de la App." }), 
      { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }
});