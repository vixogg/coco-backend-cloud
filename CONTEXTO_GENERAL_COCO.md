# CONTEXTO GENERAL — PROYECTO COCO (para agentes IA)

> **Propósito de este documento:** darle a un agente IA (Claude u otro) el
> contexto completo y verificado de COCO: qué es, quién hace qué, cómo funciona
> hoy el backend (Supabase Edge Functions), cómo funcionan los servicios de IA
> que "etiquetan" cada interacción en JSON, qué significa cada campo JSON y cómo
> es el modelo de datos real en Supabase.
>
> **Fuente de verdad:** se construyó leyendo el código del repo
> `coco-backend-cloud`, `AGENTS.md`, `README.md` y consultando en vivo el
> proyecto Supabase (`COCO`, ref `qhitfvbaydcknzdkugvf`) vía MCP el
> **2026-11-12**. Cuando la documentación previa contradice al código, **manda
> el código** (las discrepancias están listadas en la §12).

---

## 1. ¿Qué es COCO?

COCO es un **altavoz inteligente IoT con filosofía Zero-UI** (sin pantallas ni
botones complejos) para **adultos mayores en Chile**, pensado para reducir su
aislamiento social. El abuelo solo **habla y escucha**; toda la complejidad vive
en la nube.

Conecta tres mundos:

| Mundo         | Actor                                  | Cómo interactúa                                                                                                    |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Hardware**  | El adulto mayor ("el abuelo")          | Habla al dispositivo físico (ESP32/simulador), escucha respuestas en audio. Tiene un botón físico de pánico (SOS). |
| **App móvil** | Cuidadores / familiares (red de apoyo) | Envían mensajes de texto o notas de voz al abuelo; reciben sus mensajes, notas de voz y alertas SOS.               |
| **IA**        | Servicios cloud                        | Transcriben el audio (STT), clasifican la intención y redactan respuesta (LLM), sintetizan voz (TTS).              |

**Principio de asimetría:** el hardware **no computa, solo obedece**. Envía
audio crudo y reproduce lo que la nube le manda. La nube decide todo (incluido
cuándo abrir el micrófono).

---

## 2. Equipo y responsabilidades

| Persona     | Rol                                      | Qué entrega / consume                                                                                                                                                                                                                         |
| ----------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Vicente** | **Backend & Cloud** (dueño de este repo) | Supabase (Postgres, Storage, Auth, Edge Functions en Deno/TypeScript). Orquesta todo, firma peticiones a AWS IoT con SigV4, integra los servicios de IA de Diego, expone endpoints a la app de Martín.                                        |
| **Andrés**  | **Hardware & MQTT**                      | Dispositivo/simulador. Publica en el tópico `coco/simulador/tx`; una regla de AWS IoT Core reenvía ese mensaje por HTTPS al Edge Function `orquestador_iot`. Se suscribe a `coco/dispositivos/{mac_address}/rx` para recibir audios/comandos. |
| **Martín**  | **App móvil (React Native)**             | App para la red de apoyo. Usa Supabase Auth, sube notas de voz al bucket `audios_directos_coco`, llama a `app_mensajeria` (REST) y lee `historial_interacciones` (incl. Realtime).                                                            |
| **Diego**   | **Inteligencia Artificial**              | Provee los microservicios `services/` (STT, LLM, TTS) que el backend copia/integra dentro de cada Edge Function. Define el contrato JSON `GeminiResponse`.                                                                                    |

---

## 3. Arquitectura general

```
                ┌────────────────────────── AWS IoT Core (MQTT, límite 128 KB/msg) ──────────────────────────┐
                │                                                                                             │
 [Hardware]──publish──► coco/simulador/tx ──(IoT Rule, acción HTTPS)──► Supabase Edge Fn: orquestador_iot    │
 (Andrés)   ◄─subscribe─ coco/dispositivos/{mac}/rx ◄──(HTTPS POST firmado SigV4, service "iotdata")───┐     │
                └────────────────────────────────────────────────────────────────────────────────────┼─────┘
                                                                                                      │
 [App móvil]──REST POST──► Supabase Edge Fn: app_mensajeria ──────────────────────────────────────────┘
 (Martín)   ──supabase-js──► Postgres (historial_interacciones, Realtime) + Storage (audios_directos_coco)

 Edge Functions ──► Deepgram (STT) ──► Groq (LLM primario) / Gemini (LLM fallback) ──► ElevenLabs (TTS MP3)
                └─► Supabase Postgres (service_role) + Storage
```

- **Runtime:** Supabase Edge Functions (Deno 2, TypeScript). Cada función es
  **autónoma**: no comparten módulos, por eso `ttsService.ts` y
  `performanceUtils.ts` están duplicados en `orquestador_iot/services/` y
  `app_mensajeria/services/`.
- **Acceso a BD desde funciones:** cliente `supabase-js` con
  `SUPABASE_SERVICE_ROLE_KEY` (bypassa RLS), `persistSession: false`.
- **Publicación hacia el hardware:** `aws4fetch` (`AwsClient`) singleton por
  isolate,
  `POST https://{AWS_IOT_ENDPOINT}/topics/coco/dispositivos/{mac}/rx?qos=1`.
- **Audios:** viajan siempre como **Base64 dentro de JSON**
  (`formato_payload: "AUDIO_B64"`). Nunca se guardan audios de respuesta; solo
  las notas de voz en Storage.

### Estructura del repositorio

```
coco-backend-cloud/
├── AGENTS.md                      # Reglas + log de iteraciones del backend (actualizar al terminar cada tarea)
├── README.md                      # Resumen de alto nivel (parcialmente desactualizado, ver §12)
├── .env.local                     # Secrets locales (gitignored)
└── supabase/
    ├── config.toml                # Config CLI; las 3 funciones con verify_jwt = false
    ├── migrations/20261110_indices_rendimiento.sql   # Índices opcionales (NO aplicados aún en la BD)
    └── functions/
        ├── deno.json              # import map: @supabase/supabase-js -> npm:@supabase/supabase-js@^2
        ├── orquestador_iot/       # Flujo ASCENDENTE (hardware -> nube -> hardware)   [DESPLEGADA v54]
        │   ├── index.ts
        │   ├── types.ts           # Contratos IA (GeminiResponse, etc.)
        │   └── services/
        │       ├── sttService.ts        # Deepgram
        │       ├── llmService.ts        # Groq primario + Gemini fallback + validación + budget
        │       ├── ttsService.ts        # ElevenLabs
        │       └── performanceUtils.ts  # Base64 rápido, caché, idempotencia, guardas de bytes, fuzzy match
        ├── app_mensajeria/        # Flujo DESCENDENTE (app -> nube -> hardware)       [DESPLEGADA v11]
        │   ├── index.ts
        │   └── services/ (ttsService.ts, performanceUtils.ts)
        └── app_gestion/           # CRUD administrativo — PLACEHOLDER, NO desplegada
            └── index.ts
```

---

## 4. Servicios de IA (el "cerebro" que etiqueta los JSON)

El pipeline completo de IA vive en `orquestador_iot/services/`. Es el que
convierte la voz del abuelo en un **JSON etiquetado** (`GeminiResponse`) sobre
el cual el backend decide **todo**: qué responder, a quién rutear, qué prioridad
dar, qué guardar en BD y qué comando mandar al hardware.

```
audio WAV (Base64) ─► decode ─► [STT Deepgram] ─► texto
                                        │
                                        ▼
                      [LLM Groq → fallback Gemini]  ─► GeminiResponse (JSON etiquetado + validado)
                                        │
                     ┌──────────────────┼──────────────────────────┐
                     ▼                  ▼                          ▼
          respuesta_sintetizada   intencion/destinatario/prioridad  (en background)
                     │                  │                          historial_interacciones
                     ▼                  ▼                          + ruteo red_apoyo
          [TTS ElevenLabs] MP3   tipo_evento de bajada
                     │           (RESPUESTA_IA | CONFIRMACION_ESCUCHA)
                     └──────► MQTT coco/dispositivos/{mac}/rx
```

### 4.1 STT — Deepgram (`sttService.ts`)

- `transcribeAudio(audio: Uint8Array): Promise<string>`
- `POST https://api.deepgram.com/v1/listen?language=es&model=nova-2` con header
  `Authorization: Token <DEEPGRAM_API_KEY>`, `Content-Type` =
  `DEEPGRAM_CONTENT_TYPE` (default `audio/wav`).
- Parámetros opcionales por env: `DEEPGRAM_ENCODING`, `DEEPGRAM_SAMPLE_RATE`,
  `DEEPGRAM_CHANNELS`, `DEEPGRAM_LANGUAGE` (default `es`), `DEEPGRAM_MODEL`
  (default `nova-2`), `DEEPGRAM_TIMEOUT_MS` (default 10000).
- Lanza `DeepgramServiceError` si no hay canales/alternativas o si la
  transcripción viene vacía (p. ej. audio en silencio) → esto termina en el
  audio de contingencia.

### 4.2 LLM — Groq primario + Gemini fallback (`llmService.ts`)

- Firma pública (contrato estable, **no cambiar**):
  `classifyTranscription(transcription, macAddress, tipoEvento): Promise<GeminiResponse>`.
- **Orden real en el código: Groq primero, Gemini como respaldo** (Iteración 7).
  - **Groq:** `POST https://api.groq.com/openai/v1/chat/completions` (API
    OpenAI-compatible), `response_format: {type:"json_object"}`,
    `temperature 0.3`, `max_tokens 180`. Env: `GROQ_API_KEY`, `GROQ_MODEL`,
    `GROQ_TIMEOUT_MS` (default 4000).
  - **Gemini:**
    `POST https://generativelanguage.googleapis.com/{GEMINI_API_VERSION|v1beta}/models/{GEMINI_MODEL}:generateContent`,
    con `responseMimeType: application/json` + `responseSchema` (enum estricto),
    `temperature 0.3`, `maxOutputTokens 180`. Env: `GEMINI_API_KEY`,
    `GEMINI_MODEL`, `GEMINI_TIMEOUT_MS` (4000), `GEMINI_MAX_RETRIES` (1),
    `GEMINI_RETRY_DELAY_MS` (100). Reintenta solo en 429/503/timeout si queda
    presupuesto. Si da 404 lista los modelos disponibles
    (`diagnoseGeminiModels`).
- **Presupuesto de tiempo (`LLMBudget`):** `LLM_TOTAL_TIMEOUT_MS` default **8000
  ms** para todo el ciclo LLM. Cada proveedor usa
  `min(timeout propio, tiempo restante)`. Gemini solo corre si quedan > 1000 ms.
  Objetivo: responder antes de que AWS IoT Core expire y **reintente** el
  webhook (lo que causaba que el parlante repitiera la respuesta 2–3 veces).
- **Cuándo hay fallback a Gemini:** si Groq falla por timeout, JSON inválido,
  5xx/429 u otro error genérico. **No hay fallback** (error fatal) con
  `LLMConfigError` (falta key/modelo), `LLMAuthError` (401/403),
  `LLMModelNotFoundError` (404), `LLMBadRequestError` (400).
- **Jerarquía de errores:** `LLMServiceError` → `LLMError`, `LLMConfigError`,
  `LLMAuthError`, `LLMTimeoutError`, `LLMInvalidResponseError`,
  `LLMModelNotFoundError`, `LLMBadRequestError`.
- **Mensaje de usuario que recibe el LLM** (`buildUserMessage`):
  ```
  Transcripción del audio: "<texto de Deepgram>"
  Dirección MAC del dispositivo: <mac>
  Tipo de evento detectado por el dispositivo: <MENSAJE|ALERTA_SOS>
  [si ALERTA_SOS] IMPORTANTE: ... intencion_detectada debe ser ALERTA_SOS y prioridad_sugerida URGENTE ...
  ```
- **System prompt (resumen fiel):** es el asistente de voz de COCO para adultos
  mayores chilenos; responde **solo JSON válido**; tono cálido, trato de
  "usted"; **máx. 2 oraciones cortas (≤ 220 caracteres)** porque se convierte a
  voz; no inventar destinatarios/fechas/medicamentos; **no prometer acciones que
  el backend no ejecutó**; detectar emergencias (caída, dolor fuerte, pedido de
  auxilio) → `ALERTA_SOS`. Incluye ejemplos few-shot (mensaje a hija María,
  recordatorio de pastilla, audio a nieto, "me caí", saludo "Hola COCO").

### 4.3 Validación post-LLM (`validateLLMResponse`)

Es la compuerta que garantiza el contrato antes de que el backend use el JSON:

1. Debe ser objeto con **exactamente** las 4 llaves (`intencion_detectada`,
   `destinatario_identificado`, `prioridad_sugerida`, `respuesta_sintetizada`);
   llaves extra → inválido.
2. `intencion_detectada` ∈ enum; `prioridad_sugerida` ∈ enum;
   `destinatario_identificado` string o null; `respuesta_sintetizada` string no
   vacío.
3. **Regla SOS:** si el hardware mandó `tipo_evento = ALERTA_SOS`, la respuesta
   DEBE ser `ALERTA_SOS` + `URGENTE`; si no, se considera inválida (dispara
   fallback).
4. `respuesta_sintetizada` se trunca semánticamente por oraciones a
   `MAX_TTS_CHARS` (default 240).

Cualquier fallo → `LLMInvalidResponseError` → fallback a Gemini (si hay
presupuesto).

### 4.4 TTS — ElevenLabs (`ttsService.ts`, idéntico en ambas funciones)

- `synthesizeSpeech(text): Promise<Uint8Array>` (misma firma que tenía Polly,
  por eso los `index.ts` no cambiaron al migrar).
- `POST https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}?output_format=mp3_22050_32`,
  header `xi-api-key`, body `{ text, model_id }`. `ELEVENLABS_MODEL_ID` default
  `eleven_v4_turbo`, `ELEVENLABS_TIMEOUT_MS` default 10000.
- **Salida: MP3 22.05 kHz / 32 kbps (`audio/mpeg`)** — se eligió bajo bitrate
  para caber en el límite de 128 KB de MQTT.
- Amazon Polly está **obsoleto** (reemplazado en Iteración 5).

---

## 5. Diccionario de etiquetas JSON (qué es cada campo y para qué sirve)

### 5.1 Contrato de entrada del hardware → `orquestador_iot` (tópico `coco/simulador/tx`)

```json
{
  "mac_address": "98:fe:54:2c:c2:b0",
  "tipo_evento": "MENSAJE",
  "formato_payload": "AUDIO_B64",
  "data": "<audio WAV en Base64>"
}
```

| Campo             | Valores                                      | Significado / uso                                                                                                                                                                                                                                               |
| ----------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mac_address`     | string (MAC)                                 | Identidad del dispositivo. Se valida contra `dispositivos_coco.mac_address` (403 si no existe). Define el tópico de respuesta.                                                                                                                                  |
| `tipo_evento`     | `MENSAJE` \| `ALERTA_SOS` \| `AUDIO_DIRECTO` | Qué cree el hardware que está pasando. `MENSAJE` = el abuelo habló normalmente (va a IA). `ALERTA_SOS` = botón de pánico. `AUDIO_DIRECTO` = esto es una **nota de voz grabada** para la familia (se envía después de que la nube mandó `CONFIRMACION_ESCUCHA`). |
| `formato_payload` | `AUDIO_B64` \| `TEXTO`                       | Cómo viene `data`. `TEXTO` solo se usa para el botón SOS.                                                                                                                                                                                                       |
| `data`            | string                                       | Audio Base64 (WAV) o el texto literal `"EMERGENCIA_BOTON_PANICO"` para el SOS físico. Acepta prefijo data-URI (`data:...;base64,`).                                                                                                                             |

**Matriz de enrutamiento en `orquestador_iot`:**

| tipo_evento                          | formato_payload | data                      | Caso                                     |
| ------------------------------------ | --------------- | ------------------------- | ---------------------------------------- |
| `ALERTA_SOS`                         | `TEXTO`         | `EMERGENCIA_BOTON_PANICO` | **Caso 1 – Bypass SOS** (sin IA)         |
| `AUDIO_DIRECTO`                      | `AUDIO_B64`     | audio                     | **Caso 2 – Bypass nota de voz** (sin IA) |
| cualquiera (`MENSAJE`, `ALERTA_SOS`) | `AUDIO_B64`     | audio                     | **Caso 3 – Flujo IA** (STT→LLM→TTS)      |
| otra combinación                     | —               | —                         | 400 "Combinación de payload no válida"   |

### 5.2 Contrato de salida IA: `GeminiResponse` (la "etiqueta" central)

```ts
export interface GeminiResponse {
  intencion_detectada:
    | "MENSAJE"
    | "ALERTA_SOS"
    | "RECORDATORIO"
    | "AUDIO_DIRECTO";
  destinatario_identificado: string | null;
  prioridad_sugerida: "NORMAL" | "URGENTE";
  respuesta_sintetizada: string;
}
```

(El nombre "Gemini" es histórico; hoy lo produce Groq o Gemini indistintamente.)

| Campo                       | Qué etiqueta                                                                                                                                                                                                                                     | Cómo lo usa el backend                                                                                                                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intencion_detectada`       | La intención del abuelo. `MENSAJE`: quiere mandar algo a un familiar **o** simple conversación/pregunta (es el "default"). `ALERTA_SOS`: emergencia. `RECORDATORIO`: pide que le recuerden algo. `AUDIO_DIRECTO`: quiere grabar y enviar su voz. | 1) Se guarda tal cual en `historial_interacciones.tipo_evento`. 2) Si es `AUDIO_DIRECTO`, el evento de bajada al hardware es **`CONFIRMACION_ESCUCHA`** (ordena abrir el micrófono); si no, `RESPUESTA_IA`. 3) Si es `MENSAJE` con destinatario, activa el ruteo en `red_apoyo`. `RECORDATORIO` hoy solo se registra (agendamiento = Fase 2). |
| `destinatario_identificado` | Nombre/apodo/parentesco mencionado ("María", "nieto", "mi hija"). `null` si no se mencionó.                                                                                                                                                      | Solo para `MENSAJE`: se busca en `red_apoyo` (contactos activos del dispositivo) con `findBestContactMatch()` — normaliza tildes/mayúsculas, primero coincidencia exacta con `rol` o algún `apodos_reconocimiento`, luego coincidencia parcial. El UUID encontrado va a `historial_interacciones.destinatario_id`.                            |
| `prioridad_sugerida`        | `NORMAL` o `URGENTE` (obligatorio `URGENTE` en SOS).                                                                                                                                                                                             | Se guarda en `historial_interacciones.prioridad` y viaja en el campo `prioridad` del payload MQTT al hardware.                                                                                                                                                                                                                                |
| `respuesta_sintetizada`     | Lo que COCO le dirá al abuelo (texto plano, ≤ 2 oraciones).                                                                                                                                                                                      | Truncado a 240 chars → ElevenLabs → MP3 → guarda de bytes → Base64 → campo `data` del MQTT. **No** se guarda en BD (en BD se guarda la transcripción del abuelo).                                                                                                                                                                             |

### 5.3 Contrato de salida nube → hardware (tópico `coco/dispositivos/{mac_address}/rx`)

```json
{
  "mac_address": "98:fe:54:2c:c2:b0",
  "tipo_evento": "RESPUESTA_IA",
  "formato_payload": "AUDIO_B64",
  "data": "<MP3 Base64>",
  "prioridad": "NORMAL"
}
```

| `tipo_evento` (bajada) | Quién lo envía                                                                               | Qué debe hacer el hardware                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESPUESTA_IA`         | `orquestador_iot` (flujo IA, bypass SOS, confirmación de nota de voz, contingencia de error) | Reproducir el audio.                                                                                                                                                         |
| `CONFIRMACION_ESCUCHA` | `orquestador_iot` cuando la IA detectó `AUDIO_DIRECTO`                                       | Reproducir el audio ("Perfecto, voy a preparar el micrófono…") y **abrir el micrófono para grabar la nota de voz**, que luego se publica con `tipo_evento: "AUDIO_DIRECTO"`. |
| `MENSAJE`              | `app_mensajeria`                                                                             | Reproducir el mensaje de un familiar (1 o 2 despachos).                                                                                                                      |

`prioridad`: `NORMAL` | `URGENTE` (el bypass SOS usa `URGENTE`). Nota: el SOS
**no** se envía con `tipo_evento: ALERTA_SOS` hacia el hardware; va como
`RESPUESTA_IA` + `URGENTE`.

### 5.4 Contrato app → `app_mensajeria` (REST POST)

```json
// Texto
{ "mac_address": "00:11:22:AA:BB:CC", "emisor_id": "<uuid usuarios_app>", "tipo_mensaje": "TEXTO", "texto": "Hola abuelo", "audio_url": null }
// Nota de voz (audio_url = PATH interno del bucket, NO URL pública)
{ "mac_address": "00:11:22:AA:BB:CC", "emisor_id": "<uuid>", "tipo_mensaje": "AUDIO", "texto": null, "audio_url": "mensajes/nota_voz_1794420053745.aac" }
```

| Campo          | Obligatorio | Uso                                                                                                                                                                        |
| -------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mac_address`  | sí          | Dispositivo destino (403 si no existe).                                                                                                                                    |
| `emisor_id`    | sí          | UUID del familiar (`usuarios_app.id`). Se busca su `rol`/`apodos_reconocimiento` en `red_apoyo` para armar la intro. **Hoy no se valida contra el JWT** (modo desarrollo). |
| `tipo_mensaje` | sí          | `TEXTO` o `AUDIO`.                                                                                                                                                         |
| `texto`        | si TEXTO    | Texto a leer al abuelo.                                                                                                                                                    |
| `audio_url`    | si AUDIO    | Path en bucket `audios_directos_coco`.                                                                                                                                     |

Respuesta 200:
`{ success, message, dispositivo_id, adulto_mayor, tipo_mensaje, despachos_mqtt: 1|2 }`.

### 5.5 `metadata_payload` (JSONB en `historial_interacciones`)

| Llave                   | Tipo             | Significado                                                                                                                                                                                       |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `texto_procesado`       | string \| null   | Lo que se dijo: transcripción Deepgram del abuelo (Caso 3), texto del familiar (app TEXTO), `"🎤 Nota de voz entrante"` (Caso 2), texto fijo del botón SOS.                                       |
| `url_audio_referencia`  | string \| null   | **Path** en bucket `audios_directos_coco` (no URL). Notas del abuelo: `mensajes/coco_audio_rx_<ts>.wav`; notas de la app: `mensajes/nota_voz_<ts>.aac`. `null` si no hay audio o falló el upload. |
| `procesado_por_ia`      | boolean          | `true` solo si pasó por STT+LLM (Caso 3).                                                                                                                                                         |
| `tipo_mensaje_original` | `TEXTO`\|`AUDIO` | Solo registros `emisor = APP`.                                                                                                                                                                    |
| `frase_introductoria`   | string           | Solo `APP`: intro que se sintetizó ("Hola Don Carlos, tu … te envió un audio.").                                                                                                                  |
| `duracion_segundos`     | null             | Solo `APP`; reservado, hoy siempre `null`.                                                                                                                                                        |
| `ruta_storage`          | string           | **Legado** (Iteración 2, 9 filas). Reemplazado por `url_audio_referencia`.                                                                                                                        |
| `fallback_ia`           | boolean          | **Legado** (9 filas antiguas). Ya no se escribe.                                                                                                                                                  |

---

## 6. Edge Functions en detalle

### 6.1 `orquestador_iot` — Flujo ascendente (COMPLETADO, desplegada v54, `verify_jwt=false`)

La llama la regla HTTPS de AWS IoT Core (no puede mandar JWT, por eso
`verify_jwt=false`).

**Pasos comunes:**

1. Solo `POST` (405 si no). JSON inválido / campos faltantes / formato no
   soportado → 400.
2. `logSafePayload` (no imprime Base64 largo).
3. **Idempotencia L1:** hash SHA-256 de `mac|tipo|formato|muestra(data)`; si se
   repite en < 60 s en el mismo isolate → `200 {deduplicated:true}` sin
   reprocesar (frena reintentos de AWS IoT).
4. **Gemelo digital:** valida MAC en `dispositivos_coco` (caché RAM TTL 5 min) →
   403 si no existe.

**Caso 1 – Bypass SOS (botón físico):** TTS cacheado de "Alerta de emergencia
enviada a tu familia. Mantén la calma." → MQTT `RESPUESTA_IA`/`URGENTE` → en
background inserta `historial_interacciones` (`emisor COCO`,
`tipo_evento ALERTA_SOS`, `prioridad URGENTE`, `procesado_por_ia false`). La app
se entera vía Realtime/lectura de la tabla.

**Caso 2 – Bypass AUDIO_DIRECTO (nota de voz del abuelo):** TTS cacheado "Tu
mensaje fue enviado exitosamente." → MQTT inmediato → en background: sube el WAV
a `audios_directos_coco/mensajes/coco_audio_rx_<Date.now()>.wav` (no bloqueante)
e inserta historial (`tipo_evento AUDIO_DIRECTO`, `destinatario_id null`,
`url_audio_referencia` = path o null). Early return.

**Caso 3 – Flujo IA:** decode Base64 → Deepgram → `classifyTranscription` →
truncar texto → decidir `RESPUESTA_IA` vs `CONFIRMACION_ESCUCHA` → **en
background** (`EdgeRuntime.waitUntil`): ruteo `red_apoyo` + insert historial
(`tipo_evento` = intención, `prioridad` = sugerida, `texto_procesado` =
transcripción, `procesado_por_ia true`) → **camino crítico:** ElevenLabs →
`ensureSafeAudioPayloadSize` → Base64 → MQTT → 200.

**Política Cero-500:** si algo falla después de validar la MAC, se manda en
background el audio de contingencia ("Disculpe, tuve un inconveniente…") y se
responde **200** controlado (`handled_error: true`) para que AWS IoT no
reintente. Solo responde 500 si falla antes de validar el dispositivo.

**Defensa en 3 capas contra exceso de bytes (límite duro MQTT 128 KB = 131072
bytes):**

1. LLM: `max_tokens 180` + regla de ≤ 2 oraciones/220 chars.
2. Pre-TTS: `truncateTextBySentences(texto, MAX_TTS_CHARS=240)`.
3. Post-TTS: `ensureSafeAudioPayloadSize(bytes, MAX_RAW_AUDIO_BYTES=65000)`
   corta en el último frame MP3 válido (o reescribe cabecera RIFF si es WAV). 65
   000 bytes crudos ≈ 86.6 KB Base64.

**Latencia típica objetivo:** ~2.5 s total (Deepgram ~1 s + Groq ~0.5 s +
ElevenLabs ~1 s).

### 6.2 `app_mensajeria` — Flujo descendente (COMPLETADO, desplegada v11, `verify_jwt=false`)

1. CORS (`OPTIONS`), solo `POST`, validación del contrato (§5.4).
2. Busca `dispositivos_coco` + join `adultos_mayores(nombre)` (caché RAM) → 403
   si no existe.
3. Busca en `red_apoyo` (`dispositivo_id`, `usuario_app_id = emisor_id`,
   `activo = true`, `.maybeSingle()`).
4. Frase intro: con contacto →
   `"Hola {nombre}, tu {rol} {apodos[0] ?? rol} te envió un {mensaje|audio}."`;
   sin contacto → `"Hola {nombre}, te enviaron un {mensaje|audio}."`.
5. **Caso A – TEXTO:** en paralelo (`Promise.all`): TTS de `intro + texto`
   (truncado a 340 chars) → guarda bytes → 1 publish MQTT; e insert en
   historial.
6. **Caso B – AUDIO (Doble Despacho Secuencial):** no se puede concatenar MP3
   (ElevenLabs) con AAC (app) en un solo stream, así que: en paralelo (a) TTS
   intro (cacheada) → **Despacho 1**, (b) descarga de la nota desde Storage +
   guarda de bytes (`MAX_RAW_VOICE_NOTE_BYTES=94000`) → Base64, (c) insert
   historial. Luego espera lo que falte de **3500 ms** desde el Despacho 1 →
   **Despacho 2** con la nota original. Ambos con `tipo_evento: "MENSAJE"`,
   `prioridad: "NORMAL"`.
7. Historial: `emisor APP`, `tipo_evento MENSAJE`,
   **`destinatario_id = emisor_id`** (ojo: aquí la columna guarda al familiar
   que envió, no a un destinatario), `estado_reproduccion PENDIENTE`.
8. Errores → 500 genérico (incluye `StorageNotFoundError` si el path no existe).

### 6.3 `app_gestion` — CRUD administrativo (PENDIENTE, NO desplegada)

Placeholder con router por `accion`: `AGREGAR_CONTACTO`,
`ACTUALIZAR_CONFIGURACION_DISPOSITIVO`, `LEER_HISTORIAL_ALERTAS`. Todo comentado
y responde "Operación simulada". **Atención:** el código comentado usa columnas
que **no existen** (`dispositivo_mac`, `nombre`, `telefono`, `relacion`,
`configuracion`, `created_at` en historial). Al implementarlo hay que usar el
esquema real de la §7 (p. ej. `dispositivo_id`, `usuario_app_id`, `rol`,
`apodos_reconocimiento`, `nivel_volumen`, `hora_inicio_silencio`, `timestamp`) y
validar JWT.

---

## 7. Modelo de datos en Supabase (estado real, schema `public`)

Postgres 17. Extensiones: `plpgsql`, `pg_stat_statements`, `uuid-ossp`,
`pgcrypto`, `supabase_vault`. No hay vistas, funciones SQL propias ni triggers
en `public`. Realtime habilitado **solo** en `historial_interacciones`.

### Diagrama ER

```
auth.users (Supabase Auth)
     │ 1:1 (usuarios_app.id = auth.users.id)
     ▼
usuarios_app ◄──────────────┐                 adultos_mayores
     │                      │                        │ 1:N
     │ N:M vía red_apoyo    │                        ▼
     └──────► red_apoyo ◄───┼──────────────── dispositivos_coco ──1:N──► logs_telemetria
                            │                        │ 1:N
                            └── destinatario_id ── historial_interacciones
```

### 7.1 `adultos_mayores` — perfil del abuelo (2 filas)

| Columna            | Tipo        | Nulo | Default             | Descripción                                                                               |
| ------------------ | ----------- | ---- | ------------------- | ----------------------------------------------------------------------------------------- |
| `id`               | uuid PK     | no   | `gen_random_uuid()` | Identificador del adulto mayor.                                                           |
| `nombre`           | text        | no   | —                   | Nombre con que COCO lo saluda (ej. "Don Carlos"). Se usa en la intro de `app_mensajeria`. |
| `fecha_nacimiento` | date        | no   | —                   | Fecha de nacimiento.                                                                      |
| `created_at`       | timestamptz | no   | `now()` UTC         | Alta del registro.                                                                        |

### 7.2 `usuarios_app` — cuidadores/familiares de la app (5 filas)

| Columna      | Tipo                              | Nulo | Default     | Descripción                                                                             |
| ------------ | --------------------------------- | ---- | ----------- | --------------------------------------------------------------------------------------- |
| `id`         | uuid PK, **FK → `auth.users.id`** | no   | —           | Mismo UUID del usuario de Supabase Auth. Es el `emisor_id` que manda la app.            |
| `nombre`     | text                              | no   | —           | Nombre del familiar.                                                                    |
| `telefono`   | text                              | sí   | —           | Teléfono (hoy vacío en todos).                                                          |
| `push_token` | text                              | sí   | —           | Token para notificaciones push (Expo/FCM). **Hoy vacío; el backend aún no envía push.** |
| `created_at` | timestamptz                       | no   | `now()` UTC | Alta.                                                                                   |

### 7.3 `dispositivos_coco` — el hardware / gemelo digital (2 filas)

| Columna                | Tipo                           | Nulo | Default              | Descripción                                                                                                                                                                                           |
| ---------------------- | ------------------------------ | ---- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | uuid PK                        | no   | `gen_random_uuid()`  | ID interno del dispositivo (FK en otras tablas).                                                                                                                                                      |
| `mac_address`          | varchar **UNIQUE**             | no   | —                    | Identidad física. Llega en cada payload MQTT y define el tópico `rx`. (Ej.: `00:11:22:AA:BB:CC` simulador, `98:fe:54:2c:c2:b0` placa real — ojo con mayúsculas/minúsculas, la comparación es exacta.) |
| `adulto_mayor_id`      | uuid FK → `adultos_mayores.id` | sí   | —                    | Dueño del dispositivo.                                                                                                                                                                                |
| `estado_online`        | boolean                        | sí   | `false`              | Conectividad. **El backend no lo actualiza aún.**                                                                                                                                                     |
| `ultima_vez_visto`     | timestamptz                    | sí   | —                    | Último heartbeat. **No se actualiza aún** (null).                                                                                                                                                     |
| `nivel_volumen`        | int                            | sí   | `70`                 | Volumen 0–100 (CHECK). Configurable desde app (futuro `app_gestion`).                                                                                                                                 |
| `timezone`             | varchar                        | sí   | `'America/Santiago'` | Zona horaria del abuelo (para recordatorios/silencio).                                                                                                                                                |
| `version_firmware`     | varchar                        | sí   | `'v1.0.0'`           | Firmware de Andrés.                                                                                                                                                                                   |
| `hora_inicio_silencio` | time                           | sí   | `22:00`              | Inicio de modo "no molestar". **Aún no se aplica en la lógica.**                                                                                                                                      |
| `hora_fin_silencio`    | time                           | sí   | `08:00`              | Fin de modo "no molestar".                                                                                                                                                                            |
| `created_at`           | timestamptz                    | no   | `now()` UTC          | Alta.                                                                                                                                                                                                 |

### 7.4 `red_apoyo` — relación cuidador ↔ dispositivo (3 filas)

| Columna                 | Tipo                                       | Nulo | Default             | Descripción                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------ | ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | uuid PK                                    | no   | `gen_random_uuid()` | ID de la relación.                                                                                                                                                                                 |
| `dispositivo_id`        | uuid FK → `dispositivos_coco.id`           | sí   | —                   | A qué COCO pertenece el contacto.                                                                                                                                                                  |
| `usuario_app_id`        | uuid FK → `usuarios_app.id`                | sí   | —                   | Qué familiar es.                                                                                                                                                                                   |
| `rol`                   | text CHECK ∈ (`ADMINISTRADOR`, `CONTACTO`) | sí   | —                   | **Nivel de permiso** en la red (admin puede gestionar el dispositivo; contacto solo comunica). No es el parentesco.                                                                                |
| `apodos_reconocimiento` | text[]                                     | sí   | —                   | Cómo el abuelo llama a ese familiar ("martin", "sobrino", "mi hija", "Mamá"). Clave para que la IA rutee (`destinatario_identificado` ↔ apodos) y para la intro de `app_mensajeria` (`apodos[0]`). |
| `activo`                | boolean                                    | sí   | `true`              | Soft-delete; solo los activos se consideran.                                                                                                                                                       |
| `created_at`            | timestamptz                                | no   | `now()` UTC         | Alta.                                                                                                                                                                                              |

### 7.5 `historial_interacciones` — bitácora de todo evento (370 filas, 2026-09-18 → 2026-11-12) — **Realtime ON**

| Columna               | Tipo                                                                    | Nulo | Default       | Descripción                                                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------- | ---- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | bigint identity PK                                                      | no   | auto          | ID secuencial.                                                                                                                                                      |
| `dispositivo_id`      | uuid FK → `dispositivos_coco.id`                                        | sí   | —             | Dispositivo involucrado.                                                                                                                                            |
| `emisor`              | text CHECK ∈ (`COCO`, `APP`)                                            | sí   | —             | Origen: `COCO` = vino del abuelo/hardware; `APP` = vino de un familiar.                                                                                             |
| `destinatario_id`     | uuid FK → `usuarios_app.id`                                             | sí   | —             | `COCO`+`MENSAJE`: familiar destinatario resuelto por la IA (null si no se identificó). `APP`: el familiar **emisor**. SOS / AUDIO_DIRECTO: null (para toda la red). |
| `tipo_evento`         | text CHECK ∈ (`MENSAJE`, `ALERTA_SOS`, `RECORDATORIO`, `AUDIO_DIRECTO`) | sí   | —             | Etiqueta del evento (= `intencion_detectada` en flujo IA).                                                                                                          |
| `metadata_payload`    | jsonb                                                                   | sí   | `'{}'`        | Detalle (ver §5.5).                                                                                                                                                 |
| `estado_reproduccion` | text CHECK ∈ (`PENDIENTE`, `NOTIFICADO`, `REPRODUCIDO`, `RESPONDIDO`)   | sí   | `'PENDIENTE'` | Ciclo de vida previsto. **Hoy todo queda en `PENDIENTE`**: no existe ACK del hardware ni actualización.                                                             |
| `prioridad`           | text CHECK ∈ (`NORMAL`, `URGENTE`)                                      | sí   | `'NORMAL'`    | Urgencia (SOS = URGENTE).                                                                                                                                           |
| `timestamp`           | timestamptz                                                             | no   | `now()` UTC   | Momento del evento (**la columna se llama `timestamp`, no `created_at`**).                                                                                          |
| `leido_por_app_at`    | timestamptz                                                             | sí   | —             | Cuándo la app de Martín marcó el evento como leído (lo escribe la app, no el backend).                                                                              |

Distribución actual: COCO/MENSAJE 183 · APP/MENSAJE 82 · COCO/ALERTA_SOS 66 ·
COCO/AUDIO_DIRECTO 39 · RECORDATORIO 0.

### 7.6 `logs_telemetria` — telemetría del dispositivo (0 filas, sin uso)

| Columna          | Tipo                             | Nulo | Default     | Descripción                                   |
| ---------------- | -------------------------------- | ---- | ----------- | --------------------------------------------- |
| `id`             | bigint identity PK               | no   | auto        | —                                             |
| `dispositivo_id` | uuid FK → `dispositivos_coco.id` | sí   | —           | Dispositivo.                                  |
| `tipo_evento`    | text                             | no   | —           | Evento técnico (heartbeat, reinicio, error…). |
| `created_at`     | timestamptz                      | no   | `now()` UTC | —                                             |

### 7.7 Índices

Solo existen PKs + `dispositivos_coco_mac_address_key` (unique). El script
`supabase/migrations/20261110_indices_rendimiento.sql` (índices de cobertura en
`red_apoyo`, GIN en `apodos_reconocimiento`,
`historial (dispositivo_id, timestamp)`…) **no está aplicado**. Ojo: ese script
referencia `historial_interacciones.created_at`, que **no existe** (debe ser
`"timestamp"`); fallaría tal cual.

### 7.8 Storage

- Bucket **`audios_directos_coco`** (38 objetos), carpeta `mensajes/`:
  - `coco_audio_rx_<epoch_ms>.wav` → notas de voz del abuelo (subidas por
    `orquestador_iot`).
  - `nota_voz_<epoch_ms>.aac` → notas de voz de familiares (subidas por la app
    de Martín).
- Configurado como **público** (`public = true`), sin límite de tamaño ni MIME.
- Política en `storage.objects`: `INSERT` para `authenticated` (la app sube).
  Las funciones usan `service_role`.

### 7.9 Auth

Supabase Auth (6 `auth.users`, 5 con fila en `usuarios_app`). La app de Martín
inicia sesión con Supabase Auth; el `id` de `auth.users` es el
`usuarios_app.id`.

---

## 8. Flujos end-to-end (resumen narrativo)

1. **Conversación normal:** abuelo habla → hardware publica `MENSAJE/AUDIO_B64`
   → `orquestador_iot` (STT→LLM→TTS) → `RESPUESTA_IA` al parlante; historial
   `COCO/MENSAJE` con la transcripción.
2. **"Quiero mandarle un mensaje a mi hija María, dile que…":** igual que 1, la
   IA etiqueta `MENSAJE` + `destinatario "María"` → se resuelve el UUID en
   `red_apoyo` → historial con `destinatario_id`; la app de ese familiar lo ve
   en su bandeja (lee historial / Realtime).
3. **Nota de voz del abuelo:** "Quiero mandar un audio a mi nieto" → IA
   `AUDIO_DIRECTO` → bajada `CONFIRMACION_ESCUCHA` → hardware abre micrófono y
   graba → publica `AUDIO_DIRECTO/AUDIO_B64` → Caso 2: confirmación hablada +
   WAV a Storage + historial `COCO/AUDIO_DIRECTO` (sin destinatario: visible
   para la red).
4. **Emergencia:** botón físico (`ALERTA_SOS/TEXTO/EMERGENCIA_BOTON_PANICO`) →
   Caso 1 inmediato; o voz ("me caí") → IA `ALERTA_SOS/URGENTE`. Historial
   `ALERTA_SOS/URGENTE` → la app lo detecta vía Realtime.
5. **Familiar escribe/graba en la app:** app (sube `.aac` si es audio) →
   `app_mensajeria` → intro personalizada + mensaje → 1 o 2 publicaciones MQTT
   `MENSAJE` → historial `APP/MENSAJE`.

---

## 9. Variables de entorno (Supabase Secrets / `.env.local`)

| Grupo        | Variables                                                                                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supabase     | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (`SUPABASE_ANON_KEY` en local)                                                                                                        |
| AWS IoT Core | `AWS_IOT_ENDPOINT` (puede venir con o sin `https://`), `AWS_IOT_REGION` (default `us-east-2`), `AWS_IOT_ACCESS_KEY_ID`, `AWS_IOT_SECRET_ACCESS_KEY`                               |
| Deepgram     | `DEEPGRAM_API_KEY`, `DEEPGRAM_CONTENT_TYPE`, opc.: `DEEPGRAM_LANGUAGE`, `DEEPGRAM_MODEL`, `DEEPGRAM_ENCODING`, `DEEPGRAM_SAMPLE_RATE`, `DEEPGRAM_CHANNELS`, `DEEPGRAM_TIMEOUT_MS` |
| Groq         | `GROQ_API_KEY`, `GROQ_MODEL`, `GROQ_TIMEOUT_MS`                                                                                                                                   |
| Gemini       | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_API_VERSION`, opc.: `GEMINI_TIMEOUT_MS`, `GEMINI_MAX_RETRIES`, `GEMINI_RETRY_DELAY_MS`                                                  |
| LLM común    | `LLM_TOTAL_TIMEOUT_MS` (8000), `LLM_MAX_OUTPUT_TOKENS` (180)                                                                                                                      |
| ElevenLabs   | `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`, `ELEVENLABS_TIMEOUT_MS`                                                                                       |
| Límites      | `MAX_RAW_AUDIO_BYTES` (65000), `MAX_TTS_CHARS` (240), `MAX_RAW_VOICE_NOTE_BYTES` (94000), `MAX_MENS_TEXTO_CHARS` (340)                                                            |
| Obsoletas    | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `POLLY_*` (Polly), `MAX_AUDIO_BASE64_BYTES` (no lo lee el código)                                                     |

---

## 10. Reglas críticas (NUNCA romper)

1. **SigV4 hacia AWS IoT:** `service: "iotdata"` obligatorio; endpoint **sin**
   `https://` (`.replace(/^https?:\/\//, '')`); **nunca** `encodeURIComponent`
   en el tópico (rompe el canonical URI); `Content-Type: application/json`
   dentro de la petición firmada.
2. **Audio siempre como Base64 puro** dentro del JSON; payload MQTT total < 131
   072 bytes (usar las 3 capas de defensa).
3. **No cambiar las firmas públicas** de los servicios de Diego:
   `transcribeAudio(Uint8Array)→string`,
   `classifyTranscription(t, mac, tipo)→GeminiResponse`,
   `synthesizeSpeech(text)→Uint8Array`.
4. **No cambiar los contratos JSON** (§5) sin coordinar con Andrés (MQTT) y
   Martín (app / `metadata_payload`).
5. **`orquestador_iot` nunca debe devolver 500/timeout** por errores de IA
   después de validar el dispositivo: AWS IoT reintenta y el parlante repite.
   Mantener idempotencia + 200 controlado + latencia < ~8 s.
6. **Cada Edge Function es autónoma:** si se toca `ttsService.ts` o
   `performanceUtils.ts`, replicar el cambio en ambas funciones.
7. **Funciones consumidas por la app deben validar el JWT** (`Authorization` →
   `supabase.auth.getUser(token)`) en producción.
8. **Protocolo de agentes:** al terminar cualquier tarea, actualizar la sección
   "Estado Actual del Proyecto" y el "Log de Iteraciones" en `AGENTS.md`.

---

## 11. Estado actual y pendientes

| Componente                            | Estado                                                                                  |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `orquestador_iot`                     | ✅ Completo y optimizado (latencia, idempotencia, bytes, contingencia). Desplegado v54. |
| `app_mensajeria`                      | ✅ Completo y paralelizado. Desplegado v11. Falta validación JWT.                       |
| `app_gestion`                         | ⏳ Placeholder (no desplegado; columnas incorrectas en el código comentado).            |
| Recordatorios (`RECORDATORIO`)        | ⏳ Solo se registran; agendamiento = Fase 2 (no hay `pg_cron`).                         |
| Notificaciones push                   | ⏳ `usuarios_app.push_token` existe pero no se usa. SOS depende de Realtime en la app.  |
| Estado de reproducción / ACK hardware | ⏳ `estado_reproduccion` siempre `PENDIENTE`.                                           |
| Telemetría / online                   | ⏳ `logs_telemetria` vacío; `estado_online` / `ultima_vez_visto` no se actualizan.      |
| Modo silencio / volumen               | ⏳ Columnas existen, lógica no implementada.                                            |
| Índices de rendimiento                | ⏳ Script existe pero no aplicado (y requiere corregir `created_at` → `"timestamp"`).   |

---

## 12. Riesgos, bugs conocidos y discrepancias de documentación

**Seguridad (prioridad alta):**

- **RLS deshabilitado en las 6 tablas de `public`** → cualquiera con la anon key
  puede leer/modificar todo vía Data API. Requiere habilitar RLS **y** crear
  políticas (p. ej. familiar ve solo historial de dispositivos donde está en
  `red_apoyo`). No activar sin políticas o la app dejará de funcionar.
- Bucket `audios_directos_coco` es **público** (las notas de voz son accesibles
  por URL si se conoce el path). Los docs dicen "privado".
- Las 3 funciones tienen `verify_jwt=false` y `app_mensajeria` confía en
  `emisor_id` del body (suplantación posible).

**Bugs / comportamientos a revisar:**

- **Intro de `app_mensajeria` usa `rol` como parentesco:** como `rol` es
  `ADMINISTRADOR|CONTACTO`, el abuelo escucha "Hola Don Carlos, tu
  **ADMINISTRADOR** sobrino te envió un audio." (visto en datos reales). Debería
  usar solo el apodo o un campo de parentesco.
- **SOS por voz con `tipo_evento: ALERTA_SOS`:** si el LLM no devuelve
  `ALERTA_SOS/URGENTE`, la validación lo rechaza; si el fallback también falla,
  se envía contingencia y **la alerta no queda guardada** en historial.
- `findBestContactMatch` con coincidencia parcial puede rutear al contacto
  equivocado con apodos muy cortos.
- Idempotencia L1 es por isolate (en memoria): no cubre reintentos que caen en
  otro isolate.
- `config.toml` contiene una entrada huérfana `[functions.orquestador_coco]`
  (función inexistente).

**Discrepancias docs vs. código (manda el código):**

- `README.md` aún menciona Amazon Polly y "Gemini / Claude", `app_mensajeria`
  "en desarrollo" y bajada `ALERTA_SOS` → hoy es ElevenLabs, Groq+Gemini,
  completo, y el SOS baja como `RESPUESTA_IA`.
- `AGENTS.md` §2 dice "Gemini primario + Groq respaldo" → el código usa **Groq
  primario + Gemini fallback** (§5.5 de AGENTS sí lo dice bien).
- `AGENTS.md` menciona `mp3_44100_128` → el código usa **`mp3_22050_32`**.
- `AGENTS.md` §5 regla 2 habla de Polly → obsoleto.
- `types.ts` declara `FormatoPayload = "AUDIO_B64"` y
  `TipoEvento = "MENSAJE"|"ALERTA_SOS"`, pero el orquestador acepta también
  `TEXTO` y `AUDIO_DIRECTO` como entrada.
