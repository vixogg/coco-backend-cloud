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