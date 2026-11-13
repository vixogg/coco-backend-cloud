/**
 * Herramientas de información en tiempo real para el asistente COCO (Iteraciones 10–11).
 * Fuentes gratuitas (sin tarjeta):
 *   - CLIMA:        Open-Meteo (geocoding + forecast)
 *   - NOTICIAS:     Google News RSS ∥ Bing News RSS (con resumen) ∥ Cooperativa RSS (portada)
 *   - ENCICLOPEDIA: Wikipedia en español (conserva fechas entre paréntesis)
 *   - INDICADORES:  findic.cl → respaldo mindicador.cl (UF, dólar, euro, UTM, IPC…)
 *   - CALENDARIO:   Wikipedia "D de mes" (santoral, celebraciones) + feriados (api.boostr.cl)
 *                   + fase lunar calculada localmente
 *   - BUSQUEDA_WEB: Tavily (si existe TAVILY_API_KEY, 1.000/mes gratis) ∥ respaldo sin key
 *                   (Bing News RSS + Bing web RSS filtrado por relevancia + Wikipedia search)
 *
 * Cada herramienta devuelve un TEXTO BREVE en español (no JSON crudo) que se inyecta en la
 * segunda pasada del LLM. Todas tienen timeout duro, fuentes en paralelo y caché en RAM.
 */
import type { Herramienta } from "../types.ts";

const USER_AGENT = "COCO-Assistant/1.0 (asistente de voz para adultos mayores)";
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)";
/** Tope por fuente (Wikipedia, Open-Meteo, RSS…). Configurable con TOOL_TIMEOUT_MS. */
const DEFAULT_TOOL_TIMEOUT_MS = 2500;
/** Tope de la búsqueda web: Tavily tarda 1,5–2,5 s desde Supabase. Configurable con TOOL_WEB_TIMEOUT_MS. */
const DEFAULT_WEB_TIMEOUT_MS = 4000;
const DEFAULT_TIMEZONE = "America/Santiago";

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/* ============================================================================
   UTILITARIOS: FETCH CON TIMEOUT, CACHÉ TTL, TEXTO
   ============================================================================ */

async function fetchConTimeout(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new ToolError(`HTTP ${res.status} en ${new URL(url).host}`);
    }
    return res;
  } catch (err) {
    if (err instanceof ToolError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ToolError(`Timeout (${timeoutMs}ms) en ${new URL(url).host}`);
    }
    throw new ToolError(err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeoutId);
  }
}

class TtlCache<T> {
  private map = new Map<string, { value: T; expiresAt: number }>();
  constructor(private ttlMs: number, private maxItems = 100) {}
  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }
  set(key: string, value: T): void {
    if (this.map.size >= this.maxItems) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}

function normalizar(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function claveCache(texto: string): string {
  return normalizar(texto);
}

function recortar(texto: string, max: number): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  if (limpio.length <= max) return limpio;
  const corte = limpio.slice(0, max);
  const ultimoPunto = corte.lastIndexOf(". ");
  return (ultimoPunto > max * 0.5 ? corte.slice(0, ultimoPunto + 1) : `${corte.slice(0, corte.lastIndexOf(" "))}…`).trim();
}

/** Agrega punto final solo si el texto no termina ya en signo de puntuación. */
function conPunto(s: string): string {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
}

function limpiarHtml(s: string): string {
  return decodificarEntidades(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

const STOPWORDS = new Set([
  "de", "del", "la", "las", "el", "los", "un", "una", "y", "o", "en", "a", "al", "que", "por", "para",
  "con", "se", "es", "lo", "su", "sus", "hoy", "cual", "como", "cuando", "donde", "quien", "que",
  "esta", "este", "va", "ser", "hay", "me", "mi", "le",
]);

/** Palabras significativas de una consulta (para filtrar resultados irrelevantes). */
export function palabrasClave(consulta: string): string[] {
  return normalizar(consulta)
    .replace(/[^a-z0-9ñ\s]/g, " ")
    .split(/\s+/)
    .filter((p) => p.length >= 3 && !STOPWORDS.has(p));
}

/** true si el texto contiene al menos la mitad de las palabras clave de la consulta. */
export function esRelevante(texto: string, consulta: string): boolean {
  const claves = palabrasClave(consulta);
  if (claves.length === 0) return true;
  const t = normalizar(texto);
  const presentes = claves.filter((k) => t.includes(k)).length;
  return presentes >= Math.max(1, Math.ceil(claves.length / 2));
}

/* ============================================================================
   RSS GENÉRICO (Google News, Bing News, Bing web, medios chilenos)
   ============================================================================ */

function decodificarEntidades(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

export interface ItemRss {
  titulo: string;
  descripcion: string | null;
  fuente: string | null;
}

/** Extrae ítems de cualquier RSS 2.0 (multilínea, CDATA, <source> o <News:Source>). */
export function parsearItemsRss(xml: string, max = 10): ItemRss[] {
  const items: ItemRss[] = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null && items.length < max) {
    const bloque = m[1];
    const tituloRaw = /<title>([\s\S]*?)<\/title>/.exec(bloque)?.[1];
    if (!tituloRaw) continue;
    let titulo = limpiarHtml(tituloRaw);
    const fuenteRaw = /<(?:source|News:Source)[^>]*>([\s\S]*?)<\/(?:source|News:Source)>/.exec(bloque)?.[1];
    let fuente = fuenteRaw ? limpiarHtml(fuenteRaw) : null;
    const corte = titulo.lastIndexOf(" - ");
    if (corte > 0 && (!fuente || titulo.endsWith(fuente))) {
      fuente = fuente ?? titulo.slice(corte + 3).trim();
      titulo = titulo.slice(0, corte).trim();
    }
    const descRaw = /<description>([\s\S]*?)<\/description>/.exec(bloque)?.[1];
    let descripcion = descRaw ? limpiarHtml(descRaw) : null;
    // Google News repite el titular en la descripción: no aporta.
    if (descripcion && normalizar(descripcion).startsWith(normalizar(titulo).slice(0, 30))) descripcion = null;
    if (titulo) items.push({ titulo, descripcion: descripcion || null, fuente });
  }
  return items;
}

/** Compatibilidad (Iteración 10): titulares sin el sufijo " - Fuente". */
export function parsearTitularesRss(xml: string, max = 4): Array<{ titular: string; fuente: string | null }> {
  return parsearItemsRss(xml, max).map((i) => ({ titular: i.titulo, fuente: i.fuente }));
}

async function leerRss(url: string, timeoutMs: number, max = 8, navegador = false): Promise<ItemRss[]> {
  const res = await fetchConTimeout(url, timeoutMs, navegador ? { headers: { "User-Agent": BROWSER_UA } } : {});
  return parsearItemsRss(await res.text(), max);
}

const urlBingNews = (q: string) =>
  `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=es&cc=CL`;
const urlBingWeb = (q: string) =>
  `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&setlang=es&cc=CL`;

/* ============================================================================
   1. CLIMA (OPEN-METEO)
   ============================================================================ */

interface Lugar {
  nombre: string;
  region: string | null;
  pais: string | null;
  lat: number;
  lon: number;
}

const GEO_CACHE = new TtlCache<Lugar | null>(30 * 60 * 1000);
const CLIMA_CACHE = new TtlCache<string>(15 * 60 * 1000);

const WMO_ES: Record<number, string> = {
  0: "despejado",
  1: "mayormente despejado",
  2: "parcialmente nublado",
  3: "nublado",
  45: "con niebla",
  48: "con niebla y escarcha",
  51: "con llovizna débil",
  53: "con llovizna",
  55: "con llovizna intensa",
  56: "con llovizna helada",
  57: "con llovizna helada intensa",
  61: "con lluvia débil",
  63: "con lluvia",
  65: "con lluvia intensa",
  66: "con lluvia helada",
  67: "con lluvia helada intensa",
  71: "con nevada débil",
  73: "con nevada",
  75: "con nevada intensa",
  77: "con granizo fino",
  80: "con chubascos débiles",
  81: "con chubascos",
  82: "con chubascos fuertes",
  85: "con chubascos de nieve",
  86: "con chubascos de nieve fuertes",
  95: "con tormenta eléctrica",
  96: "con tormenta y granizo",
  99: "con tormenta fuerte y granizo",
};

export function describirCodigoWmo(code: number | null | undefined): string {
  if (code === null || code === undefined) return "sin información del cielo";
  return WMO_ES[code] ?? "con condiciones variables";
}

/** Limpia muletillas habituales que el LLM podría dejar en el parámetro ("en Chiguayante", "la ciudad de…"). */
export function limpiarLugar(raw: string): string {
  return raw
    .replace(/^\s*(en|para|de)\s+/i, "")
    .replace(/^\s*(la\s+)?(ciudad|comuna)\s+de\s+/i, "")
    .replace(/[¿?¡!.]/g, "")
    .trim();
}

async function geocodificar(lugarRaw: string, timeoutMs: number): Promise<Lugar | null> {
  const lugar = limpiarLugar(lugarRaw);
  if (!lugar) return null;
  const key = claveCache(lugar);
  const cached = GEO_CACHE.get(key);
  if (cached !== undefined) return cached;

  const buscar = async (conFiltroChile: boolean): Promise<LugarCandidato | null> => {
    const params = new URLSearchParams({ name: lugar, count: "1", language: "es", format: "json" });
    if (conFiltroChile) params.set("countryCode", "CL");
    const res = await fetchConTimeout(
      `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`,
      timeoutMs,
    );
    const json = await res.json() as {
      results?: Array<{
        name: string;
        admin1?: string;
        country?: string;
        latitude: number;
        longitude: number;
        population?: number;
      }>;
    };
    const r = json.results?.[0];
    if (!r) return null;
    return {
      nombre: r.name,
      region: r.admin1 ?? null,
      pais: r.country ?? null,
      lat: r.latitude,
      lon: r.longitude,
      poblacion: r.population ?? 0,
    };
  };

  // Búsqueda en Chile y mundial EN PARALELO (sin costo de latencia).
  const [rChile, rGlobal] = await Promise.allSettled([buscar(true), buscar(false)]);
  if (rChile.status === "rejected" && rGlobal.status === "rejected") {
    throw new ToolError(`Geocoding no disponible: ${rChile.reason instanceof Error ? rChile.reason.message : rChile.reason}`);
  }
  const enChile = rChile.status === "fulfilled" ? rChile.value : null;
  const global = rGlobal.status === "fulfilled" ? rGlobal.value : null;
  const resultado = elegirLugar(enChile, global);

  // Solo se cachea una respuesta completa (ambas búsquedas OK) para no fijar un error transitorio.
  if (rChile.status === "fulfilled" && rGlobal.status === "fulfilled") {
    GEO_CACHE.set(key, resultado);
  }
  return resultado;
}

interface LugarCandidato extends Lugar {
  poblacion: number;
}

/**
 * Prioriza Chile (los usuarios son chilenos), salvo que el resultado mundial sea mucho más
 * relevante: "Buenos Aires" → Argentina (no un caserío chileno homónimo), pero
 * "Concepción" → Chile y "Santiago" → Chile.
 */
export function elegirLugar(enChile: LugarCandidato | null, global: LugarCandidato | null): Lugar | null {
  const limpiar = (c: LugarCandidato): Lugar => ({
    nombre: c.nombre,
    region: c.region,
    pais: c.pais,
    lat: c.lat,
    lon: c.lon,
  });
  if (enChile && global && global.poblacion > Math.max(10_000, enChile.poblacion * 10)) {
    return limpiar(global);
  }
  if (enChile) return limpiar(enChile);
  return global ? limpiar(global) : null;
}

function nombreDia(fechaIso: string): string {
  // fechaIso = "YYYY-MM-DD" (fecha local del lugar). Se evalúa a mediodía UTC para no cambiar de día.
  const d = new Date(`${fechaIso}T12:00:00Z`);
  return new Intl.DateTimeFormat("es-CL", { timeZone: "UTC", weekday: "long", day: "numeric" }).format(d);
}

const redondear = (n: number | null | undefined) =>
  typeof n === "number" ? String(Math.round(n)) : "?";

interface ForecastJson {
  current?: { temperature_2m?: number; apparent_temperature?: number; weather_code?: number };
  daily?: {
    time?: string[];
    weather_code?: number[];
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_probability_max?: number[];
  };
}

export function formatearClima(lugar: Lugar, f: ForecastJson): string {
  const ubic = [lugar.nombre, lugar.region, lugar.pais].filter(Boolean).join(", ");
  const partes: string[] = [`Clima en ${ubic}.`];
  if (f.current) {
    partes.push(
      `Ahora: ${redondear(f.current.temperature_2m)} °C (sensación ${redondear(f.current.apparent_temperature)} °C), ${describirCodigoWmo(f.current.weather_code)}.`,
    );
  }
  const etiquetas = ["Hoy", "Mañana", "Pasado mañana"];
  const dias = f.daily?.time ?? [];
  for (let i = 0; i < Math.min(dias.length, 3); i++) {
    const lluvia = f.daily?.precipitation_probability_max?.[i];
    partes.push(
      `${etiquetas[i]} (${nombreDia(dias[i])}): ${describirCodigoWmo(f.daily?.weather_code?.[i])}, máxima ${redondear(f.daily?.temperature_2m_max?.[i])} °C, mínima ${redondear(f.daily?.temperature_2m_min?.[i])} °C, probabilidad de lluvia ${typeof lluvia === "number" ? lluvia : "?"}%.`,
    );
  }
  return partes.join(" ");
}

export async function consultarClima(lugarRaw: string, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const restante = () => Math.max(200, deadline - Date.now());

  const lugar = await geocodificar(lugarRaw, restante());
  if (!lugar) {
    return `No se encontró ningún lugar llamado "${limpiarLugar(lugarRaw)}".`;
  }

  const key = `${lugar.lat.toFixed(2)},${lugar.lon.toFixed(2)}`;
  const cached = CLIMA_CACHE.get(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    latitude: String(lugar.lat),
    longitude: String(lugar.lon),
    current: "temperature_2m,apparent_temperature,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "3",
  });
  const res = await fetchConTimeout(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, restante());
  const texto = formatearClima(lugar, await res.json() as ForecastJson);
  CLIMA_CACHE.set(key, texto);
  return texto;
}

/* ============================================================================
   2. NOTICIAS (GOOGLE NEWS ∥ BING NEWS ∥ COOPERATIVA)
   ============================================================================ */

const NOTICIAS_CACHE = new TtlCache<string>(10 * 60 * 1000, 50);

/** Mezcla fuentes priorizando las que traen resumen, sin duplicados (por inicio del titular). */
export function combinarNoticias(listas: ItemRss[][], max = 5): ItemRss[] {
  const vistos = new Set<string>();
  const salida: ItemRss[] = [];
  const conResumen = listas.flat().filter((i) => i.descripcion);
  const sinResumen = listas.flat().filter((i) => !i.descripcion);
  for (const item of [...conResumen, ...sinResumen]) {
    const clave = normalizar(item.titulo).replace(/[^a-z0-9 ]/g, "").slice(0, 40);
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    salida.push(item);
    if (salida.length >= max) break;
  }
  return salida;
}

export function formatearNoticias(items: ItemRss[], tema: string | null): string {
  if (items.length === 0) {
    return `No se encontraron noticias recientes${tema ? ` sobre "${tema}"` : ""}.`;
  }
  return `Noticias recientes${tema ? ` sobre "${tema}"` : " de Chile"}: ` +
    items.map((t, i) =>
      conPunto(`${i + 1}) ${t.titulo}${t.fuente ? ` (${t.fuente})` : ""}${t.descripcion ? `: ${recortar(t.descripcion, 180)}` : ""}`)
    ).join(" ");
}

export async function consultarNoticias(tema: string | null, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS): Promise<string> {
  const temaLimpio = (tema ?? "").replace(/[¿?¡!]/g, "").trim();
  const esPortada = !temaLimpio || /^(chile|noticias|actualidad|hoy|general)$/i.test(temaLimpio);
  const key = esPortada ? "__portada__" : claveCache(temaLimpio);
  const cached = NOTICIAS_CACHE.get(key);
  if (cached) return cached;

  const t = Math.min(timeoutMs, 2200);
  const locale = "hl=es-419&gl=CL&ceid=CL:es-419";
  const fuentes: Array<Promise<ItemRss[]>> = esPortada
    ? [
      leerRss(`https://news.google.com/rss?${locale}`, t, 8),
      leerRss(urlBingNews("Chile"), t, 8, true),
      leerRss("https://www.cooperativa.cl/noticias/site/tax/port/all/rss_3___1.xml", t, 8),
    ]
    : [
      leerRss(`https://news.google.com/rss/search?q=${encodeURIComponent(`${temaLimpio} when:3d`)}&${locale}`, t, 8),
      leerRss(urlBingNews(temaLimpio), t, 8, true),
    ];

  const resultados = await Promise.allSettled(fuentes);
  const listas = resultados.filter((r): r is PromiseFulfilledResult<ItemRss[]> => r.status === "fulfilled")
    .map((r) => r.value);
  if (listas.length === 0) {
    const motivo = resultados[0].status === "rejected" ? String(resultados[0].reason) : "sin respuesta";
    throw new ToolError(`Ninguna fuente de noticias respondió (${motivo})`);
  }
  const texto = formatearNoticias(combinarNoticias(listas, 5), esPortada ? null : temaLimpio);
  NOTICIAS_CACHE.set(key, texto);
  return texto;
}

/* ============================================================================
   3. ENCICLOPEDIA (WIKIPEDIA EN ESPAÑOL)
   ============================================================================ */

const ENCICLOPEDIA_CACHE = new TtlCache<string>(60 * 60 * 1000, 100);
const MAX_EXTRACTO_CHARS = 1100;

/**
 * Limpia el extracto conservando los paréntesis con DÍGITOS (fechas de nacimiento/muerte,
 * años) y quitando los que no aportan a la voz (pronunciación, "en griego: …").
 */
export function limpiarExtracto(extracto: string): string {
  return extracto
    .replace(/[​‌‍﻿]/g, "")
    .replace(/\s*\(([^()]*)\)/g, (_m, interior: string) => (/\d/.test(interior) ? ` (${interior.trim()})` : ""))
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_EXTRACTO_CHARS);
}

export interface PaginaWikipedia {
  index?: number;
  title?: string;
  extract?: string;
  pageprops?: Record<string, string>;
}

/** Página de desambiguación ("X hace referencia a varios artículos:"): no sirve como respuesta. */
export function esDesambiguacion(p: PaginaWikipedia): boolean {
  if (p.pageprops && "disambiguation" in p.pageprops) return true;
  return /\b(hace referencia a|puede referirse a|se refiere a varios)\b/i.test((p.extract ?? "").slice(0, 160));
}

/**
 * Elige el artículo entre los resultados de búsqueda (ordenados por relevancia).
 * `ambiguo` = el mejor resultado era una desambiguación: el término tiene varios significados y
 * conviene reintentar con más contexto antes de quedarse con el siguiente resultado.
 */
export function elegirArticuloWikipedia(paginas: PaginaWikipedia[]): { articulo: PaginaWikipedia | null; ambiguo: boolean } {
  const orden = [...paginas].sort((a, b) => (a.index ?? 99) - (b.index ?? 99));
  const ambiguo = orden.length > 0 && esDesambiguacion(orden[0]);
  const articulo = orden.find((p) => p.extract?.trim() && !esDesambiguacion(p)) ?? null;
  return { articulo, ambiguo };
}

async function buscarArticulosWikipedia(consulta: string, timeoutMs: number): Promise<PaginaWikipedia[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: consulta,
    gsrlimit: "3",
    prop: "extracts|pageprops",
    ppprop: "disambiguation",
    exintro: "1",
    explaintext: "1",
    exsentences: "5",
    exlimit: "3",
    redirects: "1",
    format: "json",
    formatversion: "2",
  });
  const res = await fetchConTimeout(`https://es.wikipedia.org/w/api.php?${params.toString()}`, timeoutMs);
  const json = await res.json() as { query?: { pages?: PaginaWikipedia[] } };
  return json.query?.pages ?? [];
}

export interface ResultadoEnciclopedia {
  texto: string;
  encontrado: boolean;
}

/**
 * Wikipedia es: busca el artículo, descarta desambiguaciones y, si el término es ambiguo,
 * reintenta una vez agregando "Chile" (el usuario vive en Chile: "Sierra Gorda" → la comuna).
 */
export async function consultarEnciclopediaDetalle(
  tema: string,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
): Promise<ResultadoEnciclopedia> {
  const temaLimpio = tema.replace(/[¿?¡!]/g, "").trim();
  if (!temaLimpio) return { texto: "No se indicó un tema para buscar.", encontrado: false };
  const key = claveCache(temaLimpio);
  const cached = ENCICLOPEDIA_CACHE.get(key);
  if (cached) return { texto: cached, encontrado: true };

  const limite = performance.now() + timeoutMs;
  let { articulo, ambiguo } = elegirArticuloWikipedia(await buscarArticulosWikipedia(temaLimpio, timeoutMs));
  const restante = limite - performance.now();
  if (ambiguo && !/\bchile\b/i.test(temaLimpio) && restante >= 300) {
    try {
      const reintento = elegirArticuloWikipedia(await buscarArticulosWikipedia(`${temaLimpio} Chile`, restante));
      if (reintento.articulo) articulo = reintento.articulo;
    } catch (err) {
      console.warn(`[TOOL ENCICLOPEDIA] Reintento con "Chile" falló: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (ambiguo) console.log(`[TOOL ENCICLOPEDIA] "${temaLimpio}" era ambiguo → artículo "${articulo?.title ?? "ninguno"}"`);

  if (!articulo?.extract) {
    return { texto: `No se encontró información en Wikipedia sobre "${temaLimpio}".`, encontrado: false };
  }
  const texto = `Según Wikipedia (artículo "${articulo.title}"): ${limpiarExtracto(articulo.extract)}`;
  ENCICLOPEDIA_CACHE.set(key, texto);
  return { texto, encontrado: true };
}

export async function consultarEnciclopedia(tema: string, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS): Promise<string> {
  return (await consultarEnciclopediaDetalle(tema, timeoutMs)).texto;
}

/**
 * Si la pregunta pide un DATO CONCRETO que el resumen de Wikipedia rara vez trae
 * (habitantes, dirección, teléfono, horario, precio, superficie, altura), devuelve las palabras
 * a agregar a una búsqueda web complementaria. null = basta con la enciclopedia.
 */
export function terminosDatoConcreto(pregunta: string): string | null {
  const t = normalizar(pregunta);
  const reglas: Array<[RegExp, string]> = [
    [/habitantes|poblacion|cuantas personas|cuanta gente/, "habitantes"],
    [/direccion|donde queda|como llego/, "dirección"],
    [/telefono|numero de contacto|correo/, "teléfono"],
    [/horario|a que hora (abre|cierra|atiende)|atiende/, "horario"],
    [/precio|cuanto cuesta|cuanto vale|valor de la entrada/, "precio"],
    [/superficie|cuanto mide|tamano|extension/, "superficie"],
    [/altura|altitud|metros sobre/, "altura"],
  ];
  const terminos = reglas.filter(([re]) => re.test(t)).map(([, s]) => s);
  return terminos.length > 0 ? terminos.join(" ") : null;
}

/* ============================================================================
   4. INDICADORES ECONÓMICOS DE CHILE (findic.cl → mindicador.cl)
   ============================================================================ */

export interface Indicador {
  codigo: string;
  nombre: string;
  unidad: string;
  fecha: string | null;
  valor: number;
}

const INDICADORES_CACHE = new TtlCache<{ lista: Indicador[]; fuente: string }>(30 * 60 * 1000, 2);
const INDICADORES_PRINCIPALES = ["uf", "dolar", "euro", "utm", "ipc"];
const SINONIMOS_INDICADOR: Array<[RegExp, string]> = [
  [/\buf\b|unidad de fomento/, "uf"],
  [/dolar/, "dolar"],
  [/euro/, "euro"],
  [/\butm\b|unidad tributaria/, "utm"],
  [/\bipc\b|inflacion/, "ipc"],
  [/\bivp\b/, "ivp"],
  [/\btpm\b|tasa de politica/, "tpm"],
  [/cobre/, "libra_cobre"],
  [/ipsa|bolsa/, "ipsa"],
  [/imacec/, "imacec"],
  [/desempleo|cesantia/, "tasa_desempleo"],
  [/bitcoin/, "bitcoin"],
  [/\byen\b/, "yen"],
];

/** Formato compartido por findic.cl y mindicador.cl: { uf: {codigo, nombre, unidad_medida, fecha, valor}, … }. */
export function parsearIndicadores(json: Record<string, unknown>): Indicador[] {
  const lista: Indicador[] = [];
  for (const valor of Object.values(json)) {
    if (!valor || typeof valor !== "object") continue;
    const v = valor as Record<string, unknown>;
    if (typeof v.codigo !== "string" || typeof v.valor !== "number") continue;
    lista.push({
      codigo: v.codigo,
      nombre: typeof v.nombre === "string" ? v.nombre : v.codigo,
      unidad: typeof v.unidad_medida === "string" ? v.unidad_medida : "",
      fecha: typeof v.fecha === "string" ? v.fecha : null,
      valor: v.valor,
    });
  }
  return lista;
}

function formatearFechaIndicador(fecha: string | null): string {
  if (!fecha) return "";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? new Date(`${fecha}T12:00:00Z`) : new Date(fecha);
  if (isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("es-CL", {
    timeZone: /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? "UTC" : DEFAULT_TIMEZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(d);
}

function formatearValorIndicador(i: Indicador): string {
  const unidad = normalizar(i.unidad);
  if (unidad.startsWith("porcentaje")) {
    return `${i.valor.toLocaleString("es-CL", { maximumFractionDigits: 2 })}%`;
  }
  if (unidad.startsWith("dolar")) {
    return `${i.valor.toLocaleString("es-CL", { maximumFractionDigits: 2 })} dólares`;
  }
  if (unidad.startsWith("pesos")) {
    return `$${i.valor.toLocaleString("es-CL", { minimumFractionDigits: i.valor % 1 ? 2 : 0, maximumFractionDigits: 2 })} pesos chilenos`;
  }
  return `${i.valor.toLocaleString("es-CL", { maximumFractionDigits: 2 })} ${i.unidad}`.trim();
}

/** Elige los indicadores pedidos ("uf", "dólar"…) o los principales si no se especifica. */
export function seleccionarIndicadores(lista: Indicador[], filtro: string | null): Indicador[] {
  const texto = normalizar(filtro ?? "");
  const pedidos = SINONIMOS_INDICADOR.filter(([re]) => re.test(texto)).map(([, codigo]) => codigo);
  const codigos = pedidos.length > 0 ? pedidos : INDICADORES_PRINCIPALES;
  return codigos.map((c) => lista.find((i) => i.codigo === c)).filter((i): i is Indicador => !!i);
}

export function formatearIndicadores(lista: Indicador[], fuente: string): string {
  if (lista.length === 0) return "No se encontró ese indicador económico.";
  return `Indicadores económicos de Chile (fuente ${fuente}): ` +
    lista.map((i) => {
      const fecha = formatearFechaIndicador(i.fecha);
      return `${i.nombre}: ${formatearValorIndicador(i)}${fecha ? ` (al ${fecha})` : ""}.`;
    }).join(" ");
}

export async function consultarIndicadores(filtro: string | null, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS): Promise<string> {
  let datos = INDICADORES_CACHE.get("todos");
  if (!datos) {
    const fuentes: Array<[string, string]> = [
      ["findic.cl", "https://findic.cl/api/"],
      ["mindicador.cl", "https://mindicador.cl/api"],
    ];
    // Ambas EN PARALELO; gana la primera que responda con datos (no se espera a la lenta).
    try {
      datos = await Promise.any(
        fuentes.map(async ([fuente, url]) => {
          const lista = parsearIndicadores(await (await fetchConTimeout(url, timeoutMs)).json());
          if (lista.length === 0) throw new ToolError(`${fuente} sin indicadores`);
          return { lista, fuente };
        }),
      );
    } catch {
      throw new ToolError("Ninguna fuente de indicadores respondió");
    }
    INDICADORES_CACHE.set("todos", datos);
  }
  return formatearIndicadores(seleccionarIndicadores(datos.lista, filtro), datos.fuente);
}

/* ============================================================================
   5. CALENDARIO (SANTORAL, CELEBRACIONES, FERIADOS, FASE LUNAR)
   ============================================================================ */

const MESES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

interface FechaSimple {
  y: number;
  m: number; // 1-12
  d: number;
}

function fechaLocal(timezone: string, now: Date): FechaSimple {
  let tz = timezone;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    tz = DEFAULT_TIMEZONE;
  }
  const partes = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now);
  const get = (t: string) => parseInt(partes.find((p) => p.type === t)?.value ?? "0", 10);
  return { y: get("year"), m: get("month"), d: get("day") };
}

function sumarDias(f: FechaSimple, dias: number): FechaSimple {
  const d = new Date(Date.UTC(f.y, f.m - 1, f.d + dias, 12));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

const isoFecha = (f: FechaSimple) =>
  `${f.y}-${String(f.m).padStart(2, "0")}-${String(f.d).padStart(2, "0")}`;

/** Interpreta "hoy", "mañana", "pasado mañana", "ayer", "AAAA-MM-DD" o "30 de noviembre [de 2026]". */
export function resolverFecha(param: string | null, timezone: string, now: Date = new Date()): FechaSimple {
  const hoy = fechaLocal(timezone, now);
  const p = normalizar(param ?? "");
  if (!p || p.includes("hoy")) return hoy;
  if (p.includes("pasado manana")) return sumarDias(hoy, 2);
  if (p.includes("manana")) return sumarDias(hoy, 1);
  if (p.includes("ayer")) return sumarDias(hoy, -1);
  const iso = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(p);
  if (iso) return { y: +iso[1], m: +iso[2], d: +iso[3] };
  const texto = /(\d{1,2})\s+de\s+([a-z]+)(?:\s+(?:de|del)\s+(\d{4}))?/.exec(p);
  if (texto) {
    const mes = MESES.indexOf(texto[2]);
    if (mes >= 0) {
      let y = texto[3] ? +texto[3] : hoy.y;
      // Sin año y ya pasó este año → el próximo.
      if (!texto[3] && (mes + 1 < hoy.m || (mes + 1 === hoy.m && +texto[1] < hoy.d))) y += 1;
      return { y, m: mes + 1, d: +texto[1] };
    }
  }
  return hoy;
}

const MES_SINODICO = 29.530588853;
const LUNA_NUEVA_REF_MS = Date.UTC(2000, 0, 6, 18, 14); // luna nueva de referencia (6-ene-2000 18:14 UTC)

/** Fase lunar aproximada (±0,5 día) a partir del ciclo sinódico medio. */
export function calcularFaseLunar(fecha: Date): { nombre: string; iluminacion: number; edadDias: number } {
  const dias = (fecha.getTime() - LUNA_NUEVA_REF_MS) / 86_400_000;
  const edad = ((dias % MES_SINODICO) + MES_SINODICO) % MES_SINODICO;
  const iluminacion = Math.round(((1 - Math.cos((2 * Math.PI * edad) / MES_SINODICO)) / 2) * 100);
  const fases: Array<[number, string]> = [
    [1.85, "luna nueva"],
    [5.54, "luna creciente"],
    [9.23, "cuarto creciente"],
    [12.92, "gibosa creciente"],
    [16.61, "luna llena"],
    [20.3, "gibosa menguante"],
    [23.99, "cuarto menguante"],
    [27.68, "luna menguante"],
    [MES_SINODICO + 1, "luna nueva"],
  ];
  const nombre = fases.find(([limite]) => edad < limite)![1];
  return { nombre, iluminacion, edadDias: Math.round(edad * 10) / 10 };
}

/** Extrae una sección "== Título ==" del texto plano de un artículo de Wikipedia. */
export function extraerSeccionWikipedia(texto: string, titulo: string): string | null {
  const encabezados = [...texto.matchAll(/^=+\s*([^=\n]+?)\s*=+\s*$/gm)];
  const idx = encabezados.findIndex((m) => normalizar(m[1]).startsWith(normalizar(titulo)));
  if (idx < 0) return null;
  const inicio = encabezados[idx].index! + encabezados[idx][0].length;
  const fin = encabezados[idx + 1]?.index ?? texto.length;
  return texto.slice(inicio, fin).trim();
}

/** Nombres del santoral del día ("San Josafat Kuncewicz.Monje…" → "San Josafat Kuncewicz"). */
export function extraerSantoral(texto: string, max = 6): string[] {
  const seccion = extraerSeccionWikipedia(texto, "Santoral");
  if (!seccion) return [];
  return seccion.split("\n")
    .map((l) => l.replace(/[​‌‍﻿]/g, "").trim())
    .filter((l) => l.length > 2)
    .map((l) => l.split(/[.:;(]/)[0].trim())
    .filter((n) => n.length > 2 && n.length < 80)
    .slice(0, max);
}

/** Celebraciones mundiales del día (antes de "Por países") + las de Chile si aparecen. */
export function extraerCelebraciones(texto: string, max = 3): string[] {
  const seccion = extraerSeccionWikipedia(texto, "Celebraciones");
  if (!seccion) return [];
  const lineas = seccion.split("\n").map((l) => l.replace(/[​‌‍﻿]/g, "").trim()).filter(Boolean);
  const corte = lineas.findIndex((l) => normalizar(l).startsWith("por paises"));
  const mundiales = (corte >= 0 ? lineas.slice(0, corte) : lineas)
    .map((l) => l.split(/\.(?=\S)|\.\s/)[0].replace(/[.;:\s]+$/, "").trim())
    .filter((l) => l.length > 3 && l.length < 120);
  const chile = lineas.filter((l) => /^chile\b/i.test(l)).map((l) => recortar(l.replace(/^Chile\s+Chile:?/i, "Chile:"), 140));
  return [...chile, ...mundiales].slice(0, max);
}

interface Feriado {
  fecha: string; // AAAA-MM-DD
  nombre: string;
}

// Respaldo si api.boostr.cl no responde (feriados legales 2026 + fijos de 2027).
const FERIADOS_RESPALDO: Feriado[] = [
  ["2026-01-01", "Año Nuevo"], ["2026-04-03", "Viernes Santo"], ["2026-04-04", "Sábado Santo"],
  ["2026-05-01", "Día Nacional del Trabajo"], ["2026-05-21", "Día de las Glorias Navales"],
  ["2026-06-21", "Día Nacional de los Pueblos Indígenas"], ["2026-06-29", "San Pedro y San Pablo"],
  ["2026-07-16", "Día de la Virgen del Carmen"], ["2026-08-15", "Asunción de la Virgen"],
  ["2026-09-18", "Independencia Nacional"], ["2026-09-19", "Día de las Glorias del Ejército"],
  ["2026-10-12", "Encuentro de Dos Mundos"], ["2026-10-31", "Día de las Iglesias Evangélicas y Protestantes"],
  ["2026-11-01", "Día de Todos los Santos"], ["2026-12-08", "Inmaculada Concepción"], ["2026-12-25", "Navidad"],
  ["2027-01-01", "Año Nuevo"], ["2027-05-01", "Día Nacional del Trabajo"], ["2027-05-21", "Día de las Glorias Navales"],
  ["2027-09-18", "Independencia Nacional"], ["2027-09-19", "Día de las Glorias del Ejército"],
  ["2027-12-25", "Navidad"],
].map(([fecha, nombre]) => ({ fecha, nombre }));

const FERIADOS_CACHE = new TtlCache<Feriado[]>(12 * 60 * 60 * 1000, 4);
const DIA_WIKI_CACHE = new TtlCache<string>(12 * 60 * 60 * 1000, 20);

async function obtenerFeriados(anio: number, timeoutMs: number): Promise<Feriado[]> {
  const key = String(anio);
  const cached = FERIADOS_CACHE.get(key);
  if (cached) return cached;
  const res = await fetchConTimeout(`https://api.boostr.cl/holidays/${anio}.json`, timeoutMs);
  const json = await res.json() as { data?: Array<{ date?: string; title?: string }> };
  const lista = (json.data ?? [])
    .filter((h) => h.date && h.title)
    .map((h) => ({ fecha: h.date as string, nombre: h.title as string }));
  if (lista.length === 0) throw new ToolError("boostr sin feriados");
  FERIADOS_CACHE.set(key, lista);
  return lista;
}

export function proximosFeriados(feriados: Feriado[], desde: FechaSimple, max = 3): Array<Feriado & { faltan: number }> {
  const base = Date.UTC(desde.y, desde.m - 1, desde.d);
  return feriados
    .filter((f) => f.fecha >= isoFecha(desde))
    .sort((a, b) => a.fecha.localeCompare(b.fecha))
    .slice(0, max)
    .map((f) => {
      const [y, m, d] = f.fecha.split("-").map(Number);
      return { ...f, faltan: Math.round((Date.UTC(y, m - 1, d) - base) / 86_400_000) };
    });
}

function describirFecha(f: FechaSimple): string {
  return new Intl.DateTimeFormat("es-CL", {
    timeZone: "UTC",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(Date.UTC(f.y, f.m - 1, f.d, 12)));
}

export async function consultarCalendario(
  param: string | null,
  timezone: string = DEFAULT_TIMEZONE,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  now: Date = new Date(),
): Promise<string> {
  const fecha = resolverFecha(param, timezone, now);
  const tituloDia = `${fecha.d} de ${MESES[fecha.m - 1]}`;

  const textoDia = (async () => {
    const cached = DIA_WIKI_CACHE.get(tituloDia);
    if (cached) return cached;
    const params = new URLSearchParams({
      action: "query",
      titles: tituloDia,
      prop: "extracts",
      explaintext: "1",
      format: "json",
      formatversion: "2",
    });
    const res = await fetchConTimeout(`https://es.wikipedia.org/w/api.php?${params.toString()}`, timeoutMs);
    const json = await res.json() as { query?: { pages?: Array<{ extract?: string }> } };
    const extracto = json.query?.pages?.[0]?.extract ?? "";
    if (extracto) DIA_WIKI_CACHE.set(tituloDia, extracto);
    return extracto;
  })();

  const feriados = (async () => {
    const anios = [fecha.y, fecha.y + 1];
    const res = await Promise.allSettled(anios.map((a) => obtenerFeriados(a, timeoutMs)));
    const lista = res.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    return lista.length > 0 ? lista : FERIADOS_RESPALDO;
  })();

  const [rDia, rFeriados] = await Promise.allSettled([textoDia, feriados]);
  const partes: string[] = [`Calendario del ${describirFecha(fecha)}.`];

  if (rDia.status === "fulfilled" && rDia.value) {
    const santos = extraerSantoral(rDia.value);
    if (santos.length > 0) partes.push(`Santoral católico: ${santos.join(", ")}.`);
    const celebraciones = extraerCelebraciones(rDia.value);
    if (celebraciones.length > 0) partes.push(`Celebraciones: ${celebraciones.join("; ")}.`);
  } else {
    partes.push("Santoral no disponible en este momento.");
  }

  const luna = calcularFaseLunar(new Date(Date.UTC(fecha.y, fecha.m - 1, fecha.d, 15)));
  partes.push(`Fase lunar: ${luna.nombre} (iluminación aproximada ${luna.iluminacion}%).`);

  const listaFeriados = rFeriados.status === "fulfilled" ? rFeriados.value : FERIADOS_RESPALDO;
  const proximos = proximosFeriados(listaFeriados, fecha, 3);
  if (proximos.length > 0) {
    partes.push(
      "Próximos feriados en Chile: " +
        proximos.map((f) => {
          const [y, m, d] = f.fecha.split("-").map(Number);
          const cuando = f.faltan === 0 ? "es hoy" : `faltan ${f.faltan} días`;
          return `${describirFecha({ y, m, d })}, ${f.nombre} (${cuando})`;
        }).join("; ") + ".",
    );
  }
  return partes.join(" ");
}

/* ============================================================================
   6. BÚSQUEDA WEB (TAVILY ∥ RESPALDO SIN KEY)
   ============================================================================ */

const WEB_CACHE = new TtlCache<string>(10 * 60 * 1000, 60);
const MAX_WEB_CHARS = 1200;

interface TavilyRespuesta {
  answer?: string;
  results?: Array<{ title?: string; content?: string; url?: string }>;
}

export function formatearTavily(json: TavilyRespuesta, consulta: string): string | null {
  const partes: string[] = [];
  if (json.answer?.trim()) partes.push(`Respuesta resumida: ${recortar(json.answer, 400)}`);
  const resultados = (json.results ?? []).filter((r) => r.content?.trim()).slice(0, 3);
  resultados.forEach((r, i) => {
    let host = "";
    try {
      host = r.url ? new URL(r.url).hostname.replace(/^www\./, "") : "";
    } catch { /* url inválida */ }
    partes.push(`${i + 1}) ${r.title ?? ""}${host ? ` (${host})` : ""}: ${recortar(r.content ?? "", 260)}`);
  });
  if (partes.length === 0) return null;
  return recortar(`Resultados web para "${consulta}": ${partes.join(" ")}`, MAX_WEB_CHARS);
}

async function buscarTavily(consulta: string, timeoutMs: number): Promise<string | null> {
  const apiKey = Deno.env.get("TAVILY_API_KEY")?.trim();
  if (!apiKey) return null;
  const res = await fetchConTimeout("https://api.tavily.com/search", timeoutMs, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: consulta,
      search_depth: Deno.env.get("TAVILY_SEARCH_DEPTH") ?? "basic",
      max_results: 4,
      include_answer: "basic",
      topic: "general",
      country: "chile",
    }),
  });
  return formatearTavily(await res.json() as TavilyRespuesta, consulta);
}

/** Respaldo sin key: Bing News + Bing web (filtrado por relevancia) + snippets de Wikipedia. */
export interface OpcionesBusquedaWeb {
  /** Texto contra el que se mide la relevancia del respaldo sin key (por defecto, la consulta). */
  relevancia?: string;
  /**
   * Omite los fragmentos de Wikipedia del respaldo: cuando ya se tiene el artículo completo, esos
   * fragmentos empiezan a mitad de frase y pierden el sujeto ("…comuna de X. Su población es 858"
   * era de una aldea), lo que lleva a atribuir datos al lugar equivocado.
   */
  sinWikipedia?: boolean;
}

async function buscarSinKey(consulta: string, timeoutMs: number, opciones: OpcionesBusquedaWeb = {}): Promise<string | null> {
  const relevancia = opciones.relevancia ?? consulta;
  const wikipedia = opciones.sinWikipedia ? Promise.resolve([] as ItemRss[]) : (async (): Promise<ItemRss[]> => {
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: consulta,
      srlimit: "2",
      format: "json",
      formatversion: "2",
    });
    const res = await fetchConTimeout(`https://es.wikipedia.org/w/api.php?${params.toString()}`, timeoutMs);
    const json = await res.json() as { query?: { search?: Array<{ title: string; snippet: string }> } };
    return (json.query?.search ?? []).map((s) => ({
      titulo: s.title,
      descripcion: limpiarHtml(s.snippet),
      fuente: "Wikipedia",
    }));
  })();

  const [rNews, rWeb, rWiki] = await Promise.allSettled([
    leerRss(urlBingNews(consulta), timeoutMs, 5, true),
    leerRss(urlBingWeb(consulta), timeoutMs, 8, true),
    wikipedia,
  ]);
  const valor = (r: PromiseSettledResult<ItemRss[]>) => (r.status === "fulfilled" ? r.value : []);
  const relevantes = [...valor(rNews), ...valor(rWeb), ...valor(rWiki)]
    .filter((i) => i.descripcion && esRelevante(`${i.titulo} ${i.descripcion}`, relevancia));
  const items = combinarNoticias([relevantes], 5);
  if (items.length === 0) return null;
  return recortar(
    `Resultados web para "${consulta}": ` +
      items.map((i, n) => `${n + 1}) ${i.titulo}${i.fuente ? ` (${i.fuente})` : ""}: ${recortar(i.descripcion ?? "", 220)}`)
        .join(" "),
    MAX_WEB_CHARS,
  );
}

/** Aviso para la 2ª pasada cuando Tavily no respondió y solo hay titulares/fragmentos sueltos. */
export const AVISO_FUENTE_SECUNDARIA =
  "FUENTE SECUNDARIA (titulares y fragmentos sueltos, pueden ser de fechas anteriores: no afirmes que algo es próximo, actual o futuro si la fecha no lo confirma).";

export async function buscarWeb(consulta: string, timeoutMs = DEFAULT_WEB_TIMEOUT_MS): Promise<string> {
  const q = consulta.replace(/[¿?¡!]/g, "").trim();
  if (!q) throw new ToolError("BUSQUEDA_WEB requiere una consulta");
  return (await buscarWebDetalle(q, timeoutMs)) ?? `No se encontraron resultados web confiables para "${q}".`;
}

/** Igual que buscarWeb, pero devuelve null si no hubo resultados (para combinar con otras fuentes). */
export async function buscarWebDetalle(
  consulta: string,
  timeoutMs = DEFAULT_WEB_TIMEOUT_MS,
  opciones: OpcionesBusquedaWeb = {},
): Promise<string | null> {
  const q = consulta.replace(/[¿?¡!]/g, "").trim();
  if (!q) return null;
  const key = claveCache(q);
  const cached = WEB_CACHE.get(key);
  if (cached) return cached;

  // Tavily y el respaldo corren EN PARALELO: si Tavily falla o se agota la cuota, no se pierde tiempo.
  const tavily = buscarTavily(q, timeoutMs).catch((err) => {
    console.warn(`[TOOL BUSQUEDA_WEB] Tavily falló: ${err instanceof Error ? err.message : err}`);
    return null;
  });
  const respaldo = buscarSinKey(q, timeoutMs, opciones).catch((err) => {
    console.warn(`[TOOL BUSQUEDA_WEB] Respaldo falló: ${err instanceof Error ? err.message : err}`);
    return null;
  });

  const deTavily = await tavily;
  if (deTavily) {
    WEB_CACHE.set(key, deTavily);
    return deTavily;
  }
  const deRespaldo = await respaldo;
  if (!deRespaldo) return null;
  // El respaldo no se guarda en caché: la próxima vez Tavily puede responder mejor.
  return `${AVISO_FUENTE_SECUNDARIA} ${deRespaldo}`;
}

/* ============================================================================
   7. DESPACHADOR
   ============================================================================ */

function leerMsEnv(nombre: string, porDefecto: number): number {
  const v = parseInt(Deno.env.get(nombre) ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : porDefecto;
}

/**
 * ENCICLOPEDIA con complemento web:
 * - Si la pregunta pide un dato concreto (habitantes, dirección, horario…), Wikipedia y la web
 *   corren EN PARALELO y se entregan ambas (sin sumar latencia).
 * - Si Wikipedia no encontró nada y queda tiempo, CASCADA a la búsqueda web con el mismo tema.
 */
async function enciclopediaConComplemento(
  tema: string,
  pregunta: string | undefined,
  restante: () => number,
  topeBase: number,
  topeWeb: number,
): Promise<string> {
  const dato = pregunta ? terminosDatoConcreto(pregunta) : null;
  const wikiP = consultarEnciclopediaDetalle(tema, Math.min(topeBase, restante())).catch((err) => {
    console.warn(`[TOOL ENCICLOPEDIA] Wikipedia falló: ${err instanceof Error ? err.message : err}`);
    return null;
  });
  const webP = dato
    ? buscarWebDetalle(`${tema} ${dato}`, Math.min(topeWeb, restante()), { relevancia: tema, sinWikipedia: true })
      .catch(() => null)
    : null;

  const wiki = await wikiP;
  let web = webP ? await webP : null;

  if (!wiki?.encontrado && !webP && restante() >= 800) {
    console.log(`[TOOL ENCICLOPEDIA] Sin artículo para "${tema}" → cascada a BUSQUEDA_WEB`);
    web = await buscarWebDetalle(tema, Math.min(topeWeb, restante())).catch(() => null);
  }

  const partes: string[] = [];
  if (wiki?.encontrado) partes.push(web ? recortar(wiki.texto, 700) : wiki.texto);
  if (web) partes.push(web);
  if (partes.length > 0) return partes.join(" ");
  if (wiki) return wiki.texto; // "No se encontró información…" (respuesta honesta, no error)
  throw new ToolError(`Ninguna fuente respondió para "${tema}"`);
}

/**
 * @param timeoutMs  presupuesto TOTAL del paso de herramienta (lo calcula llmService según el
 *                   tiempo que queda); cada fuente usa además su propio tope.
 * @param pregunta   transcripción original: permite detectar si se pide un dato concreto.
 */
export async function ejecutarHerramienta(
  herramienta: Herramienta,
  parametro: string | null,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  timezone: string = DEFAULT_TIMEZONE,
  pregunta?: string,
): Promise<string> {
  const inicio = performance.now();
  const limite = inicio + timeoutMs;
  const restante = () => Math.max(0, limite - performance.now());
  const topeBase = Math.min(leerMsEnv("TOOL_TIMEOUT_MS", DEFAULT_TOOL_TIMEOUT_MS), timeoutMs);
  const topeWeb = Math.min(leerMsEnv("TOOL_WEB_TIMEOUT_MS", DEFAULT_WEB_TIMEOUT_MS), timeoutMs);

  let resultado: string;
  switch (herramienta) {
    case "CLIMA":
      if (!parametro?.trim()) throw new ToolError("CLIMA requiere un lugar");
      resultado = await consultarClima(parametro, topeBase);
      break;
    case "NOTICIAS":
      resultado = await consultarNoticias(parametro, topeBase);
      break;
    case "ENCICLOPEDIA":
      if (!parametro?.trim()) throw new ToolError("ENCICLOPEDIA requiere un tema");
      resultado = await enciclopediaConComplemento(parametro, pregunta, restante, topeBase, topeWeb);
      break;
    case "INDICADORES":
      resultado = await consultarIndicadores(parametro, topeBase);
      break;
    case "CALENDARIO":
      resultado = await consultarCalendario(parametro, timezone, topeBase);
      break;
    case "BUSQUEDA_WEB":
      if (!parametro?.trim()) throw new ToolError("BUSQUEDA_WEB requiere una consulta");
      resultado = await buscarWeb(parametro, topeWeb);
      break;
    default:
      throw new ToolError(`Herramienta no soportada: ${herramienta}`);
  }
  console.log(
    `[TOOL] ${herramienta}("${parametro ?? ""}") OK en ${Math.round(performance.now() - inicio)}ms | ${resultado.length} chars`,
  );
  return resultado;
}
