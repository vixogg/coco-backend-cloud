# Contexto del Proyecto COCO (Backend & Arquitectura Cloud)

## 1. Visión General y Flujo del Ecosistema
COCO es un dispositivo IoT (altavoz inteligente con filosofía Zero-UI) diseñado para adultos mayores en Chile. El backend en Supabase es el cerebro que conecta tres mundos:
*   **Hardware (El abuelo):** Habla y escucha a través del dispositivo físico.
*   **App Móvil (Los cuidadores):** Envían mensajes y reciben alertas SOS desde su teléfono.
*   **IA:** Procesa el audio, detecta intenciones y sintetiza voz.

## 2. El Equipo y las Integraciones
*   **Vicente (Backend & Cloud - Nuestro Rol):** Orquestamos todo mediante Supabase Edge Functions (Deno). Conectamos la base de datos, manejamos la seguridad JWT/SigV4 y somos el puente de comunicación de todos los demás.
*   **Andrés (Hardware & MQTT):** Desarrolla el dispositivo/simulador. Nos envía datos por el tópico `coco/simulador/tx` y nosotros le enviamos respuestas (audios/comandos) al tópico `coco/dispositivos/{mac_address}/rx` mediante el puente HTTPS de AWS IoT Core.
*   **Martín (App Móvil React Native):** Desarrolla la app para la red de apoyo. Su app consumirá nuestras Edge Functions (como `app_mensajeria`) enviando peticiones REST para comunicarse con el abuelo.
*   **Diego (Inteligencia Artificial):** Provee los microservicios (`services/`) para transcribir (Deepgram), razonar (Gemini/Claude) y hablar (AWS Polly). Nosotros consumimos sus servicios en nuestras funciones.

## 3. Arquitectura de Base de Datos Core
- `adultos_mayores`: (PK: `id`, `nombre`, `fecha_nacimiento`).
- `usuarios_app`: Cuidadores que usan la app móvil (PK: `id` vinculado a `auth.users`).
- `dispositivos_coco`: El hardware (PK: `id`, `mac_address` UNIQUE, FK: `adulto_mayor_id`).
- `red_apoyo`: Relación cuidador-dispositivo (FK: `dispositivo_id`, `usuario_app_id`, `rol`, `apodos_reconocimiento`).
- `historial_interacciones`: Registro de todo evento (FK: `dispositivo_id`, `destinatario_id`, `emisor`: 'COCO'|'APP', `tipo_evento`: 'MENSAJE'|'ALERTA_SOS'|'RECORDATORIO'|'AUDIO_DIRECTO', `estado_reproduccion`, `prioridad`).

## 4. Contratos de Datos (Definidos por IA - Diego)
El agente LLM de orquestación devuelve y procesa estas interfaces estrictas:

export type TipoEvento = "MENSAJE" | "ALERTA_SOS";
export type FormatoPayload = "AUDIO_B64";
export type IntencionDetectada = "MENSAJE" | "ALERTA_SOS" | "RECORDATORIO" | "AUDIO_DIRECTO";
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

## 5. Reglas Críticas de Arquitectura (NUNCA ROMPER)
1.  **Firma AWS SigV4 en Deno:** Para publicar mensajes hacia la placa de Andrés vía AWS IoT Core, la petición HTTP POST DEBE estar firmada con `aws-signature-v4`.
    *   `service` = `"iotdata"` (¡Obligatorio!).
    *   Limpiar el host: El parámetro `url` del firmador SigV4 **NO debe llevar `https://`** (usar `.replace(/^https?:\/\//, '')`).
    *   No codificar slashes: NUNCA usar `encodeURIComponent` en el nombre del tópico para no romper el hash de la firma.
    *   Las cabeceras como `"Content-Type": "application/json"` DEBEN incluirse dentro de la función generadora de la firma.
2.  **Audio AWS Polly:** El texto se convierte a TTS con Polly, retorna Uint8Array y debe convertirse a string Base64 puro antes de enviarse en el payload JSON.
3.  **Seguridad App Móvil:** Las funciones consumidas por la app de Martín deben validar el token JWT del usuario emisor (`req.headers.get("Authorization")`).

## 6. Estado Actual del Proyecto
*   **[COMPLETADO] `orquestador_iot`:** Flujo de subida listo. Recibe MQTT (vía Webhook), procesa con IA, guarda en historial y devuelve audio al hardware.
*   **[COMPLETADO] `app_mensajeria`:** Flujo de bajada completo. Recibe peticiones REST de la App de Martín, consulta BD para nombre del adulto mayor y rol/apodo del emisor, construye frase introductoria dinámica, sintetiza audio con Polly, concatena bytes si es AUDIO, persiste en historial e invoca AWS IoT Core con SigV4.
*   **[PENDIENTE] `app_gestion`:** Endpoints para que Martín administre la red de apoyo.

## 7. Protocolo de Agentes IA (Instrucción Autónoma)
**Para cualquier agente que lea este archivo:** Cada vez que finalices una tarea, refactorices código o integres una nueva Edge Function, **debes actualizar obligatoriamente la sección "Estado Actual del Proyecto"** en este archivo `.md` añadiendo un bloque detallado de la iteración, qué hiciste, qué archivos tocaste y qué contexto nuevo debe recordarse.

---

## 8. Log de Iteraciones

### Iteración 1 — app_mensajeria (2026-09-23)

**Objetivo:** Implementar el flujo de bajada completo: App Móvil (Martín) → Backend → Hardware (Andrés).

**Archivos tocados:**
- `supabase/functions/app_mensajeria/index.ts` — Reescritura completa (era placeholder con TODOs).
- `supabase/functions/app_mensajeria/services/ttsService.ts` — Nuevo archivo. Copia adaptada del ttsService del orquestador (cada función Supabase es autónoma, no comparten módulos).

**Contrato de entrada (POST desde App de Martín):**
```json
{
  "mac_address": "00:11:22:AA:BB:CC",
  "emisor_id": "uuid-del-familiar",
  "tipo_mensaje": "TEXTO",
  "texto": "Hola abuelo",
  "audio_url": null
}
```

**Flujo implementado (7 pasos):**
1. Validación del JSON (400 si faltan `mac_address`, `emisor_id`, `tipo_mensaje`).
2. Consulta `dispositivos_coco` con join `adultos_mayores(nombre)` via `mac_address` → obtiene nombre del abuelo. (403 si no existe).
3. Consulta `red_apoyo` con `.maybeSingle()` (no lanza error en "no rows") → obtiene `rol` y `apodos_reconocimiento[]` del emisor.
4. Frase introductoria dinámica: con datos → `"Hola [Abuelo], tu [Rol] [Apodo] te envió un [mensaje/audio]."` / sin datos (fallback) → `"Hola [Abuelo], te enviaron un [mensaje/audio]."`.
5. Audio final:
   - `TEXTO`: string concatenado (intro + texto) → `synthesizeSpeech()` → un Uint8Array → Base64.
   - `AUDIO`: `synthesizeSpeech(intro)` → Uint8Array intro + `fetch(audio_url)` → Uint8Array original → `concatenarUint8Arrays()` → Base64.
6. Insert en `historial_interacciones` (`emisor: 'APP'`, `tipo_evento: 'MENSAJE'`, `estado_reproduccion: 'PENDIENTE'`, `prioridad: 'NORMAL'`). El `metadata_payload` incluye `frase_introductoria` para auditoría.
7. Publicación en `coco/dispositivos/{mac_address}/rx` via `aws4fetch` con `service: "iotdata"`, endpoint limpio sin `https://`, tópico sin `encodeURIComponent`.

**Decisiones de arquitectura relevantes:**
- Se usa `.maybeSingle()` para la consulta de `red_apoyo` (en lugar de `.single()`) para manejar el caso fallback sin lanzar excepción de "no rows found".
- `synthesizeSpeech()` de Polly retorna `Uint8Array`. La concatenación de bytes es a nivel de array crudo, por lo que en modo AUDIO se genera un único stream binario MP3+original. El hardware de Andrés lo recibirá como un solo bloque Base64.
- JWT del emisor **omitido intencionalmente** en esta iteración por requerimiento del desarrollador (modo desarrollo). Para producción, agregar `req.headers.get("Authorization")` y verificar contra `supabase.auth.getUser(token)`.
- `tipo_evento` en el payload descendente es `"MENSAJE"` (no `"MENSAJE_FAMILIAR"` como estaba en el placeholder anterior). Esto alinea con el enum `TipoEvento` definido en `types.ts` del orquestador.