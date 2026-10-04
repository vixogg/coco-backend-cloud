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
*   **Diego (Inteligencia Artificial):** Provee los microservicios (`services/`) para transcribir (Deepgram), razonar (Gemini como primario + **Groq como respaldo automático**) y hablar (**ElevenLabs**, formato MP3 `audio/mpeg`). Nosotros consumimos sus servicios actualizados en nuestras funciones.

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

## 5.5. Stack Tecnológico de IA (Servicios de Diego)

| Capa | Proveedor actual | Formato de salida | Variables de entorno clave |
|---|---|---|---|
| **STT** | Deepgram (`nova-2`) | texto | `DEEPGRAM_API_KEY`, `DEEPGRAM_LANGUAGE` |
| **LLM Primario** | Google Gemini | JSON estructurado | `GEMINI_API_KEY`, `GEMINI_MODEL` |
| **LLM Respaldo** | Groq (Chat Completions) | JSON estructurado | `GROQ_API_KEY`, `GROQ_MODEL` |
| **TTS** | ElevenLabs (`eleven_v4_turbo`) | **MP3** (`audio/mpeg`) | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |

> **Nota de formato de audio:** ElevenLabs reemplazó a Amazon Polly como servicio TTS. Los audios ahora llegan en formato **MP3 (`audio/mpeg`, `mp3_44100_128`)**, no WAV. La interfaz `synthesizeSpeech(text): Promise<Uint8Array>` es idéntica a la anterior, por lo que los `index.ts` no requirieron cambios en sus llamadas. El Doble Despacho Secuencial de `app_mensajeria` y todos los bypass del `orquestador_iot` operan igual.

> **Nota de fallback LLM:** Groq se activa automáticamente cuando Gemini falla por timeout, rate-limit (429), error de servidor (5xx) o respuesta JSON inválida. Errores de config, auth o modelo incorrecto **no** activan el fallback (son fatales). Ambos proveedores producen exactamente el mismo contrato `GeminiResponse`.

## 6. Estado Actual del Proyecto
*   **[COMPLETADO] `orquestador_iot`:** Flujo de subida listo. Recibe MQTT (vía Webhook), procesa con IA (Gemini + Groq fallback), guarda en historial y devuelve audio MP3 (ElevenLabs) al hardware.
*   **[COMPLETADO] `app_mensajeria`:** Flujo de bajada completo. Recibe peticiones REST de la App de Martín, consulta BD para nombre del adulto mayor y rol/apodo del emisor, construye frase introductoria dinámica, sintetiza audio MP3 con ElevenLabs, aplica Doble Despacho MQTT si es AUDIO, persiste en historial e invoca AWS IoT Core con SigV4.
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

---

### Iteración 2 — Refinamiento Storage SDK en app_mensajeria (2026-09-23)

**Objetivo:** Reemplazar la descarga pública con `fetch()` por integración segura con Supabase Storage SDK, garantizar concatenación robusta de bytes y añadir auditoría del path en historial.

**Archivos tocados:**
- `supabase/functions/app_mensajeria/index.ts` — 3 bloques modificados quirúrgicamente.

**Cambios específicos:**

1. **Descarga segura con Storage SDK** (antes: `fetch(audio_url)` público):
   ```typescript
   const { data: blobDescargado, error: errorStorage } = await supabase
     .storage
     .from("audios_directos_coco")
     .download(audio_url!); // audio_url es PATH interno, no URL pública
   ```
   El `service_role_key` del cliente ya inicializado da acceso a buckets privados sin URLs firmadas.

2. **Manejo de error 404 de Storage** — Se añadió clase `StorageNotFoundError` para diferenciar "archivo no encontrado en bucket" de errores genéricos de BD o TTS. Logs descriptivos incluyen el path que falló.

3. **Concatenación explícita de bytes** (más clara que la función helper anterior):
   ```typescript
   const totalLength = audioIntroBytes.length + audioOriginalBytes.length;
   const audioUnificado = new Uint8Array(totalLength);
   audioUnificado.set(audioIntroBytes, 0);
   audioUnificado.set(audioOriginalBytes, audioIntroBytes.length);
   ```

4. **Auditoría en metadata_payload** — Campo `url_audio_referencia` renombrado a `ruta_storage` para comunicar semánticamente que es un path de bucket, no una URL HTTP. Permite recuperar el archivo original en el futuro sin URLs firmadas expiradas.

**Contrato de entrada actualizado para tipo_mensaje AUDIO:**
```json
{
  "mac_address": "00:11:22:AA:BB:CC",
  "emisor_id": "uuid-del-familiar",
  "tipo_mensaje": "AUDIO",
  "texto": null,
  "audio_url": "mensajes/nota_123.wav"
}
```
`audio_url` ahora es el **path interno** del archivo en el bucket `audios_directos_coco`, no una URL pública.

---

### Iteración 3 — Doble Despacho MQTT y Ajuste de Metadata (2026-09-23)

**Objetivo:** (1) Resolver incompatibilidad de codecs entre la intro de Polly (WAV/MP3) y la nota de voz de la app (AAC) mediante un patrón de Doble Despacho Secuencial. (2) Alinear las llaves de `metadata_payload` con el contrato de la UI de Martín.

**Archivos tocados:**
- `supabase/functions/app_mensajeria/index.ts` — Refactoring del PASO 5+7 y del PASO 6.

**Cambios específicos:**

1. **Doble Despacho Secuencial (Caso B — AUDIO):**
   - El antiguo patrón concatenaba bytes en memoria y enviaba un solo payload MQTT. Esto corrompe el audio porque la placa no puede decodificar un stream que mezcla MP3 (Polly) con AAC (App).
   - Nuevo patrón:
     1. Polly sintetiza la intro → Base64 → **Primer MQTT publish** (firma SigV4).
     2. `await new Promise(resolve => setTimeout(resolve, 3500))` — delay para dar tiempo al hardware de reproducir la intro completa.
     3. `supabase.storage.from("audios_directos_coco").download(path)` → Base64 → **Segundo MQTT publish** (misma instancia `AwsClient`, mismo tópico).

2. **Función auxiliar `publicarEnIoT(audioB64, etiquetaLog)`:**
   - Centraliza el bloque `awsClient.fetch + validación de respuesta` para evitar duplicación. Se invoca hasta 2 veces en el Caso B.
   - Credenciales AWS y `AwsClient` se instancian **una sola vez** fuera de los casos A/B.

3. **Caso A (TEXTO) sin cambio de comportamiento:**
   - Sigue usando un único TTS del string completo (intro + texto) y un único MQTT publish.

4. **Actualización de `metadata_payload`** para alinearse con la UI de Martín:
   ```typescript
   metadata_payload: {
     texto_procesado: tipo_mensaje === "TEXTO" ? texto : null,
     url_audio_referencia: tipo_mensaje === "AUDIO" ? audio_url : null, // path de Storage
     procesado_por_ia: false,
     duracion_segundos: null,
     tipo_mensaje_original: tipo_mensaje,
     frase_introductoria: fraseIntroductoria,
   }
   ```

5. **Respuesta HTTP actualizada:** El campo `audio_bytes_total` fue reemplazado por `despachos_mqtt` (1 para TEXTO, 2 para AUDIO) ya que ya no hay un único array de bytes final.

**Decisiones de arquitectura relevantes:**
- El delay de 3500ms es un valor fijo conservador. En el futuro puede hacerse dinámico usando la duración del audio de intro (si Polly la retorna) o mediante un ACK del hardware.
- La descarga de Storage ocurre **después** del primer MQTT publish y el delay, no antes. Esto optimiza el tiempo total: mientras el hardware reproduce la intro, el backend ya está descargando la nota de voz.
- `StorageNotFoundError` sigue activo para diferenciar el error de 404 de bucket de errores de red genéricos.

---

### Iteración 4 — Refactor orquestador_iot: AUDIO_DIRECTO Bypass + CONFIRMACION_ESCUCHA (2026-09-23)

**Objetivo:** (1) Implementar el bypass completo para notas de voz del hardware (`tipo_evento === "AUDIO_DIRECTO"`) con Storage path interno, historial propio y early return. (2) Corregir el gatillo `CONFIRMACION_ESCUCHA` para que se active solo con la intención detectada por Gemini, sin requerir `destinatario_identificado`.

**Archivos tocados:**
- `supabase/functions/orquestador_iot/index.ts` — SECCIÓN 4 (CASO 2 y CASO 3).

**Cambios específicos:**

1. **CASO 2 — AUDIO_DIRECTO Bypass (reescritura completa):**
   - **Antes:** Usaba `getPublicUrl()` (URL pública expuesta), `throw` bloqueante si fallaba el upload, caía a SECCIÓN 5-6 para el historial y el dispatch.
   - **Ahora:**
     - Path interno `mensajes/coco_audio_rx_${Date.now()}.wav` (no URL pública).
     - Upload con `try/catch` no bloqueante: si falla, el hardware igual recibe su confirmación de audio.
     - Insert propio en `historial_interacciones` con `metadata_payload: { url_audio_referencia: rutaStorage | null, procesado_por_ia: false }`.
     - TTS: `"Tu mensaje fue enviado exitosamente."` → Polly → Base64.
     - Dispatch MQTT propio con `AwsClient` + `service: "iotdata"` → `tipo_evento: "RESPUESTA_IA"`.
     - **Early return** inmediato: no continúa a SECCIÓN 5-6.

2. **CASO 3 — Gatillo CONFIRMACION_ESCUCHA (fix condición):**
   - **Antes:** `if (classification.intencion_detectada === "AUDIO_DIRECTO" && classification.destinatario_identificado)` — el gatillo no se activaba si Gemini no identificaba un destinatario.
   - **Ahora:** `if (classification.intencion_detectada === "AUDIO_DIRECTO")` — la intención sola es suficiente para abrir el micrófono.

**Flujo actualizado del orquestador (SECCIÓN 4):**
```
tipo_evento === "ALERTA_SOS" + data === "EMERGENCIA_BOTON_PANICO"
  → CASO 1: Bypass SOS → historial (en SECCIÓN 5) → MQTT → return 200

tipo_evento === "AUDIO_DIRECTO" + formato === "AUDIO_B64"
  → CASO 2: Bypass Storage → upload (no bloqueante) → historial propio → TTS confirmación → MQTT → EARLY RETURN ←

formato === "AUDIO_B64" (flujo normal)
  → CASO 3: Deepgram → Gemini (+ Groq fallback) → ElevenLabs
    Si intencion === "AUDIO_DIRECTO": tipo_evento_bajada = "CONFIRMACION_ESCUCHA"
    Si no: tipo_evento_bajada = "RESPUESTA_IA"
  → historial (en SECCIÓN 5) → MQTT → return 200
```

**Decisiones de arquitectura relevantes:**
- El upload de Storage en CASO 2 es no bloqueante porque la experiencia del hardware no debe depender de la disponibilidad del bucket. El hardware siempre recibe su `"Tu mensaje fue enviado exitosamente."`.
- `url_audio_referencia` en `metadata_payload` del CASO 2 puede ser `null` si el upload falla, lo cual es intencionado y auditable.
- El CASO 2 instancia su propio `AwsClient` (no reutiliza el de SECCIÓN 6) porque retorna early antes de llegar a esa sección. Las reglas SigV4 son idénticas.

---

### Iteración 5 — Migración TTS a ElevenLabs + LLM Groq Fallback (2026-10-04)

**Objetivo:** Integrar los microservicios actualizados de Diego: reemplazar Amazon Polly por ElevenLabs (TTS) e incorporar Groq como LLM de respaldo automático cuando Gemini falla.

**Archivos tocados:**
- `supabase/functions/orquestador_iot/services/ttsService.ts` — Reescritura completa: Polly (SigV4 manual ~258 líneas) → ElevenLabs REST (79 líneas).
- `supabase/functions/app_mensajeria/services/ttsService.ts` — Ídem anterior (cada función Supabase es autónoma, no comparten módulos).
- `supabase/functions/orquestador_iot/services/llmService.ts` — Reescritura completa: Gemini solo → Gemini primario + Groq fallback. Jerarquía de errores renombrada de `GeminiServiceError` → `LLMServiceError` (agnóstica al proveedor).
- `supabase/functions/orquestador_iot/services/sttService.ts` — Sincronización con `services_new/` de Diego (sin cambios funcionales).
- `AGENTS.md` — Sección 2 (equipo), nueva sección 5.5 (stack IA), sección 6 (estado) y log de iteración actualizados.

**Fuentes de referencia:**
- `supabase/functions/services_new/` — Carpeta con los nuevos archivos de Diego.
- `README_diego.md` — Documentación oficial del nuevo stack.

**Resultado del análisis de integración (Regla de Oro):**
| Función pública | Firma antes | Firma después | ¿Cambió index.ts? |
|---|---|---|---|
| `synthesizeSpeech(text)` | `Promise<Uint8Array>` | `Promise<Uint8Array>` | **NO** |
| `classifyTranscription(t, mac, tipo)` | `Promise<GeminiResponse>` | `Promise<GeminiResponse>` | **NO** |
| `transcribeAudio(audio)` | `Promise<string>` | `Promise<string>` | **NO** |

Los `index.ts` de `orquestador_iot` y `app_mensajeria` **no requirieron ninguna modificación**. Toda la lógica de negocio (Bypass AUDIO_DIRECTO, CONFIRMACION_ESCUCHA, Doble Despacho Secuencial 3.5s) quedó intacta.

**Cambios internos relevantes en los nuevos servicios:**

1. **ttsService.ts (ElevenLabs):**
   - Autenticación: `xi-api-key` en header (no SigV4). Elimina todas las funciones de firma criptográfica.
   - Endpoint: `https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}?output_format=mp3_44100_128`.
   - Formato de salida: **MP3 (`audio/mpeg`)** en lugar de WAV/MP3 de Polly.
   - Variables de entorno nuevas: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID` (default: `eleven_v4_turbo`), `ELEVENLABS_TIMEOUT_MS`.
   - Variables de entorno obsoletas (eliminar de secrets): `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `POLLY_VOICE_ID`, `POLLY_OUTPUT_FORMAT`, `POLLY_TIMEOUT_MS`.

2. **llmService.ts (Gemini + Groq fallback):**
   - `classifyTranscription()` intenta Gemini primero (con reintentos configurables).
   - Si Gemini falla por timeout/rate-limit/5xx/JSON inválido → activa `callGroq()` como respaldo.
   - Errores fatales (config, auth, modelo no encontrado, bad request) **no** activan el fallback.
   - Groq usa la API OpenAI-compatible: `https://api.groq.com/openai/v1/chat/completions`.
   - Variables de entorno nuevas: `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_TIMEOUT_MS`.
   - System prompt mejorado: más explícito, con ejemplos detallados y reglas numeradas.
   - Jerarquía de errores refactorizada (agnóstica al proveedor): `LLMServiceError` → `LLMError`, `LLMConfigError`, `LLMAuthError`, `LLMTimeoutError`, `LLMInvalidResponseError`, `LLMModelNotFoundError`, `LLMBadRequestError`.

**Variables de entorno que deben agregarse a Supabase Secrets:**
```
ELEVENLABS_API_KEY=<tu_api_key>
ELEVENLABS_VOICE_ID=<id_de_voz>
ELEVENLABS_MODEL_ID=eleven_v4_turbo
ELEVENLABS_TIMEOUT_MS=10000
GROQ_API_KEY=<tu_api_key>
GROQ_MODEL=<modelo_ej_llama-3.3-70b-versatile>
GROQ_TIMEOUT_MS=10000
```
