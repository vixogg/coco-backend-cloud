# ☁️ COCO-AI: Backend & Cloud Architecture

Este repositorio contiene la infraestructura Serverless, la lógica de negocio y la gestión de datos centralizada para **COCO-AI**, un ecosistema IoT diseñado para mitigar el aislamiento social en la tercera edad mediante una comunicación asimétrica y "Zero-UI" (sin pantallas).

## 🧠 Rol de Backend
El objetivo de esta arquitectura es actuar como el **motor lógico y orquestador transaccional** del proyecto. Delega toda la complejidad técnica fuera del dispositivo del usuario final y centraliza el enrutamiento de intenciones entre el hardware, la aplicación móvil y los motores de Inteligencia Artificial.

## 🏗️ Arquitectura y Tecnologías Clave (Modelo Serverless Híbrido)

* **Supabase Edge Functions (Deno / TypeScript):** Microservicios distribuidos que operan como el cerebro del sistema. Se despiertan bajo demanda en milisegundos para procesar Webhooks, interactuar con la IA y orquestar flujos, manteniendo los audios de forma efímera en memoria RAM para proteger la privacidad del usuario[cite: 3, 8].
* **AWS IoT Core:** Actúa como *Gateway* de baja latencia. Mantiene un túnel MQTT bidireccional con el dispositivo de borde. Su Motor de Reglas intercepta la voz física y dispara instantáneamente un Webhook seguro hacia nuestras Edge Functions[cite: 3, 8].
* **PostgreSQL + Row Level Security (RLS):** Base de datos relacional para gestionar la persistencia de perfiles, metadatos de interacciones y la "Red de Confianza". Protegida a nivel de motor (RLS) para garantizar el aislamiento de datos entre distintas familias[cite: 3, 8].
* **Supabase Auth & Vault:** Gestión de tokens (JWT) para el acceso seguro desde la App móvil (PWA) de los cuidadores, y bóveda encriptada para proteger las API Keys de los modelos de IA[cite: 3, 8].

## 📂 Estructura de Microservicios

El enrutamiento está dividido en tres dominios de responsabilidad dentro de `supabase/functions/`:

1. **`orquestador_iot` (Flujo Ascendente):** Atrapa el Webhook desde AWS IoT Core, envía el audio a la IA (Deepgram / Claude 3 Haiku) para extracción de intenciones, y ejecuta el enrutamiento (ej. disparar alerta SOS a la red de apoyo)[cite: 3].
2. **`app_mensajeria` (Flujo Descendente):** Recibe instrucciones REST de la App móvil (ej. enviar un recordatorio), procesa el texto a voz mediante Amazon Polly, y publica el audio en Base64 de vuelta al túnel MQTT de AWS IoT Core[cite: 3, 8].
3. **`app_gestion` (Operaciones CRUD):** (En desarrollo) Administra las altas de usuarios, configuración de dispositivos y actualización de listas blancas.

## 🚀 Contratos de Integración (JSON)
El sistema opera bajo estrictos contratos de datos:
* **Entrada (IoT -> Nube):** Tópico `coco/simulador/tx`. Valida `mac_address`, `tipo_evento` y `formato_payload`[cite: 2].
* **Salida (Nube -> IoT):** Tópico `coco/dispositivos/{mac_address}/rx`. Inyecta respuestas procesadas forzando asimetría (el hardware solo reproduce, no computa)[cite: 3].