/**
 * Tests unitarios del asistente conversacional (Iteración 10). Solo funciones puras: sin red.
 * Ejecutar desde supabase/functions/orquestador_iot:
 *   deno test --allow-env services/asistente_test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildContextMessage,
  buildToolResultMessage,
  detectarEmergenciaLocal,
  LLMInvalidResponseError,
  parseRetryAfterMs,
  resolveGroqReasoningEffort,
  toGeminiResponse,
  validateRespuestaAsistente,
  validateSoloRespuesta,
} from "./llmService.ts";
import {
  describirCodigoWmo,
  elegirLugar,
  formatearClima,
  limpiarExtracto,
  limpiarLugar,
  parsearTitularesRss,
  calcularFaseLunar,
  combinarNoticias,
  esRelevante,
  extraerCelebraciones,
  extraerSantoral,
  formatearIndicadores,
  formatearNoticias,
  formatearTavily,
  elegirArticuloWikipedia,
  esDesambiguacion,
  terminosDatoConcreto,
  parsearIndicadores,
  parsearItemsRss,
  proximosFeriados,
  resolverFecha,
  seleccionarIndicadores,
} from "./toolsService.ts";
import {
  buildContextoConversacional,
  buildFechaHoraLocal,
  buildSttHints,
  calcularEdad,
  mapDeviceRow,
} from "./contextService.ts";
import { appendVocabularyHints } from "./sttService.ts";
import type { ContextoConversacional } from "../types.ts";

const base = {
  intencion_detectada: "CONVERSACION",
  destinatario_identificado: null,
  prioridad_sugerida: "NORMAL",
  herramienta: "NINGUNA",
  herramienta_parametro: null,
  respuesta_sintetizada: "¡Hola, Don Carlos!",
};

// ── validateRespuestaAsistente ────────────────────────────────────────────────

Deno.test("valida una conversación simple", () => {
  const r = validateRespuestaAsistente(base, "MENSAJE", true);
  assertEquals(r.intencion_detectada, "CONVERSACION");
  assertEquals(r.herramienta, "NINGUNA");
});

Deno.test("CONVERSACION nunca lleva destinatario (caso 'hola hugo')", () => {
  const r = validateRespuestaAsistente({ ...base, destinatario_identificado: "Hugo" }, "MENSAJE", true);
  assertEquals(r.destinatario_identificado, null);
});

Deno.test("CLIMA sin lugar → no consulta y pregunta la ciudad", () => {
  const r = validateRespuestaAsistente(
    { ...base, herramienta: "CLIMA", herramienta_parametro: null, respuesta_sintetizada: "Déjeme revisar." },
    "MENSAJE",
    true,
  );
  assertEquals(r.herramienta, "NINGUNA");
  assertStringIncludes(r.respuesta_sintetizada, "ciudad");
});

Deno.test("pide herramienta con respuesta vacía en pasada 1", () => {
  const r = validateRespuestaAsistente(
    { ...base, herramienta: "CLIMA", herramienta_parametro: "Chiguayante", respuesta_sintetizada: "" },
    "MENSAJE",
    true,
  );
  assertEquals(r.herramienta, "CLIMA");
  assertEquals(r.herramienta_parametro, "Chiguayante");
});

Deno.test("pasada 2 fuerza herramienta NINGUNA", () => {
  const r = validateRespuestaAsistente(
    { ...base, herramienta: "NOTICIAS", respuesta_sintetizada: "Hoy hay paro de camioneros." },
    "MENSAJE",
    false,
  );
  assertEquals(r.herramienta, "NINGUNA");
  assertEquals(r.herramienta_parametro, null);
});

Deno.test("evento SOS de hardware no puede degradarse", () => {
  assertThrows(() => validateRespuestaAsistente(base, "ALERTA_SOS", true), LLMInvalidResponseError);
});

Deno.test("ALERTA_SOS detectada por voz → URGENTE y sin herramienta", () => {
  const r = validateRespuestaAsistente(
    {
      ...base,
      intencion_detectada: "ALERTA_SOS",
      herramienta: "CLIMA",
      herramienta_parametro: "x",
      respuesta_sintetizada: "Ya aviso a su familia.",
    },
    "MENSAJE",
    true,
  );
  assertEquals(r.prioridad_sugerida, "URGENTE");
  assertEquals(r.herramienta, "NINGUNA");
});

Deno.test("llaves inesperadas o enums inválidos → inválido (dispara fallback)", () => {
  assertThrows(() => validateRespuestaAsistente({ ...base, extra: 1 }, "MENSAJE", true), LLMInvalidResponseError);
  assertThrows(
    () => validateRespuestaAsistente({ ...base, intencion_detectada: "CHARLA" }, "MENSAJE", true),
    LLMInvalidResponseError,
  );
  assertThrows(
    () => validateRespuestaAsistente({ ...base, respuesta_sintetizada: "  " }, "MENSAJE", true),
    LLMInvalidResponseError,
  );
});

Deno.test("herramienta omitida se asume NINGUNA", () => {
  const { herramienta: _h, herramienta_parametro: _p, ...sinTools } = base;
  const r = validateRespuestaAsistente(sinTools, "MENSAJE", true);
  assertEquals(r.herramienta, "NINGUNA");
});

Deno.test("trunca respuestas largas a MAX_TTS_CHARS", () => {
  const larga = "Esta es una oración bastante larga para la prueba. ".repeat(10);
  const r = validateRespuestaAsistente({ ...base, respuesta_sintetizada: larga }, "MENSAJE", true);
  assert(r.respuesta_sintetizada.length <= 240);
});

Deno.test("toGeminiResponse mapea CONVERSACION → MENSAJE (contrato histórico)", () => {
  const r = validateRespuestaAsistente(base, "MENSAJE", true);
  const g = toGeminiResponse(r);
  assertEquals(g.intencion_detectada, "MENSAJE");
  assertEquals(Object.keys(g).sort(), [
    "destinatario_identificado",
    "intencion_detectada",
    "prioridad_sugerida",
    "respuesta_sintetizada",
  ]);
});

// ── buildContextMessage ───────────────────────────────────────────────────────

const contexto: ContextoConversacional = {
  nombre_adulto: "Don Carlos",
  edad_adulto: 81,
  fecha_hora_local: "jueves, 12 de noviembre de 2026, 13:49",
  timezone: "America/Santiago",
  red_apoyo: [
    { usuario_app_id: "u1", nombre: "Martin", rol: "ADMINISTRADOR", apodos_reconocimiento: ["martin"] },
    { usuario_app_id: "u2", nombre: "jose", rol: "ADMINISTRADOR", apodos_reconocimiento: ["sobrino"] },
    { usuario_app_id: "u3", nombre: "Martín (Cuidador Prueba)", rol: "ADMINISTRADOR", apodos_reconocimiento: [] },
  ],
  turnos_recientes: [
    { hace_minutos: 1, texto_usuario: "mándale un mensaje a martín", respuesta_coco: "¿Qué le quiere decir a Martín?" },
  ],
};

Deno.test("el mensaje de contexto incluye fecha, nombre, red, memoria y transcripción", () => {
  const msg = buildContextMessage("que voy a almorzar", "MENSAJE", contexto);
  assertStringIncludes(msg, "2026");
  assertStringIncludes(msg, "Don Carlos");
  assertStringIncludes(msg, "81 años");
  assertStringIncludes(msg, '"sobrino"');
  assertStringIncludes(msg, "¿Qué le quiere decir a Martín?");
  assertStringIncludes(msg, '"que voy a almorzar"');
  assert(!msg.includes("Cuidador Prueba"), "no debe exponer etiquetas entre paréntesis");
  assert(!msg.includes("ADMINISTRADOR"), "rol es permiso, no parentesco");
});

Deno.test("el mensaje de contexto marca el SOS", () => {
  const msg = buildContextMessage("ayuda", "ALERTA_SOS", { ...contexto, red_apoyo: [], turnos_recientes: [] });
  assertStringIncludes(msg, "ALERTA SOS");
  assertStringIncludes(msg, "sin contactos registrados");
});

Deno.test("mensaje de la 2ª pasada es compacto (sin red ni memoria)", () => {
  const msg = buildToolResultMessage("clima en chiguayante", contexto, "CLIMA", "Chiguayante", "Clima en Chiguayante...");
  assertStringIncludes(msg, "Don Carlos");
  assertStringIncludes(msg, "DATOS DE CLIMA");
  assert(!msg.includes("sobrino"));
  assertStringIncludes(msg, "TURNO ANTERIOR"); // seguimiento: "en Concepción" tras "¿clima mañana?"
  const sinMemoria = buildToolResultMessage("x", { ...contexto, turnos_recientes: [] }, "NOTICIAS", null, null);
  assertStringIncludes(sinMemoria, "DATOS NO DISPONIBLES");
  assert(!sinMemoria.includes("TURNO ANTERIOR"));
});

Deno.test("parseRetryAfterMs lee cabecera y mensaje de Groq", () => {
  assertEquals(parseRetryAfterMs("2", ""), 2000);
  assertEquals(parseRetryAfterMs(null, "Please try again in 951.428571ms. Need more"), 952);
  assertEquals(parseRetryAfterMs(null, "Please try again in 12.557142857s. Need"), 12558);
  assertEquals(parseRetryAfterMs(null, "sin pista"), null);
});

// ── Groq reasoning_effort ────────────────────────────────────────────────────

Deno.test("reasoning_effort: none para qwen3, omitido para otros, override por env", () => {
  Deno.env.delete("GROQ_REASONING_EFFORT");
  assertEquals(resolveGroqReasoningEffort("qwen/qwen3.8-27b"), "none");
  assertEquals(resolveGroqReasoningEffort("llama-3.3-70b-versatile"), null);
  Deno.env.set("GROQ_REASONING_EFFORT", "low");
  assertEquals(resolveGroqReasoningEffort("llama-3.3-70b-versatile"), "low");
  Deno.env.set("GROQ_REASONING_EFFORT", "omit");
  assertEquals(resolveGroqReasoningEffort("qwen/qwen3.8-27b"), null);
  Deno.env.delete("GROQ_REASONING_EFFORT");
});

// ── toolsService ─────────────────────────────────────────────────────────────

Deno.test("parsea titulares de Google News RSS", () => {
  const xml = `<rss><channel><title>Google News</title>
    <item><title>Paro de camioneros sigue &amp; crece - BioBioChile</title><source url="x">BioBioChile</source></item>
    <item><title><![CDATA[Alerta por calor: hasta 38°C - La Tercera]]></title></item>
  </channel></rss>`;
  const t = parsearTitularesRss(xml, 4);
  assertEquals(t.length, 2);
  assertEquals(t[0], { titular: "Paro de camioneros sigue & crece", fuente: "BioBioChile" });
  assertEquals(t[1], { titular: "Alerta por calor: hasta 38°C", fuente: "La Tercera" });
});

Deno.test("WMO y limpieza de lugar", () => {
  assertEquals(describirCodigoWmo(0), "despejado");
  assertEquals(describirCodigoWmo(63), "con lluvia");
  assertEquals(limpiarLugar("en la ciudad de Chiguayante?"), "Chiguayante");
});

Deno.test("elegirLugar prioriza Chile salvo que el global sea mucho más relevante", () => {
  const cand = (pais: string, poblacion: number) => ({ nombre: "X", region: null, pais, lat: 0, lon: 0, poblacion });
  assertEquals(elegirLugar(cand("Chile", 223_000), cand("Paraguay", 76_000))?.pais, "Chile");
  assertEquals(elegirLugar(cand("Chile", 0), cand("Argentina", 13_000_000))?.pais, "Argentina");
  assertEquals(elegirLugar(null, cand("España", 3_000_000))?.pais, "España");
  assertEquals(elegirLugar(null, null), null);
});

Deno.test("formatea el clima en texto apto para el LLM", () => {
  const txt = formatearClima(
    { nombre: "Chiguayante", region: "Región del Biobío", pais: "Chile", lat: 0, lon: 0 },
    {
      current: { temperature_2m: 22.8, apparent_temperature: 24.7, weather_code: 1 },
      daily: {
        time: ["2026-11-12", "2026-11-13"],
        weather_code: [45, 3],
        temperature_2m_max: [22.8, 27.5],
        temperature_2m_min: [11.4, 13.0],
        precipitation_probability_max: [0, 10],
      },
    },
  );
  assertStringIncludes(txt, "Chiguayante");
  assertStringIncludes(txt, "Ahora: 23 °C");
  assertStringIncludes(txt, "Mañana (viernes 13)");
  assertStringIncludes(txt, "probabilidad de lluvia 10%");
});

Deno.test("limpia el extracto de Wikipedia CONSERVANDO las fechas (Iteración 11)", () => {
  const e = limpiarExtracto("Lucila Godoy​ (Vicuña, 1889-1957),​ conocida como Gabriela Mistral, fue poeta.");
  assertEquals(e, "Lucila Godoy (Vicuña, 1889-1957), conocida como Gabriela Mistral, fue poeta.");
  const mj = limpiarExtracto(
    "Michael Joseph Jackson (Gary, 29 de agosto de 1958-Los Ángeles, 25 de junio de 2009) fue un cantante.",
  );
  assertStringIncludes(mj, "25 de junio de 2009");
  // Los paréntesis sin dígitos (pronunciación, idioma) sí se quitan.
  assertEquals(limpiarExtracto("Andrés el Apóstol (en griego: Ἀνδρέας), también conocido."), "Andrés el Apóstol, también conocido.");
});

// ── contextService ───────────────────────────────────────────────────────────

const ahora = new Date("2026-11-12T16:49:00Z"); // 13:49 en Santiago (UTC-3)

Deno.test("fecha/hora local en la zona horaria del abuelo", () => {
  const f = buildFechaHoraLocal("America/Santiago", ahora);
  assertStringIncludes(f, "2026");
  assertStringIncludes(f, "noviembre");
  assertStringIncludes(f, "13:49");
  // Zona inválida → fallback sin lanzar error
  assertStringIncludes(buildFechaHoraLocal("Zona/Inexistente", ahora), "2026");
});

Deno.test("edad calculada en la fecha local", () => {
  assertEquals(calcularEdad("1945-06-14", "America/Santiago", ahora), 81);
  assertEquals(calcularEdad("1945-12-01", "America/Santiago", ahora), 80);
  assertEquals(calcularEdad(null), null);
});

const deviceRow = {
  id: "d1",
  adulto_mayor_id: "a1",
  timezone: "America/Santiago",
  adultos_mayores: { nombre: "Don Carlos", fecha_nacimiento: "1945-06-14" },
  red_apoyo: [
    { usuario_app_id: "u1", rol: "ADMINISTRADOR", apodos_reconocimiento: ["martin"], activo: true, usuarios_app: { nombre: "Martín" } },
    { usuario_app_id: "u2", rol: "CONTACTO", apodos_reconocimiento: ["sobrino"], activo: true, usuarios_app: { nombre: "jose" } },
    { usuario_app_id: "u9", rol: "CONTACTO", apodos_reconocimiento: ["ex"], activo: false, usuarios_app: { nombre: "Inactivo" } },
    {
      usuario_app_id: "u3",
      rol: "ADMINISTRADOR",
      apodos_reconocimiento: [],
      activo: true,
      usuarios_app: [{ nombre: "Martín (Cuidador Prueba)" }],
    },
  ],
};

Deno.test("mapDeviceRow filtra contactos inactivos y aplana embebidos", () => {
  const d = mapDeviceRow(deviceRow);
  assertEquals(d.nombre_adulto, "Don Carlos");
  assertEquals(d.red_apoyo.map((c) => c.usuario_app_id), ["u1", "u2", "u3"]);
  assertEquals(d.red_apoyo[2].nombre, "Martín (Cuidador Prueba)");
});

Deno.test("pistas STT: coco + nombres/apodos reales, sin palabras genéricas", () => {
  Deno.env.delete("DEEPGRAM_KEYWORDS");
  const hints = buildSttHints(mapDeviceRow(deviceRow));
  assertEquals(hints[0], "coco");
  for (const h of ["carlos", "martín", "sobrino", "jose"]) assert(hints.includes(h), `falta ${h}`);
  for (const h of ["don", "cuidador", "prueba", "inactivo"]) assert(!hints.includes(h), `sobra ${h}`);
  assertEquals(buildSttHints(null), ["coco"]);
});

Deno.test("buildContextoConversacional arma el contexto completo", () => {
  const ctx = buildContextoConversacional(mapDeviceRow(deviceRow), [], ahora);
  assertEquals(ctx.edad_adulto, 81);
  assertEquals(ctx.red_apoyo.length, 3);
  assertStringIncludes(ctx.fecha_hora_local ?? "", "13:49");
});

// ── sttService ───────────────────────────────────────────────────────────────

Deno.test("keywords para nova-2 y keyterm para nova-3", () => {
  Deno.env.delete("DEEPGRAM_KEYWORD_BOOST");
  const p2 = new URLSearchParams();
  appendVocabularyHints(p2, "nova-2", ["coco", "martín", "coco"]);
  assertEquals(p2.getAll("keywords"), ["coco:2", "martín:1.5"]);
  assertEquals(p2.getAll("keyterm"), []);

  const p3 = new URLSearchParams();
  appendVocabularyHints(p3, "nova-3", ["coco", "martín"]);
  assertEquals(p3.getAll("keyterm"), ["coco", "martín"]);
  assertEquals(p3.getAll("keywords"), []);
});

// ── 2ª pasada y red de seguridad SOS ─────────────────────────────────────────

Deno.test("2ª pasada: solo exige respuesta_sintetizada (ignora intención rara como 'CLIMA')", () => {
  const r = validateSoloRespuesta({ intencion_detectada: "CLIMA", respuesta_sintetizada: "Mañana estará nublado." });
  assertEquals(r.respuesta_sintetizada, "Mañana estará nublado.");
  assertEquals(r.herramienta, "NINGUNA");
  assertThrows(() => validateSoloRespuesta({ respuesta_sintetizada: "" }), LLMInvalidResponseError);
});

Deno.test("detector local de emergencia (solo si los LLM fallan)", () => {
  for (const t of ["ayúdame me siento muy mal", "me caí y no me puedo levantar", "no puedo respirar", "auxilio", "ayuda", "coco ayuda", "me duele el pecho"]) {
    assert(detectarEmergenciaLocal(t), `debería detectar: ${t}`);
  }
  for (const t of ["hola coco cómo estás", "qué hora es", "me ayudas con una receta", "mi hijo me ayuda con las compras"]) {
    assert(!detectarEmergenciaLocal(t), `no debería detectar: ${t}`);
  }
});

// ── Iteración 11: herramientas nuevas ────────────────────────────────────────

Deno.test("el validador acepta las herramientas nuevas", () => {
  for (const h of ["INDICADORES", "CALENDARIO", "BUSQUEDA_WEB"]) {
    const r = validateRespuestaAsistente(
      { ...base, herramienta: h, herramienta_parametro: "x", respuesta_sintetizada: "Déjeme revisar." },
      "MENSAJE",
      true,
    );
    assertEquals(r.herramienta, h);
  }
});

Deno.test("parsea RSS de Bing News (descripción + News:Source) y descarta descripciones que repiten el titular", () => {
  const bing = `<rss><channel><item><title>Gremios en alerta por paro</title><link>x</link>
    <description>La C&#225;mara Nacional de Comercio enumer&#243; perjuicios.</description>
    <News:Source>La Tercera</News:Source></item></channel></rss>`;
  assertEquals(parsearItemsRss(bing), [
    { titulo: "Gremios en alerta por paro", descripcion: "La Cámara Nacional de Comercio enumeró perjuicios.", fuente: "La Tercera" },
  ]);
  const google = `<item><title>Fin del paro - BioBioChile</title><description>&lt;a href="x"&gt;Fin del paro&lt;/a&gt;</description><source url="y">BioBioChile</source></item>`;
  assertEquals(parsearItemsRss(google)[0], { titulo: "Fin del paro", descripcion: null, fuente: "BioBioChile" });
});

Deno.test("combina noticias sin duplicados y priorizando las que tienen resumen", () => {
  const a = [{ titulo: "Fin del paro de camioneros", descripcion: null, fuente: "G" }];
  const b = [{ titulo: "Fin del paro de camioneros", descripcion: "Acuerdo con el Gobierno", fuente: "B" }];
  const r = combinarNoticias([a, b]);
  assertEquals(r.length, 1);
  assertEquals(r[0].fuente, "B");
  assert(!formatearNoticias(r, "paro").includes(".."));
});

Deno.test("filtro de relevancia descarta resultados web basura", () => {
  assert(esRelevante("Laura Pausini confirmada para el Festival de Viña 2027", "Laura Pausini Festival de Viña"));
  assert(!esRelevante("Kopitiam - Lowyat.NET forum threads", "Laura Pausini Festival de Viña"));
});

const findic = {
  version: "1.3.0",
  fecha: "2026-11-12",
  uf: { codigo: "uf", nombre: "Unidad de fomento (UF)", unidad_medida: "Pesos", fecha: "2026-11-12", valor: 41316.06 },
  dolar: { codigo: "dolar", nombre: "Dólar observado", unidad_medida: "Pesos", fecha: "2026-11-12", valor: 984.49 },
  ipc: { codigo: "ipc", nombre: "IPC", unidad_medida: "Porcentaje", fecha: "2026-10-01", valor: 0.5 },
  bitcoin: { codigo: "bitcoin", nombre: "Bitcoin", unidad_medida: "Dólar", fecha: "2026-11-12", valor: 98000 },
};

Deno.test("indicadores: parseo findic/mindicador, filtro y formato chileno", () => {
  const lista = parsearIndicadores(findic);
  assertEquals(lista.length, 4);
  const uf = seleccionarIndicadores(lista, "valor de la UF hoy");
  assertEquals(uf.map((i) => i.codigo), ["uf"]);
  const txt = formatearIndicadores(uf, "findic.cl");
  assertStringIncludes(txt, "$41.316,06");
  assertStringIncludes(txt, "12 de noviembre de 2026");
  assertEquals(seleccionarIndicadores(lista, "dólar").map((i) => i.codigo), ["dolar"]);
  assertEquals(seleccionarIndicadores(lista, null).map((i) => i.codigo), ["uf", "dolar", "ipc"]); // principales disponibles
  assertStringIncludes(formatearIndicadores(seleccionarIndicadores(lista, "inflación"), "x"), "0,5%");
});

Deno.test("fase lunar en fechas conocidas", () => {
  assertEquals(calcularFaseLunar(new Date("2024-04-08T18:21:00Z")).nombre, "luna nueva");
  assertEquals(calcularFaseLunar(new Date("2024-04-23T23:49:00Z")).nombre, "luna llena");
  assert(calcularFaseLunar(new Date("2024-04-23T23:49:00Z")).iluminacion >= 98);
});

const textoDia = `Acontecimientos
== Celebraciones ==
Día Mundial contra la Neumonía.Jornada internacional de concientización.
Por países
(Por orden alfabético)
Chile Chile: Día del Bombero.
== Santoral católico ===

San Josafat Kuncewicz.​Monje basiliano y arzobispo de Polotsk.
San Diego de Alcalá.​Religioso franciscano español.
== Véase también ==
x`;

Deno.test("extrae santoral y celebraciones de la página del día", () => {
  assertEquals(extraerSantoral(textoDia), ["San Josafat Kuncewicz", "San Diego de Alcalá"]);
  const c = extraerCelebraciones(textoDia);
  assertStringIncludes(c.join(" | "), "Día Mundial contra la Neumonía");
  assertStringIncludes(c.join(" | "), "Día del Bombero");
});

Deno.test("resolverFecha interpreta hoy, mañana y fechas en texto", () => {
  const now = new Date("2026-11-12T16:49:00Z");
  assertEquals(resolverFecha("hoy", "America/Santiago", now), { y: 2026, m: 11, d: 12 });
  assertEquals(resolverFecha("mañana", "America/Santiago", now), { y: 2026, m: 11, d: 13 });
  assertEquals(resolverFecha("30 de noviembre", "America/Santiago", now), { y: 2026, m: 11, d: 30 });
  assertEquals(resolverFecha("1 de enero", "America/Santiago", now), { y: 2027, m: 1, d: 1 }); // ya pasó → próximo año
  assertEquals(resolverFecha("2026-12-25", "America/Santiago", now), { y: 2026, m: 12, d: 25 });
});

Deno.test("próximos feriados y días que faltan", () => {
  const f = proximosFeriados(
    [{ fecha: "2026-12-25", nombre: "Navidad" }, { fecha: "2026-11-01", nombre: "Todos los Santos" }, { fecha: "2026-12-08", nombre: "Inmaculada" }],
    { y: 2026, m: 11, d: 12 },
  );
  assertEquals(f.map((x) => [x.nombre, x.faltan]), [["Inmaculada", 26], ["Navidad", 43]]);
});

Deno.test("formatea la respuesta de Tavily", () => {
  const t = formatearTavily({
    answer: "Laura Pausini es la primera artista confirmada para Viña 2027.",
    results: [{ title: "Pausini a Viña", content: "La italiana regresa a la Quinta Vergara.", url: "https://www.latercera.com/x" }],
  }, "pausini viña");
  assertStringIncludes(t ?? "", "Respuesta resumida");
  assertStringIncludes(t ?? "", "latercera.com");
  assertEquals(formatearTavily({ results: [] }, "x"), null);
});

Deno.test("Wikipedia: detecta y salta páginas de desambiguación", () => {
  const desamb = { index: 1, title: "Sierra Gorda", extract: "Sierra Gorda hace referencia a varios artículos:", pageprops: { disambiguation: "" } };
  const mexico = { index: 2, title: "Sierra Gorda (México)", extract: "La Sierra Gorda se ubica en México." };
  assert(esDesambiguacion(desamb));
  assert(esDesambiguacion({ extract: "Mercurio puede referirse a: el planeta…" }));
  assert(!esDesambiguacion(mexico));

  const r = elegirArticuloWikipedia([mexico, desamb]); // desordenado: manda `index`
  assertEquals(r.ambiguo, true);
  assertEquals(r.articulo?.title, "Sierra Gorda (México)");

  const directo = elegirArticuloWikipedia([{ index: 1, title: "Michael Jackson", extract: "Michael Joseph Jackson (Gary, 1958-2009) fue…" }]);
  assertEquals(directo.ambiguo, false);
  assertEquals(directo.articulo?.title, "Michael Jackson");
  assertEquals(elegirArticuloWikipedia([]).articulo, null);
});

Deno.test("detecta preguntas que piden un dato concreto (complemento web)", () => {
  assertStringIncludes(terminosDatoConcreto("dónde está ubicada la comuna de sierra gorda y cuántos habitantes tiene") ?? "", "habitantes");
  assertStringIncludes(terminosDatoConcreto("dónde queda la universidad santa maría de concepción") ?? "", "dirección");
  assertEquals(terminosDatoConcreto("dónde está ubicada la comuna de sierra gorda"), null); // Wikipedia basta
  assertStringIncludes(terminosDatoConcreto("a qué hora abre el museo") ?? "", "horario");
  assertEquals(terminosDatoConcreto("cuándo falleció michael jackson"), null);
  assertEquals(terminosDatoConcreto("quién fue gabriela mistral"), null);
});
