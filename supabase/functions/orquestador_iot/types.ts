export type TipoEvento = "MENSAJE" | "ALERTA_SOS";

export type FormatoPayload = "AUDIO_B64";

export type IntencionDetectada =
  | "MENSAJE"
  | "ALERTA_SOS"
  | "RECORDATORIO"
  | "AUDIO_DIRECTO";

export type PrioridadSugerida = "NORMAL" | "URGENTE";

export interface ProcessAudioRequest {
  mac_address: string;
  tipo_evento: TipoEvento;
  formato_payload: FormatoPayload;
  data: string;
}

export interface GeminiResponse {
  intencion_detectada: IntencionDetectada;
  destinatario_identificado: string | null;
  prioridad_sugerida: PrioridadSugerida;
  respuesta_sintetizada: string;
}

export interface ProcessedMessage {
  mac_address: string;
  tipo_evento: TipoEvento;
  classification: GeminiResponse;
}

/* ============================================================================
   CONTRATO INTERNO DEL ASISTENTE CONVERSACIONAL (Iteración 10)
   No reemplaza a GeminiResponse: es un sobre interno del backend/IA.
   "CONVERSACION" nunca sale de la Edge Function; se persiste como "MENSAJE".
   ============================================================================ */

export type IntencionAsistente = IntencionDetectada | "CONVERSACION";

export type Herramienta =
  | "NINGUNA"
  | "CLIMA"
  | "NOTICIAS"
  | "ENCICLOPEDIA"
  | "INDICADORES"
  | "CALENDARIO"
  | "BUSQUEDA_WEB";

export interface RespuestaAsistente {
  intencion_detectada: IntencionAsistente;
  destinatario_identificado: string | null;
  prioridad_sugerida: PrioridadSugerida;
  herramienta: Herramienta;
  herramienta_parametro: string | null;
  respuesta_sintetizada: string;
}

/** Resultado final de responderConContexto (incluye trazabilidad de la herramienta usada). */
export interface ResultadoAsistente extends RespuestaAsistente {
  herramienta_usada: Herramienta;
}

export interface ContactoRed {
  usuario_app_id: string;
  nombre: string | null;
  rol: string | null;
  apodos_reconocimiento: string[] | null;
}

export interface TurnoReciente {
  hace_minutos: number;
  texto_usuario: string;
  respuesta_coco: string | null;
}

export interface ContextoConversacional {
  nombre_adulto: string | null;
  edad_adulto: number | null;
  fecha_hora_local: string | null;
  timezone: string | null;
  red_apoyo: ContactoRed[];
  turnos_recientes: TurnoReciente[];
}