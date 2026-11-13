# Contexto del Proyecto COCO (Backend & Arquitectura Cloud)

## 1. Visión General y Flujo del Ecosistema

COCO es un dispositivo IoT (altavoz inteligente con filosofía Zero-UI) diseñado
para adultos mayores en Chile. El backend en Supabase es el cerebro que conecta
tres mundos:

- **Hardware (El abuelo):** Habla y escucha a través del dispositivo físico.
- **App Móvil (Los cuidadores):** Envían mensajes y reciben alertas SOS desde su
  teléfono.
- **IA:** Procesa el audio, detecta intenciones y sintetiza voz.

## 2. El Equipo y las Integraciones

- **Vicente (Backend & Cloud - Nuestro Rol):** Orquestamos todo mediante
  Supabase Edge Functions (Deno). Conectamos la base de datos, manejamos la
  seguridad JWT/SigV4 y somos el puente de comunicación de todos los demás.
- **Andrés (Hardware & MQTT):** Desarrolla el dispositivo/simulador. Nos envía
  datos por el tópico `coco/simulador/tx` y nosotros le enviamos respuestas
  (audios/comandos) al tópico `coco/dispositivos/{mac_address}/rx` mediante el
  puente HTTPS de AWS IoT Core.
- **Martín (App Móvil React Native):** Desarrolla la app para la red de apoyo.
  Su app consumirá nuestras Edge Functions (como `app_mensajeria`) enviando
  peticiones REST para comunicarse con el abuelo.
- **Diego (Inteligencia Artificial):** Provee los microservicios (`services/`)
  para transcribir (Deepgram), razonar (Gemini como primario + **Groq como
  respaldo automático**) y hablar (**ElevenLabs**, formato MP3 `audio/mpeg`).
  Nosotros consumimos sus servicios actualizados en nuestras funciones.

## 3. Arquitectura de Base de Datos Core

- `adultos_mayores`: (PK: `id`, `nombre`, `fecha_nacimiento`).
- `usuarios_app`: Cuidadores que usan la app móvil (PK: `id` vinculado a
  `auth.users`).
- `dispositivos_coco`: El hardware (PK: `id`, `mac_address` UNIQUE, FK:
  `adulto_mayor_id`).
- `red_apoyo`: Relación cuidador-dispositivo (FK: `dispositivo_id`,
  `usuario_app_id`, `rol`, `apodos_reconocimiento`).
- `historial_interacciones`: Registro de todo evento (FK: `dispositivo_id`,
  `destinatario_id`, `emisor`: 'COCO'|'APP', `tipo_evento`:
  'MENSAJE'|'ALERTA_SOS'|'RECORDATORIO'|'AUDIO_DIRECTO', `estado_reproduccion`,
  `prioridad`).

## 4. Contratos de Datos (Definidos por IA - Diego)

El agente LLM de orquestación devuelve y procesa estas interfaces estrictas:

export type TipoEvento = "MENSAJE" | "ALERTA_SOS"; export type FormatoPayload =
"AUDIO_B64"; export type IntencionDetectada = "MENSAJE" | "ALERTA_SOS" |
"RECORDATORIO" | "AUDIO_DIRECTO"; export type PrioridadSugerida = "NORMAL" |
"URGENTE";

export interface ProcessAudioRequest { mac_address: string; tipo_evento:
TipoEvento; formato_payload: FormatoPayload; data: string; }

export interface GeminiResponse { intencion_detectada: IntencionDetectada;
destinatario_identificado: string | null; prioridad_sugerida: PrioridadSugerida;
respuesta_sintetizada: string; }

## 5. Reglas Críticas de Arquitectura (NUNCA ROMPER)

1. **Firma AWS SigV4 en Deno:** Para publicar mensajes hacia la placa de Andrés
   vía AWS IoT Core, la petición HTTP POST DEBE estar firmada con
   `aws-signature-v4`.
   - `service` = `"iotdata"` (¡Obligatorio!).
   - Limpiar el host: El parámetro `url` del firmador SigV4 **NO debe llevar
     `https://`** (usar `.replace(/^https?:\/\//, '')`).
   - No codificar slashes: NUNCA usar `encodeURIComponent` en el nombre del
     tópico para no romper el hash de la firma.
   - Las cabeceras como `"Content-Type": "application/json"` DEBEN incluirse
     dentro de la función generadora de la firma.
2. **Audio AWS Polly:** El texto se convierte a TTS con Polly, retorna
   Uint8Array y debe convertirse a string Base64 puro antes de enviarse en el
   payload JSON.
3. **Seguridad App Móvil:** Las funciones consumidas por la app de Martín deben
   validar el token JWT del usuario emisor (`req.headers.get("Authorization")`).

## 5.5. Stack Tecnológico de IA (Servicios de Diego)

| Capa             | Proveedor actual               | Formato de salida      | Variables de entorno clave                  |
| ---------------- | ------------------------------ | ---------------------- | ------------------------------------------- |
| **STT**          | Deepgram (`nova-2`)            | texto                  | `DEEPGRAM_API_KEY`, `DEEPGRAM_LANGUAGE`     |
| **LLM Primario** | Groq (Chat Completions)        | JSON estructurado      | `GROQ_API_KEY`, `GROQ_MODEL`                |
| **LLM Respaldo** | Google Gemini                  | JSON estructurado      | `GEMINI_API_KEY`, `GEMINI_MODEL`            |
| **TTS**          | ElevenLabs (`eleven_v4_turbo`) | **MP3** (`audio/mpeg`) | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` |

> **Nota de formato de audio:** ElevenLabs reemplazó a Amazon Polly como
> servicio TTS. Los audios ahora llegan en formato **MP3 (`audio/mpeg`,
> `mp3_44100_128`)**, no WAV. La interfaz
> `synthesizeSpeech(text): Promise<Uint8Array>` es idéntica a la anterior, por
> lo que los `index.ts` no requirieron cambios en sus llamadas. El Doble
> Despacho Secuencial de `app_mensajeria` y todos los bypass del
> `orquestador_iot` operan igual.

> **Nota de fallback LLM:** Groq se activa automáticamente cuando Gemini falla
> por timeout, rate-limit (429), error de servidor (5xx) o respuesta JSON
> inválida. Errores de config, auth o modelo incorrecto **no** activan el
> fallback (son fatales). Ambos proveedores producen exactamente el mismo
> contrato `GeminiResponse`.

## 6. Estado Actual del Proyecto

- **[COMPLETADO Y OPTIMIZADO] `orquestador_iot`:** Flujo de subida listo y
  optimizado en baja latencia. Incluye compuerta de idempotencia L1 en memoria
  (SHA-256 con TTL 60s), caché en RAM de dispositivos y de frases TTS estáticas,
  defensa en 3 capas contra exceso de bytes en AWS IoT Core (`max_tokens: 180` +
  truncamiento por oraciones a 240 chars + corte binario en límite exacto de
  frame MP3/WAV bajo `65 KB` crudos), persistencia asíncrona con
  `EdgeRuntime.waitUntil()`, resolución difusa en `red_apoyo` insensible a
  tildes/mayúsculas, y blindaje anti-reintentos (retorno `200 OK` controlado con
  audio de contingencia).
- **[COMPLETADO Y OPTIMIZADO] `app_mensajeria`:** Flujo de bajada completo y
  paralelizado. Incluye caché en RAM de dispositivos y saludos frecuentes de
  familiares, codificación Base64 nativa V8 (`toBase64`/`fromBase64`),
  pre-descarga paralela (`Promise.all`) de notas de voz desde Supabase Storage
  durante el Despacho 1 e inserción concurrente en `historial_interacciones`.
- **[PENDIENTE] `app_gestion`:** Endpoints para que Martín administre la red de
  apoyo.
- **[DESPLEGADO] Asistente conversacional (Iteración 10):**
  `orquestador_iot` ahora conversa como asistente general: contexto del abuelo
  (nombre, edad, fecha/hora local, red de apoyo), memoria corta (10 min),
  herramientas gratuitas en tiempo real (clima Open-Meteo, noticias Google News
  RSS, Wikipedia) y pistas de vocabulario para Deepgram. Contratos MQTT/BD sin
  cambios. Desplegado como `orquestador_iot` v55 (2026-11-12).
- **[DESPLEGADO] Herramientas de información real (Iteración 11 + 11.1):**
  ENCICLOPEDIA conserva fechas, salta desambiguaciones (reintenta con "Chile") y
  se complementa con la web para datos concretos o si no hay artículo; NOTICIAS
  multifuente (Google ∥ Bing News ∥ Cooperativa); INDICADORES (findic.cl ∥
  mindicador.cl), CALENDARIO (santoral/celebraciones Wikipedia, feriados boostr,
  fase lunar local) y BUSQUEDA_WEB (Tavily con `TAVILY_API_KEY` ∥ respaldo Bing
  RSS + Wikipedia, tope 4 s). Desplegado como `orquestador_iot` v58 (2026-11-12).

## 7. Protocolo de Agentes IA (Instrucción Autónoma)

**Para cualquier agente que lea este archivo:** Cada vez que finalices una
tarea, refactorices código o integres una nueva Edge Function, **debes
actualizar obligatoriamente la sección "Estado Actual del Proyecto"** en este
archivo `.md` añadiendo un bloque detallado de la iteración, qué hiciste, qué
archivos tocaste y qué contexto nuevo debe recordarse.

---

## 8. Log de Iteraciones

### Iteración 1 — app_mensajeria (2026-09-23)

**Objetivo:** Implementar el flujo de bajada completo: App Móvil (Martín) →
Backend → Hardware (Andrés).

**Archivos tocados:**

- `supabase/functions/app_mensajeria/index.ts` — Reescritura completa (era
  placeholder con TODOs).
- `supabase/functions/app_mensajeria/services/ttsService.ts` — Nuevo archivo.
  Copia adaptada del ttsService del orquestador (cada función Supabase es
  autónoma, no comparten módulos).

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

1. Validación del JSON (400 si faltan `mac_address`, `emisor_id`,
   `tipo_mensaje`).
2. Consulta `dispositivos_coco` con join `adultos_mayores(nombre)` via
   `mac_address` → obtiene nombre del abuelo. (403 si no existe).
3. Consulta `red_apoyo` con `.maybeSingle()` (no lanza error en "no rows") →
   obtiene `rol` y `apodos_reconocimiento[]` del emisor.
4. Frase introductoria dinámica: con datos →
   `"Hola [Abuelo], tu [Rol] [Apodo] te envió un [mensaje/audio]."` / sin datos
   (fallback) → `"Hola [Abuelo], te enviaron un [mensaje/audio]."`.
5. Audio final:
   - `TEXTO`: string concatenado (intro + texto) → `synthesizeSpeech()` → un
     Uint8Array → Base64.
   - `AUDIO`: `synthesizeSpeech(intro)` → Uint8Array intro + `fetch(audio_url)`
     → Uint8Array original → `concatenarUint8Arrays()` → Base64.
6. Insert en `historial_interacciones` (`emisor: 'APP'`,
   `tipo_evento: 'MENSAJE'`, `estado_reproduccion: 'PENDIENTE'`,
   `prioridad: 'NORMAL'`). El `metadata_payload` incluye `frase_introductoria`
   para auditoría.
7. Publicación en `coco/dispositivos/{mac_address}/rx` via `aws4fetch` con
   `service: "iotdata"`, endpoint limpio sin `https://`, tópico sin
   `encodeURIComponent`.

**Decisiones de arquitectura relevantes:**

- Se usa `.maybeSingle()` para la consulta de `red_apoyo` (en lugar de
  `.single()`) para manejar el caso fallback sin lanzar excepción de "no rows
  found".
- `synthesizeSpeech()` de Polly retorna `Uint8Array`. La concatenación de bytes
  es a nivel de array crudo, por lo que en modo AUDIO se genera un único stream
  binario MP3+original. El hardware de Andrés lo recibirá como un solo bloque
  Base64.
- JWT del emisor **omitido intencionalmente** en esta iteración por
  requerimiento del desarrollador (modo desarrollo). Para producción, agregar
  `req.headers.get("Authorization")` y verificar contra
  `supabase.auth.getUser(token)`.
- `tipo_evento` en el payload descendente es `"MENSAJE"` (no
  `"MENSAJE_FAMILIAR"` como estaba en el placeholder anterior). Esto alinea con
  el enum `TipoEvento` definido en `types.ts` del orquestador.

---

### Iteración 2 — Refinamiento Storage SDK en app_mensajeria (2026-09-23)

**Objetivo:** Reemplazar la descarga pública con `fetch()` por integración
segura con Supabase Storage SDK, garantizar concatenación robusta de bytes y
añadir auditoría del path en historial.

**Archivos tocados:**

- `supabase/functions/app_mensajeria/index.ts` — 3 bloques modificados
  quirúrgicamente.

**Cambios específicos:**

1. **Descarga segura con Storage SDK** (antes: `fetch(audio_url)` público):
   ```typescript
   const { data: blobDescargado, error: errorStorage } = await supabase
      .storage
      .from("audios_directos_coco")
      .download(audio_url!); // audio_url es PATH interno, no URL pública
   ```
   El `service_role_key` del cliente ya inicializado da acceso a buckets
   privados sin URLs firmadas.

2. **Manejo de error 404 de Storage** — Se añadió clase `StorageNotFoundError`
   para diferenciar "archivo no encontrado en bucket" de errores genéricos de BD
   o TTS. Logs descriptivos incluyen el path que falló.

3. **Concatenación explícita de bytes** (más clara que la función helper
   anterior):
   ```typescript
   const totalLength = audioIntroBytes.length + audioOriginalBytes.length;
   const audioUnificado = new Uint8Array(totalLength);
   audioUnificado.set(audioIntroBytes, 0);
   audioUnificado.set(audioOriginalBytes, audioIntroBytes.length);
   ```

4. **Auditoría en metadata_payload** — Campo `url_audio_referencia` renombrado a
   `ruta_storage` para comunicar semánticamente que es un path de bucket, no una
   URL HTTP. Permite recuperar el archivo original en el futuro sin URLs
   firmadas expiradas.

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

`audio_url` ahora es el **path interno** del archivo en el bucket
`audios_directos_coco`, no una URL pública.

---

### Iteración 3 — Doble Despacho MQTT y Ajuste de Metadata (2026-09-23)

**Objetivo:** (1) Resolver incompatibilidad de codecs entre la intro de Polly
(WAV/MP3) y la nota de voz de la app (AAC) mediante un patrón de Doble Despacho
Secuencial. (2) Alinear las llaves de `metadata_payload` con el contrato de la
UI de Martín.

**Archivos tocados:**

- `supabase/functions/app_mensajeria/index.ts` — Refactoring del PASO 5+7 y del
  PASO 6.

**Cambios específicos:**

1. **Doble Despacho Secuencial (Caso B — AUDIO):**
   - El antiguo patrón concatenaba bytes en memoria y enviaba un solo payload
     MQTT. Esto corrompe el audio porque la placa no puede decodificar un stream
     que mezcla MP3 (Polly) con AAC (App).
   - Nuevo patrón:
     1. Polly sintetiza la intro → Base64 → **Primer MQTT publish** (firma
        SigV4).
     2. `await new Promise(resolve => setTimeout(resolve, 3500))` — delay para
        dar tiempo al hardware de reproducir la intro completa.
     3. `supabase.storage.from("audios_directos_coco").download(path)` → Base64
        → **Segundo MQTT publish** (misma instancia `AwsClient`, mismo tópico).

2. **Función auxiliar `publicarEnIoT(audioB64, etiquetaLog)`:**
   - Centraliza el bloque `awsClient.fetch + validación de respuesta` para
     evitar duplicación. Se invoca hasta 2 veces en el Caso B.
   - Credenciales AWS y `AwsClient` se instancian **una sola vez** fuera de los
     casos A/B.

3. **Caso A (TEXTO) sin cambio de comportamiento:**
   - Sigue usando un único TTS del string completo (intro + texto) y un único
     MQTT publish.

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

5. **Respuesta HTTP actualizada:** El campo `audio_bytes_total` fue reemplazado
   por `despachos_mqtt` (1 para TEXTO, 2 para AUDIO) ya que ya no hay un único
   array de bytes final.

**Decisiones de arquitectura relevantes:**

- El delay de 3500ms es un valor fijo conservador. En el futuro puede hacerse
  dinámico usando la duración del audio de intro (si Polly la retorna) o
  mediante un ACK del hardware.
- La descarga de Storage ocurre **después** del primer MQTT publish y el delay,
  no antes. Esto optimiza el tiempo total: mientras el hardware reproduce la
  intro, el backend ya está descargando la nota de voz.
- `StorageNotFoundError` sigue activo para diferenciar el error de 404 de bucket
  de errores de red genéricos.

---

### Iteración 4 — Refactor orquestador_iot: AUDIO_DIRECTO Bypass + CONFIRMACION_ESCUCHA (2026-09-23)

**Objetivo:** (1) Implementar el bypass completo para notas de voz del hardware
(`tipo_evento === "AUDIO_DIRECTO"`) con Storage path interno, historial propio y
early return. (2) Corregir el gatillo `CONFIRMACION_ESCUCHA` para que se active
solo con la intención detectada por Gemini, sin requerir
`destinatario_identificado`.

**Archivos tocados:**

- `supabase/functions/orquestador_iot/index.ts` — SECCIÓN 4 (CASO 2 y CASO 3).

**Cambios específicos:**

1. **CASO 2 — AUDIO_DIRECTO Bypass (reescritura completa):**
   - **Antes:** Usaba `getPublicUrl()` (URL pública expuesta), `throw`
     bloqueante si fallaba el upload, caía a SECCIÓN 5-6 para el historial y el
     dispatch.
   - **Ahora:**
     - Path interno `mensajes/coco_audio_rx_${Date.now()}.wav` (no URL pública).
     - Upload con `try/catch` no bloqueante: si falla, el hardware igual recibe
       su confirmación de audio.
     - Insert propio en `historial_interacciones` con
       `metadata_payload: { url_audio_referencia: rutaStorage | null, procesado_por_ia: false }`.
     - TTS: `"Tu mensaje fue enviado exitosamente."` → Polly → Base64.
     - Dispatch MQTT propio con `AwsClient` + `service: "iotdata"` →
       `tipo_evento: "RESPUESTA_IA"`.
     - **Early return** inmediato: no continúa a SECCIÓN 5-6.

2. **CASO 3 — Gatillo CONFIRMACION_ESCUCHA (fix condición):**
   - **Antes:**
     `if (classification.intencion_detectada === "AUDIO_DIRECTO" && classification.destinatario_identificado)`
     — el gatillo no se activaba si Gemini no identificaba un destinatario.
   - **Ahora:** `if (classification.intencion_detectada === "AUDIO_DIRECTO")` —
     la intención sola es suficiente para abrir el micrófono.

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

- El upload de Storage en CASO 2 es no bloqueante porque la experiencia del
  hardware no debe depender de la disponibilidad del bucket. El hardware siempre
  recibe su `"Tu mensaje fue enviado exitosamente."`.
- `url_audio_referencia` en `metadata_payload` del CASO 2 puede ser `null` si el
  upload falla, lo cual es intencionado y auditable.
- El CASO 2 instancia su propio `AwsClient` (no reutiliza el de SECCIÓN 6)
  porque retorna early antes de llegar a esa sección. Las reglas SigV4 son
  idénticas.

---

### Iteración 5 — Migración TTS a ElevenLabs + LLM Groq Fallback (2026-10-04)

**Objetivo:** Integrar los microservicios actualizados de Diego: reemplazar
Amazon Polly por ElevenLabs (TTS) e incorporar Groq como LLM de respaldo
automático cuando Gemini falla.

**Archivos tocados:**

- `supabase/functions/orquestador_iot/services/ttsService.ts` — Reescritura
  completa: Polly (SigV4 manual ~258 líneas) → ElevenLabs REST (79 líneas).
- `supabase/functions/app_mensajeria/services/ttsService.ts` — Ídem anterior
  (cada función Supabase es autónoma, no comparten módulos).
- `supabase/functions/orquestador_iot/services/llmService.ts` — Reescritura
  completa: Gemini solo → Gemini primario + Groq fallback. Jerarquía de errores
  renombrada de `GeminiServiceError` → `LLMServiceError` (agnóstica al
  proveedor).
- `supabase/functions/orquestador_iot/services/sttService.ts` — Sincronización
  con `services_new/` de Diego (sin cambios funcionales).
- `AGENTS.md` — Sección 2 (equipo), nueva sección 5.5 (stack IA), sección 6
  (estado) y log de iteración actualizados.

**Fuentes de referencia:**

- `supabase/functions/services_new/` — Carpeta con los nuevos archivos de Diego.
- `README_diego.md` — Documentación oficial del nuevo stack.

**Resultado del análisis de integración (Regla de Oro):**

| Función pública                       | Firma antes               | Firma después             | ¿Cambió index.ts? |
| ------------------------------------- | ------------------------- | ------------------------- | ----------------- |
| `synthesizeSpeech(text)`              | `Promise<Uint8Array>`     | `Promise<Uint8Array>`     | **NO**            |
| `classifyTranscription(t, mac, tipo)` | `Promise<GeminiResponse>` | `Promise<GeminiResponse>` | **NO**            |
| `transcribeAudio(audio)`              | `Promise<string>`         | `Promise<string>`         | **NO**            |

Los `index.ts` de `orquestador_iot` y `app_mensajeria` **no requirieron ninguna
modificación**. Toda la lógica de negocio (Bypass AUDIO_DIRECTO,
CONFIRMACION_ESCUCHA, Doble Despacho Secuencial 3.5s) quedó intacta.

**Cambios internos relevantes en los nuevos servicios:**

1. **ttsService.ts (ElevenLabs):**
   - Autenticación: `xi-api-key` en header (no SigV4). Elimina todas las
     funciones de firma criptográfica.
   - Endpoint:
     `https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}?output_format=mp3_44100_128`.
   - Formato de salida: **MP3 (`audio/mpeg`)** en lugar de WAV/MP3 de Polly.
   - Variables de entorno nuevas: `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`,
     `ELEVENLABS_MODEL_ID` (default: `eleven_v4_turbo`),
     `ELEVENLABS_TIMEOUT_MS`.
   - Variables de entorno obsoletas (eliminar de secrets): `AWS_REGION`,
     `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `POLLY_VOICE_ID`,
     `POLLY_OUTPUT_FORMAT`, `POLLY_TIMEOUT_MS`.

2. **llmService.ts (Gemini + Groq fallback):**
   - `classifyTranscription()` intenta Gemini primero (con reintentos
     configurables).
   - Si Gemini falla por timeout/rate-limit/5xx/JSON inválido → activa
     `callGroq()` como respaldo.
   - Errores fatales (config, auth, modelo no encontrado, bad request) **no**
     activan el fallback.
   - Groq usa la API OpenAI-compatible:
     `https://api.groq.com/openai/v1/chat/completions`.
   - Variables de entorno nuevas: `GROQ_API_KEY`, `GROQ_MODEL`,
     `GROQ_TIMEOUT_MS`.
   - System prompt mejorado: más explícito, con ejemplos detallados y reglas
     numeradas.
   - Jerarquía de errores refactorizada (agnóstica al proveedor):
     `LLMServiceError` → `LLMError`, `LLMConfigError`, `LLMAuthError`,
     `LLMTimeoutError`, `LLMInvalidResponseError`, `LLMModelNotFoundError`,
     `LLMBadRequestError`.

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

---

### Iteracion 6 - Optimizacion de Latencia LLM: Budget System (2026-10-13)

**Objetivo:** Integrar la actualizacion de latencia entregada por Diego
(llmservice_new.ts). Reducir el tiempo de espera total del pipeline LLM y
garantizar que el fallback a Groq nunca se ejecute con tiempo insuficiente.

**Archivos tocados:**

- supabase/functions/orquestador_iot/services/llmService.ts — 3 bloques
  modificados quirurgicamente (callGemini, callGroq, classifyTranscription) +
  nueva seccion LLMBudget insertada.
- llmservice_new.ts (raiz) — Archivo de entrega de Diego; queda como referencia
  historica.

**Cambios exactos para reducir latencia:**

| Parametro              | Antes (v5)        | Ahora (v6)        | Variable de entorno          |
| ---------------------- | ----------------- | ----------------- | ---------------------------- |
| Timeout Gemini         | 45000ms (default) | 10000ms (default) | GEMINI_TIMEOUT_MS            |
| Max. reintentos Gemini | 3 (default)       | 2 (default)       | GEMINI_MAX_RETRIES           |
| Delay entre reintentos | 2000ms (default)  | 100ms (default)   | GEMINI_RETRY_DELAY_MS        |
| Timeout Groq           | 10000ms (default) | 6000ms (default)  | GROQ_TIMEOUT_MS              |
| Presupuesto total      | No existia        | 18000ms (default) | LLM_TOTAL_TIMEOUT_MS (nueva) |

**Nuevo mecanismo LLMBudget:**

- classifyTranscription() crea un presupuesto de tiempo al inicio:
  LLM_TOTAL_TIMEOUT_MS (default 18 s).
- El presupuesto se divide: Gemini puede usar todo el tiempo menos la reserva de
  Groq (GROQ_TIMEOUT_MS).
- callGemini() recibe el budget y aplica effectiveTimeout =
  Math.min(GEMINI_TIMEOUT_MS, budget.availableForGemini()).
- callGroq() recibe el budget y aplica effectiveTimeout =
  Math.min(GROQ_TIMEOUT_MS, budget.remaining()).
- Si Gemini falla y el budget no tiene tiempo para Groq (canRunGroq() = false),
  lanza LLMTimeoutError("llm-total").
- La condicion de reintento requiere ademas remainingBudget > retryDelayMs +
  groqReserve + 500ms.

**Telemetria anadida:** durationMs real en cada intento de Gemini/Groq; provider
y budgetRemaining al completar.

**Contrato de datos: INTACTO**

- Firma publica classifyTranscription(transcription, macAddress, tipoEvento):
  Promise<GeminiResponse> -> sin cambios.
- Fallback a Groq -> sigue activo, ahora budget-aware.
- index.ts del orquestador (bypass AUDIO_DIRECTO, CONFIRMACION_ESCUCHA) -> no
  tocado.

**Variables de entorno:**

- LLM_TOTAL_TIMEOUT_MS es la unica variable nueva. Default 18000ms cubre el caso
  comun sin configuracion adicional.
- NO se requiere supabase secrets set para que la actualizacion tome efecto.
  Solo redesplegar el codigo.

---

### Iteracion 7 - Inversion a Groq Primario + Gemini Fallback (2026-10-13)

**Objetivo:** Eliminar los picos de latencia (>12s), timeouts de Gemini y
errores HTTP 503 ('high demand'), los cuales provocaban que AWS IoT Core
reintentara 3 veces el webhook y el parlante repitiera el mensaje 3 veces.

**Archivos tocados:**

- `supabase/functions/orquestador_iot/services/llmService.ts` - Inversion del
  flujo en `classifyTranscription`: Groq se ejecuta como LLM primario
  (~300-700ms) y Gemini pasa a ser fallback secundario. Ajuste de `LLMBudget`
  (`canRunGemini`, `availableForGemini`) y condicion de reintento de Gemini.
- `AGENTS.md` - Actualizacion de tabla de stack IA, estado actual del proyecto y
  log de iteracion.

**Cambios clave:**

1. **Groq Primario:** `callGroq` se invoca primero en `classifyTranscription`.
   La inferencia en hardware LPU toma tipicamente menos de 1 segundo.
2. **Gemini Fallback:** Si Groq falla por timeout o error recuperable, se activa
   `callGemini` con el tiempo restante del presupuesto.
3. **Erradicacion de retries en AWS IoT Core:** Al responder el Edge Function en
   ~2.5s en total (STT Deepgram ~1s + Groq ~0.5s + ElevenLabs ~1s), AWS IoT Core
   recibe `HTTP 200 OK` de inmediato y no reintenta. Cero repeticiones en el
   hardware de Andres.
4. **Contrato intacto:** La firma publica
   `classifyTranscription(transcription, macAddress, tipoEvento): Promise<GeminiResponse>`
   se mantiene identica.

---

### Iteración 8 — Optimización Integral de Latencia, Control Determinista de Bytes (128 KB MQTT) e Idempotencia (2026-11-10)

**Objetivo:** (1) Erradicar definitivamente el error de exceso de bytes
(`Payload Too Large` en AWS IoT Core / buffer de hardware), los silencios y las
respuestas repetidas (2–3 veces) en preguntas largas o complejas. (2) Reducir
drásticamente la latencia end-to-end en `orquestador_iot` y `app_mensajeria` y
el tiempo bloqueante de escritura en base de datos, manteniendo el 100% de
compatibilidad con los contratos de Hardware (Andrés), App Móvil (Martín) e IA
(Diego).

**Archivos tocados:**

- `supabase/functions/orquestador_iot/services/performanceUtils.ts` — Nuevo
  módulo autónomo de utilitarios de rendimiento.
- `supabase/functions/app_mensajeria/services/performanceUtils.ts` — Nuevo
  módulo autónomo gemelo para `app_mensajeria`.
- `supabase/functions/orquestador_iot/services/llmService.ts` — Ajuste de
  `LLMBudget` (`8000ms`), `max_tokens: 180` / `maxOutputTokens: 180` y
  truncamiento semántico por oraciones en `validateLLMResponse`.
- `supabase/functions/orquestador_iot/index.ts` — Refactor de latencia,
  idempotencia L1, caché RAM, paralelización con `EdgeRuntime.waitUntil()` y
  salvaguarda anti-500.
- `supabase/functions/app_mensajeria/index.ts` — Refactor con pre-descarga
  paralela de Storage (`Promise.all`), caché de dispositivos e intros, e
  inserción concurrente en BD.
- `supabase/migrations/20261110_indices_rendimiento.sql` — Script SQL aditivo
  opcional con índices de cobertura (`CREATE INDEX IF NOT EXISTS`) para
  PostgreSQL.

**Cambios técnicos implementados:**

1. **Defensa en 3 Capas contra Desborde de Payload (`> 128 KB` en AWS IoT Core
   MQTT):**
   - **Capa 1 (Origen LLM):** Se configuró `max_tokens: 180` en `callGroq` y
     `maxOutputTokens: 180` en `callGemini` junto con la regla de máximo 2
     oraciones (~220 caracteres). Evita respuestas extensas sin truncar el
     cierre del JSON `GeminiResponse`.
   - **Capa 2 (Truncamiento Semántico Pre-TTS):**
     `truncateTextBySentences(texto, 240)` recorta en el último signo de cierre
     de oración (`.`, `!`, `?`) antes de enviar a ElevenLabs, asegurando
     locuciones de máximo ~15s (~60 KB en `mp3_22050_32` ≈ 80 KB en Base64).
   - **Capa 3 (Salvaguarda Binaria Post-TTS / Storage):**
     `ensureSafeAudioPayloadSize()` inspecciona el `Uint8Array` antes de
     codificar en Base64. Si es MP3 y supera `65,000 bytes` crudos (~86.6 KB
     Base64), corta en el último límite exacto de frame MPEG Layer III
     (`0xFF 0xE0`). Si es un archivo `.wav` (en `app_mensajeria`) y supera
     `94,000 bytes` crudos (~125.3 KB Base64), recorta en múltiplo de 4 bytes y
     actualiza los campos `ChunkSize` y `Subchunk2Size` de la cabecera RIFF/WAV
     para conservar un archivo WAV 100% válido.

2. **Erradicación de Respuestas Repetidas y Silencios (`orquestador_iot`):**
   - **Idempotencia L1 en Memoria (`computeWebhookRequestHash` +
     `isDuplicateInMemoryL1`):** Calcula una huella SHA-256 en `< 0.2ms` a la
     entrada del Webhook. Si AWS IoT Core reintenta el mismo paquete dentro de
     60 segundos, responde inmediatamente `HTTP 200 OK` sin re-ejecutar IA ni
     BD.
   - **Presupuesto LLM Ajustado (`LLMBudget`):** `LLM_TOTAL_TIMEOUT_MS` bajó de
     `18000ms` a `8000ms` (`GROQ_TIMEOUT_MS = 4000ms`,
     `GEMINI_TIMEOUT_MS = 4000ms`, `GEMINI_MAX_RETRIES = 1`) para responder
     antes de que expire el timeout del Action HTTPS de AWS IoT Core.
   - **Política Cero-500 y Audio de Contingencia:** Si ocurre un error aguas
     abajo en un dispositivo ya validado, se envía un audio corto de
     contingencia desde caché RAM y se devuelve `HTTP 200 OK` controlado para
     evitar que AWS IoT Core dispare hasta 2 reintentos adicionales.

3. **Desacoplamiento de Base de Datos y Paralelización (`EdgeRuntime.waitUntil`
   y `Promise.all`):**
   - En `orquestador_iot` (Caso 1, Caso 2 y Caso 3), la persistencia en
     `historial_interacciones`, la subida del `.wav` a Storage y la búsqueda en
     `red_apoyo` se ejecutan en segundo plano mediante `runInBackground`
     (`EdgeRuntime.waitUntil`), eliminando ~350–650ms del camino crítico hacia
     el parlante.
   - La búsqueda de destinatario en `red_apoyo` ahora utiliza
     `findBestContactMatch()` normalizando tildes y mayúsculas en memoria
     (`"Mamá"` coincide con `"mama"`), eliminando los errores `PGRST116` de
     `.single()` y vulnerabilidades de interpolación en `.or()`.
   - En `app_mensajeria` (Caso B — Doble Despacho), la síntesis/caché de la
     intro + Despacho 1, la descarga del audio desde `audios_directos_coco` y el
     `INSERT` en `historial_interacciones` se lanzan en paralelo con
     `Promise.all` desde el inicio, eliminando la descarga tardía posterior a
     los `3500ms`.

4. **Optimización de Runtime Deno 2:**
   - Conversión Base64 nativa V8 (`Uint8Array.prototype.toBase64` /
     `Uint8Array.fromBase64`) con fallback por bloques de 32 KB (más de 100x más
     rápida que el bucle byte a byte anterior).
   - `logSafePayload()` reemplaza `console.log(bodyText)` omitiendo cadenas
     Base64 largas en stdout.
   - Caché en RAM para `dispositivos_coco` (TTL 5 min) y caché LRU para frases
     TTS estáticas e intros familiares (`TTS_B64_CACHE`).
   - Instancia singleton global de `AwsClient` (`aws4fetch`,
     `service: "iotdata"`) y cliente Supabase con `persistSession: false`.

---

### Iteración 9 — Documento de Contexto General para Agentes IA (2026-11-12)

**Objetivo:** Generar un contexto único y verificado del ecosistema COCO para
ser usado por otros agentes (Claude), auditando código + base de datos en vivo
vía Supabase MCP.

**Archivos tocados:**

- `CONTEXTO_GENERAL_COCO.md` — Nuevo. Visión, equipo, arquitectura, pipeline IA
  (Deepgram → Groq/Gemini → ElevenLabs), diccionario de etiquetas JSON, Edge
  Functions, modelo de datos real (tablas/columnas), env vars, reglas,
  pendientes y riesgos.
- `AGENTS.md` — Solo este bloque de log. **Sin cambios de código.**

**Hallazgos relevantes (a recordar):**

- RLS deshabilitado en las 6 tablas de `public`; bucket `audios_directos_coco`
  es público; `verify_jwt=false` en todas las funciones.
- Tablas/columnas no documentadas antes: `logs_telemetria` (vacía),
  `usuarios_app.push_token`/`telefono`, `dispositivos_coco` (`estado_online`,
  `ultima_vez_visto`, `nivel_volumen`, `timezone`, `version_firmware`,
  `hora_inicio_silencio`, `hora_fin_silencio`),
  `historial_interacciones.leido_por_app_at` (lo escribe la app) y la columna de
  fecha se llama `"timestamp"` (no `created_at`).
- `red_apoyo.rol` es `ADMINISTRADOR|CONTACTO` (permiso, no parentesco) → la
  intro de `app_mensajeria` genera "tu ADMINISTRADOR sobrino…". Pendiente de
  corrección.
- Migración `20261110_indices_rendimiento.sql` NO aplicada y referencia
  `historial_interacciones.created_at` (inexistente).
- `app_gestion` no está desplegada; su código comentado usa columnas
  inexistentes.
- Realtime habilitado solo en `historial_interacciones`; `estado_reproduccion`
  siempre queda `PENDIENTE`.

---

### Iteración 10 — COCO como Asistente Conversacional (2026-11-12)

**Objetivo:** Que COCO responda como un asistente de voz general (fecha/hora
reales, clima, noticias, cultura general, charla natural, identidad del abuelo)
sin perder el ruteo de mensajes, notas de voz ni SOS. Costo $0, latencia < 8 s,
payload MQTT < 128 KB.

**Diagnóstico (auditoría de código + BD vía MCP):**

- El LLM no recibía fecha/hora, nombre del abuelo ni red de apoyo → inventaba el
  año (2025), no sabía "cómo me llamo".
- No había herramientas → "no tengo acceso en tiempo real".
- Deepgram transcribía "COCO" como hugo/cuco/goku/gogo/google/copo… y el prompt
  no tenía intención de charla → "¿quiere mandarle saludos a Hugo?".
- Sin memoria: los diálogos de 2 turnos ("mándale un mensaje a…" → "que…") se
  rompían. ~134 de 190 `MENSAJE` IA eran en realidad charla.
- `qwen/qwen3.8-27b` en Groq usa modo "thinking" por defecto (no se enviaba
  `reasoning_effort`).

**Archivos tocados:**

- `orquestador_iot/types.ts` — Tipos nuevos internos: `IntencionAsistente`
  (incluye `CONVERSACION`), `Herramienta`, `RespuestaAsistente`,
  `ResultadoAsistente`, `ContactoRed`, `TurnoReciente`,
  `ContextoConversacional`. `GeminiResponse` **intacto**.
- `orquestador_iot/services/contextService.ts` — **Nuevo.** `getDeviceContext`
  (una consulta embebida dispositivo + adulto + red_apoyo + usuarios_app, caché
  RAM 5 min, degrada a consulta mínima si falla), `buildFechaHoraLocal` (Intl),
  `calcularEdad`, `getRecentTurns` (historial 10 min, timeout 800 ms, corre en
  paralelo con Deepgram), `buildSttHints`.
- `orquestador_iot/services/toolsService.ts` — **Nuevo.** `consultarClima`
  (Open-Meteo geocoding CL+global en paralelo, elige por población; forecast 3
  días; WMO→es), `consultarNoticias` (Google News RSS CL, portada o tema),
  `consultarEnciclopedia` (Wikipedia es). Timeouts, caché TTL en RAM, sin API
  keys.
- `orquestador_iot/services/sttService.ts` — `transcribeAudioWithHints(audio,
  hints)` (`keywords` en nova-2 con `coco:2`; `keyterm` si el modelo es
  nova-3). `transcribeAudio` mantiene firma y delega. Nueva clase
  `DeepgramEmptyTranscriptError`.
- `orquestador_iot/services/llmService.ts` — SYSTEM_PROMPT nuevo y compacto
  (~800 tokens), sobre JSON de 6 llaves (+`herramienta`,
  `herramienta_parametro`), `responderConContexto` (pasada 1 → herramienta
  opcional → pasada 2 con prompt mínimo que solo devuelve
  `respuesta_sintetizada`), `reasoning_effort: "none"` para qwen3, reintento
  corto de Groq ante 429 (`LLMRateLimitError` + `retry-after`), log de tokens,
  `detectarEmergenciaLocal`. `classifyTranscription` conserva firma/contrato
  (wrapper que mapea `CONVERSACION → MENSAJE`). `validateLLMResponse` intacto.
- `orquestador_iot/index.ts` — Sección 3 usa `getDeviceContext`; Caso 3: STT ∥
  memoria → `responderConContexto`; `CONVERSACION` se persiste como `MENSAJE`;
  ruteo con contactos en caché (nombre real del familiar agregado como apodo);
  red de seguridad SOS local si ambos LLM fallan; frase "No alcancé a
  escucharle…" para audio vacío; SOS de hardware registrado aunque falle la IA.
- `orquestador_iot/services/asistente_test.ts` — **Nuevo.** 29 tests unitarios
  (`deno test --allow-env --no-check services/asistente_test.ts`).

**Contratos:** MQTT (Andrés) sin cambios. BD sin migraciones (CHECK de
`tipo_evento` intacto). `metadata_payload` con llaves **aditivas**:
`respuesta_coco`, `intencion_ia` (`CONVERSACION|MENSAJE|…`),
`herramienta_usada` (`CLIMA|NOTICIAS|ENCICLOPEDIA|null`). Firmas públicas de
Diego intactas. `ttsService.ts`/`performanceUtils.ts` no se tocaron.

**Variables de entorno nuevas (todas opcionales):** `GROQ_REASONING_EFFORT`
(default `none` si el modelo es qwen3; `omit` para no enviarlo),
`GROQ_RATE_LIMIT_MAX_WAIT_MS` (2500), `TOOL_TIMEOUT_MS` (3000),
`DEEPGRAM_KEYWORDS` (lista por comas), `DEEPGRAM_KEYWORD_BOOST` (1.5).
`LLM_MAX_OUTPUT_TOKENS` default sube a 220.

**Pruebas en vivo (Groq real, sin audio):** "hola hugo cómo estás" →
CONVERSACION; año 2026 y hora correctos; "cómo me llamo" → Don Carlos; clima
mañana en Chiguayante vía Open-Meteo; noticias resumidas; Gabriela Mistral vía
Wikipedia; "mándale un mensaje a mi hijo" → explica que no está registrado y
ofrece Martín/José; mensaje de 2 turnos → José. Latencia LLM 0,6–1,1 s sin
herramienta y ~2–5 s con herramienta.

**⚠️ Restricción descubierta — límite del tier gratuito de Groq:**
`qwen/qwen3.8-27b` tiene **7.000 tokens de entrada por minuto**. Cada turno
consume ~1.250 tokens (pasada 2: ~300–400), o sea ~5 turnos/min. Ráfagas
rápidas producen 429; el reintento corto ayuda, pero si la espera es larga se cae
a Gemini, cuyo tier gratuito (`gemini-3.8-flash`: 5 RPM / 20 por día) suele
fallar → audio de contingencia. Groq **no** tiene caché de prompt para qwen3.8
(sí para `openai/gpt-oss-*`, cuyos tokens cacheados no cuentan para el límite).
Evaluar cambio de `GROQ_MODEL` si el uso real lo requiere.

**Pendiente:** desplegar `orquestador_iot`, probar con audio real (verificar que
"COCO" deje de transcribirse como "hugo"), revisión del prompt por Diego,
avisar a Martín de las llaves nuevas de `metadata_payload` (opcional filtrar la
charla con `intencion_ia = 'CONVERSACION'`). Error de tipos preexistente en
`performanceUtils.ts` (`Uint8ArrayWithNativeBase64` vs. tipado nativo de
`toBase64` en Deno ≥ 2.9) — no bloquea el runtime.

---

### Iteración 11 — Herramientas de Información Real: Web, Chile y Calendario (2026-11-13)

**Objetivo:** Que COCO responda datos puntuales y actuales (fechas de
personajes, UF/dólar, santoral, feriados, luna, espectáculos, precios,
resultados deportivos, actualidad) con fuentes gratuitas, herramientas < 2,5 s y
ciclo total < 8 s.

**Diagnóstico (historial + logs de v55, 12-nov):**

- "¿Cuándo falleció Michael Jackson?" → `limpiarExtracto` borraba TODOS los
  paréntesis, justo donde Wikipedia pone "(…Los Ángeles, 25 de junio de 2009)".
- UF, bencina, luna, santo y Laura Pausini → al no existir una herramienta
  adecuada, el LLM usaba ENCICLOPEDIA como comodín (respuestas sobre "IMACEC",
  "Estadio Claro Arena", "programa espacial chino", "iglesia de Tenerife").
- "Año de la independencia" → la pasada 2 decía "usa SOLO esos datos" y el
  modelo no decía 1818 aunque lo sabe.
- "Paro de camioneros" → `Timeout (3000ms) en news.google.com` desde Supabase,
  sin fuente de respaldo; además Google News solo trae titulares.
- "¿Me han llegado mensajes?" → COCO inventaba que había enviado mensajes.

**Archivos tocados:**

- `orquestador_iot/types.ts` — `Herramienta` += `INDICADORES`, `CALENDARIO`,
  `BUSQUEDA_WEB`.
- `orquestador_iot/services/toolsService.ts` — `limpiarExtracto` conserva
  paréntesis con dígitos (5 oraciones, 1.100 chars). Parser RSS genérico
  `parsearItemsRss` (CDATA, `<source>`/`<News:Source>`, descripción).
  `consultarNoticias`: Google News ∥ Bing News (con resumen) ∥ Cooperativa
  (portada), deduplicadas con `combinarNoticias`. Nuevas:
  `consultarIndicadores` (findic.cl ∥ mindicador.cl, caché 30 min, formato
  es-CL), `consultarCalendario` (Wikipedia "D de mes" → santoral y
  celebraciones; `calcularFaseLunar` local; feriados `api.boostr.cl/holidays/
  {año}.json` con lista de respaldo 2026–2027; `resolverFecha`), `buscarWeb`
  (Tavily ∥ respaldo Bing News + Bing web filtrado con `esRelevante` + Wikipedia
  `list=search`, en paralelo). `ejecutarHerramienta` recibe el timezone. Timeout
  por defecto de 2,5 s.
- `orquestador_iot/services/llmService.ts` — Guía de herramientas en el prompt
  (cuándo usar cada una; ENCICLOPEDIA con solo el nombre; hechos históricos
  sin herramienta); regla "no puedes leer mensajes recibidos";
  `SYSTEM_PROMPT_PASADA2` responde exactamente lo preguntado, puede usar
  conocimiento estable y nunca inventa cifras actuales; enums/esquema con las
  herramientas nuevas; `TOOL_TIMEOUT_MS` default 2500.
- `orquestador_iot/services/asistente_test.ts` — 39 tests (10 nuevos).

**Fuentes probadas en vivo (gratis):** findic.cl (UF $41.316,06 al 12-11-2026),
boostr feriados, Wikipedia día/santoral, Bing News RSS, Google News RSS,
Cooperativa RSS. Descartadas: DuckDuckGo HTML (CAPTCHA a la 2ª consulta), DDG
Instant (vacío), Brave (exige tarjeta), Groq Compound / Gemini grounding (pago).
mindicador.cl respondía HTTP 500 (queda como respaldo).

**Contratos:** MQTT y BD sin cambios. `metadata_payload.herramienta_usada` puede
traer `INDICADORES|CALENDARIO|BUSQUEDA_WEB` (aditivo; avisar a Martín). Firmas
públicas intactas. `ttsService.ts`/`performanceUtils.ts` no tocados.

**Variables de entorno nuevas (opcionales):** `TAVILY_API_KEY` (cuenta gratis,
1.000 búsquedas/mes, sin tarjeta), `TAVILY_SEARCH_DEPTH` (default `basic`).
Sin key, BUSQUEDA_WEB usa el respaldo sin key.

**Pruebas en vivo (Groq real, sin Tavily key, 13 preguntas reales que fallaban):**
todas correctas. Michael Jackson → 25 de junio de 2009; UF → cuarenta y un mil
trescientos dieciséis pesos; dólar; San Andrés → 30 de noviembre; santo de hoy;
luna creciente; próximo feriado 8 de diciembre; Pausini → Viña 2027; bencina 97
RM; paro de camioneros → acuerdo; Deportes Concepción 2-0 Everton;
independencia → 1818 **sin herramienta**; "¿me han llegado mensajes?" → sin
inventar. Herramientas 0–500 ms con caché o tibias (Wikipedia en frío ~1,7–2,5
s). Ciclo LLM 0,6–3,6 s. Tokens: pasada 1 ≈ 1.500, pasada 2 ≈ 350–660.
Ajustes posteriores: INDICADORES usa `Promise.any` (no espera a la fuente
lenta); si una herramienta falla y es un hecho estable, la pasada 2 lo responde
sin disculparse; montos redondeados a pesos enteros.

**Despliegue:** `orquestador_iot` v57 (2026-11-12) con `TAVILY_API_KEY` creado
por Vicente en los secrets. Pendiente: revisión del prompt por Diego.

---

### Iteración 11.1 — Refinamiento de ENCICLOPEDIA y BUSQUEDA_WEB (2026-11-12)

**Objetivo:** que COCO quede preparado para preguntas nuevas de datos concretos
(sin respuestas preparadas), a partir de las pruebas reales con v57.

**Diagnóstico (historial ids 539–544 + logs v57):**

- "Sierra Gorda: ubicación y habitantes" → Wikipedia devolvía la página de
  **desambiguación** ("Sierra Gorda hace referencia a varios artículos:") y los
  siguientes resultados eran de México. Además, el resumen de la comuna no trae
  la población.
- "¿Con quién juega Deportes Concepción la próxima fecha?" → **Tavily tardó
  > 2,5 s desde Supabase** (lo normal ahí: 1,5–2,5 s), se cortó y el respaldo sin
  key dio titulares antiguos: COCO dijo que el próximo rival era el último.
- "¿Dónde queda la USM de Concepción?" → ENCICLOPEDIA no trae direcciones.
- Se probó Wikidata como fuente estructurada: **descartado** (no tiene la
  población de Sierra Gorda, 0,6–1,7 s por consulta y respuestas vacías por
  límite de uso).

**Archivos tocados:**

- `services/toolsService.ts`:
  - `consultarEnciclopediaDetalle`: 3 resultados con `pageprops=disambiguation`;
    `esDesambiguacion` y `elegirArticuloWikipedia` saltan desambiguaciones; si el
    mejor resultado era ambiguo, reintenta una vez con "<tema> Chile".
  - `terminosDatoConcreto(pregunta)`: detecta si piden habitantes, dirección,
    teléfono, horario, precio, superficie o altura.
  - `enciclopediaConComplemento`: en esos casos, Wikipedia ∥ web **en
    paralelo**; si Wikipedia no encuentra artículo, **cascada** a la web.
  - `buscarWebDetalle` devuelve null si no hay resultados y acepta opciones
    (`relevancia`, `sinWikipedia`). El complemento omite los fragmentos de
    Wikipedia, que pierden el sujeto ("…858 habitantes" era de la aldea
    Baquedano, no de la comuna).
  - Si Tavily no responde, el respaldo llega marcado como `AVISO_FUENTE_SECUNDARIA`
    ("pueden ser de fechas anteriores…") y no se guarda en caché.
  - `ejecutarHerramienta(h, p, presupuestoPaso, tz, pregunta?)`: presupuesto
    total del paso + topes por fuente (`TOOL_TIMEOUT_MS` 2500,
    `TOOL_WEB_TIMEOUT_MS` 4000).
- `services/llmService.ts`:
  - Paso de herramienta con `TOOL_STEP_MAX_MS` (4500), recortado por el
    presupuesto LLM de 8 s menos la reserva de la pasada 2. Se pasa la
    transcripción a `ejecutarHerramienta`.
  - Prompt de la pasada 1: ENCICLOPEDIA = descripción e historia, con aclaración
    si el nombre es ambiguo ("Sierra Gorda comuna Chile", "Mercurio planeta").
    BUSQUEDA_WEB = datos concretos: direcciones, teléfonos, horarios, próximos
    partidos.
  - Pasada 2: "usa cada dato solo para lo que el texto lo dice".
- `services/asistente_test.ts`: 41 tests (2 nuevos: desambiguación y detección
  de dato concreto).

**Pruebas en vivo (sin Tavily en local), preguntas no vistas antes:**

- Habitantes de Tomé → 54.946 (censo 2017).
- Hospital Regional de Concepción → calle Independencia (no inventó el número).
- Arturo Prat, Mercurio planeta, fundación de Valdivia (1552), Michael Jackson →
  correctos.
- Sede de la USM en Concepción → Hualpén.
- Próximo partido de Colo-Colo → U. Católica, domingo 22.
- Sierra Gorda → ubicación correcta; sin Tavily dice con honestidad que no tiene
  la cifra (antes daba 858 por error).

Latencia LLM: 1,4–2,3 s.

**Contratos:** sin cambios (MQTT, BD, `metadata_payload`, firmas públicas).
Variables nuevas opcionales: `TOOL_WEB_TIMEOUT_MS`, `TOOL_STEP_MAX_MS`.
Desplegado como `orquestador_iot` **v58**.

**Pendiente:** verificar en producción, con Tavily, las preguntas de dato
concreto (logs `[TOOL ENCICLOPEDIA]`); revisión del prompt por Diego.
