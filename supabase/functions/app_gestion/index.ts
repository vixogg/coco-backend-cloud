import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  // Manejo de CORS obligatorio para peticiones desde aplicaciones móviles o web
  if (req.method === 'OPTIONS') {
    return new Response('ok', { 
      headers: { 
        "Access-Control-Allow-Origin": "*", 
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" 
      } 
    });
  }

  try {
    const payloadApp = await req.json();
    const { accion, mac_address, datos } = payloadApp;

    if (!accion || !mac_address) {
      return new Response(
        JSON.stringify({ error: "Faltan parametros: 'accion' o 'mac_address' son obligatorios." }), 
        { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    // Inicializar el cliente de Supabase usando las variables de entorno locales del archivo .env
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseKey);

    let resultadoOperacion = null;

    // Enrutador de operaciones administrativas
    if (accion === "AGREGAR_CONTACTO") {
      // TODO: Validar formato del contacto y agregarlo a la tabla 'red_apoyo'
      /*
      const { data, error } = await supabase
        .from('red_apoyo')
        .insert([{ dispositivo_mac: mac_address, nombre: datos.nombre, telefono: datos.telefono, relacion: datos.relacion }]);
      
      if (error) throw error;
      resultadoOperacion = "Contacto agregado exitosamente a la Red de Confianza.";
      */
    } else if (accion === "ACTUALIZAR_CONFIGURACION_DISPOSITIVO") {
      // TODO: Actualizar preferencias del dispositivo en la tabla 'dispositivos_coco' (ej. volumen, modo nocturno)
      /*
      const { data, error } = await supabase
        .from('dispositivos_coco')
        .update({ configuracion: datos.configuracion })
        .eq('mac_address', mac_address);
        
      if (error) throw error;
      resultadoOperacion = "Configuracion del dispositivo actualizada.";
      */
    } else if (accion === "LEER_HISTORIAL_ALERTAS") {
      // TODO: Consultar tabla 'historial_interacciones' filtrando solo por ALERTA_SOS
      /*
      const { data, error } = await supabase
        .from('historial_interacciones')
        .select('*')
        .eq('dispositivo_mac', mac_address)
        .eq('tipo_evento', 'ALERTA_SOS')
        .order('created_at', { ascending: false })
        .limit(10);
        
      if (error) throw error;
      resultadoOperacion = data;
      */
    } else {
      return new Response(
        JSON.stringify({ error: "Accion no reconocida por el backend." }), 
        { status: 400, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
      );
    }

    return new Response(
      JSON.stringify({ status: "success", data: resultadoOperacion ?? "Operacion simulada (Endpoints pendientes de activacion)" }),
      { status: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );

  } catch (error) {
    return new Response(
      JSON.stringify({ error: "Error interno procesando la operacion de gestion." }), 
      { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } }
    );
  }
});