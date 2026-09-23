# ☁️ COCO-AI: Backend & Cloud Architecture

Este repositorio contiene la infraestructura Serverless, la lógica de negocio y la gestión de datos centralizada para **COCO-AI**, un ecosistema IoT diseñado para mitigar el aislamiento social en la tercera edad mediante una comunicación bidireccional asimétrica y "Zero-UI" (sin pantallas).

## 🧠 Rol de Backend
El backend de COCO actúa como el **cerebro orquestador** del proyecto. Delega toda la complejidad técnica fuera del dispositivo del usuario final y centraliza el enrutamiento de hardware, la aplicación móvil y los motores de Inteligencia Artificial.

## 🏗️ Arquitectura y Tecnologías Clave (Modelo Serverless Híbrido)

* **Supabase Edge Functions (Deno / TypeScript):** Microservicios distribuidos que operan en el borde. Se despiertan bajo demanda para procesar Webhooks, interactuar con la IA y orquestar flujos, manteniendo los audios de forma efímera en memoria RAM.
* **AWS IoT Core:** Actúa como *Gateway* de baja latencia. Mantiene un túnel MQTT bidireccional con el dispositivo. Para enviar mensajes desde Supabase hacia la placa, se utiliza el motor HTTPS de AWS protegido estrictamente con firmas criptográficas **AWS Signature V4 (SigV4)**.
* **PostgreSQL + Row Level Security (RLS):** Base de datos relacional para gestionar la persistencia de perfiles (`adultos_mayores`, `usuarios_app`), metadatos de interacciones y la `red_apoyo`. 
* **Inteligencia Artificial:** Orquestación inteligente utilizando **Deepgram** (Speech-to-Text), **Google Gemini / Claude** (Clasificación de intenciones y generación de respuestas) y **Amazon Polly** (Text-to-Speech).

## 📂 Estructura de Microservicios

El enrutamiento está dividido en tres dominios de responsabilidad dentro de `supabase/functions/`:

1. **`orquestador_iot` (Flujo Ascendente - Completado):** Atrapa el Webhook desde AWS IoT Core, envía el audio a la IA para extracción de intenciones, decide el comportamiento de hardware (ej. abrir micrófono o gatillar alerta SOS) y retorna el audio sintetizado a la placa.
2. **`app_mensajeria` (Flujo Descendente - En Desarrollo):** Recibe instrucciones REST de la App móvil (texto o notas de voz), construye saludos dinámicos contextuales, sintetiza la voz mediante Amazon Polly, y publica el audio Base64 de vuelta al túnel MQTT de AWS IoT Core.
3. **`app_gestion` (Operaciones CRUD - Pendiente):** Administra las altas de usuarios, configuración de dispositivos, gestión de red de apoyo y emparejamiento.

## 🚀 Contratos de Integración (JSON)
El sistema opera bajo estrictos contratos de datos dinámicos:
* **Entrada (IoT -> Nube):** Tópico `coco/simulador/tx`. Recibe payload con `mac_address`, `tipo_evento` y `formato_payload`.
* **Salida (Nube -> IoT):** Tópico `coco/dispositivos/{mac_address}/rx`. Inyecta respuestas procesadas indicando el comportamiento exacto (`RESPUESTA_IA`, `CONFIRMACION_ESCUCHA`, `ALERTA_SOS`) forzando la asimetría donde el hardware solo obedece, no computa.