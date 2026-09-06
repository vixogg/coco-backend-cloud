import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    // 1. Recepcion del Webhook desde AWS IoT Core
    const payloadIoT = await req.json();
    const { mac_address, tipo_evento, formato_payload, data } = payloadIoT;

    if (!mac_address || !tipo_evento || !formato_payload || !data) {
      return new Response(
        JSON.stringify({ error: "Payload invalido segun el Contrato IOT." }), 
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Inicializar cliente de Supabase para consultas a la Base de Datos
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseKey);

    let intencionFinal = "";
    let destinatario = null;
    let respuestaAudio = "";

    // 2. Clasificacion de Evento: Fisico vs Voz
    if (tipo_evento === "BOTON_SOS") {
      // Si el evento viene del boton fisico, definimos la intencion directamente
      intencionFinal = "ALERTA_SOS";
      
    } else if (tipo_evento === "MENSAJE") {
      // TODO: Peticion HTTP real a los modelos de Inteligencia Artificial
      // Aqui se debe enviar el audio en Base64 ('data') a Deepgram para STT
      // y luego el texto a Claude 3 Haiku para extraer la intencion y generar respuesta.
      /*
      const responseIA = await fetch("URL_DE_TU_SERVICIO_DE_IA_O_CONTENEDOR", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${Deno.env.get("IA_API_KEY")}` },
        body: JSON.stringify({
          audio_b64: data,
          contexto: "Instrucciones de prompt engineering"
        })
      });
      const resultadoIA = await responseIA.json();
      
      intencionFinal = resultadoIA.intencion_detectada;
      destinatario = resultadoIA.destinatario_identificado;
      respuestaAudio = resultadoIA.respuesta_sintetizada;
      */
    }

    // 3. Enrutamiento y Ejecucion de Acciones en Backend
    if (intencionFinal === "ALERTA_SOS") {
      // Ejecucion de notificacion a la red de apoyo
      // TODO: 1. Consultar la tabla 'red_apoyo' para obtener los tokens de los familiares vinculados a este mac_address
      /*
      const { data: familiares, error } = await supabase
        .from('red_apoyo')
        .select('push_token')
        .eq('dispositivo_mac', mac_address);
      
      if (error) throw error;
      */

      // TODO: 2. Disparar notificacion Push a Firebase Cloud Messaging (FCM) o servicio nativo
      /*
      await fetch("https://fcm.googleapis.com/fcm/send", {
        method: "POST",
        headers: { "Authorization": `key=${Deno.env.get("FCM_SERVER_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          registration_ids: familiares.map(f => f.push_token),
          notification: { title: "¡Emergencia COCO!", body: "El dispositivo ha emitido una alerta SOS." }
        })
      });
      */
      
    } else if (intencionFinal === "MENSAJE" || intencionFinal === "AUDIO_PENDIENTE") {
      // TODO: Enviar audio de respuesta (TTS de Amazon Polly o confirmacion) de vuelta al dispositivo
      // Esto requiere hacer una peticion HTTP a la API de AWS IoT Core publicando en el topico Rx del hardware
      /*
      await fetch(`https://TU_ENDPOINT_AWS.iot.region.amazonaws.com/topics/coco/dispositivos/${mac_address}/rx`, {
        method: "POST",
        headers: { "x-amzn-iot-thingname": mac_address },
        body: JSON.stringify({
          mac_address: mac_address,
          tipo_evento: "RESPUESTA_IA",
          formato_payload: "AUDIO_B64",
          data: respuestaAudio // Previamente convertido a Base64
        })
      });
      */
    }

    // 4. Cierre del Webhook
    return new Response(
      JSON.stringify({ status: "success", intencion: intencionFinal }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: "Fallo interno en el procesamiento del Webhook." }), 
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});