/**
 * Contexto conversacional del asistente COCO (Iteración 10).
 *
 * - Gemelo digital enriquecido: dispositivo + adulto mayor + red de apoyo en UNA consulta
 *   embebida, cacheada en la RAM del isolate (TTL 5 min). Reemplaza la caché simple de
 *   performanceUtils para este flujo y elimina la consulta a red_apoyo por petición.
 * - Fecha/hora local exacta con Intl (0 ms, sin red).
 * - Memoria corta: últimos turnos del historial (10 min), pensada para ejecutarse en
 *   paralelo con Deepgram y con timeout propio.
 * - Pistas (keywords) para Deepgram: "coco" + nombres/apodos reales de la red.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js";
import type {
  ContactoRed,
  ContextoConversacional,
  TurnoReciente,
} from "../types.ts";
import { normalizeSpanishText } from "./performanceUtils.ts";

export interface DeviceContext {
  id: string;
  adulto_mayor_id: string | null;
  timezone: string;
  nombre_adulto: string | null;
  fecha_nacimiento: string | null;
  red_apoyo: ContactoRed[];
}

const DEFAULT_TIMEZONE = "America/Santiago";
const DEVICE_CONTEXT_TTL_MS = 5 * 60 * 1000;
const DEVICE_CONTEXT_CACHE = new Map<string, { ctx: DeviceContext; expiresAt: number }>();

/* ============================================================================
   1. GEMELO DIGITAL ENRIQUECIDO (CACHÉ RAM)
   ============================================================================ */

type Embedded<T> = T | T[] | null | undefined;

function firstOf<T>(value: Embedded<T>): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

interface DeviceRow {
  id: string;
  adulto_mayor_id: string | null;
  timezone: string | null;
  adultos_mayores?: Embedded<{ nombre: string | null; fecha_nacimiento: string | null }>;
  red_apoyo?: Array<{
    usuario_app_id: string | null;
    rol: string | null;
    apodos_reconocimiento: string[] | null;
    activo: boolean | null;
    usuarios_app?: Embedded<{ nombre: string | null }>;
  }> | null;
}

export function mapDeviceRow(row: DeviceRow): DeviceContext {
  const adulto = firstOf(row.adultos_mayores);
  const red: ContactoRed[] = (row.red_apoyo ?? [])
    .filter((r) => r.activo !== false && !!r.usuario_app_id)
    .map((r) => ({
      usuario_app_id: r.usuario_app_id as string,
      nombre: firstOf(r.usuarios_app)?.nombre ?? null,
      rol: r.rol,
      apodos_reconocimiento: r.apodos_reconocimiento ?? [],
    }));

  return {
    id: row.id,
    adulto_mayor_id: row.adulto_mayor_id,
    timezone: row.timezone || DEFAULT_TIMEZONE,
    nombre_adulto: adulto?.nombre ?? null,
    fecha_nacimiento: adulto?.fecha_nacimiento ?? null,
    red_apoyo: red,
  };
}

/**
 * Devuelve el contexto del dispositivo (o null si la MAC no está registrada).
 * Si la consulta embebida falla por un motivo distinto a "no existe", degrada a la
 * consulta mínima para no bloquear al dispositivo (el asistente funciona sin red/nombre).
 */
export async function getDeviceContext(
  supabase: SupabaseClient,
  macAddress: string,
): Promise<DeviceContext | null> {
  const cached = DEVICE_CONTEXT_CACHE.get(macAddress);
  if (cached && cached.expiresAt > Date.now()) {
    console.log(`[DEVICE CACHE HIT] Contexto de ${macAddress} desde RAM (0ms).`);
    return cached.ctx;
  }

  const { data, error } = await supabase
    .from("dispositivos_coco")
    .select(
      "id, adulto_mayor_id, timezone, adultos_mayores(nombre, fecha_nacimiento), red_apoyo(usuario_app_id, rol, apodos_reconocimiento, activo, usuarios_app(nombre))",
    )
    .eq("mac_address", macAddress)
    .maybeSingle();

  let ctx: DeviceContext | null = null;

  if (error) {
    console.warn(
      `[CONTEXTO WARN] Consulta embebida falló (${error.message}). Degradando a consulta mínima.`,
    );
    const { data: minimo, error: errMin } = await supabase
      .from("dispositivos_coco")
      .select("id, adulto_mayor_id, timezone")
      .eq("mac_address", macAddress)
      .maybeSingle();
    if (errMin || !minimo) return null;
    ctx = mapDeviceRow(minimo as DeviceRow);
  } else if (data) {
    ctx = mapDeviceRow(data as unknown as DeviceRow);
  }

  if (!ctx) return null;

  DEVICE_CONTEXT_CACHE.set(macAddress, { ctx, expiresAt: Date.now() + DEVICE_CONTEXT_TTL_MS });
  console.log(
    `[CONTEXTO] ${macAddress} → adulto="${ctx.nombre_adulto ?? "?"}" | red=${ctx.red_apoyo.length} contacto(s) | tz=${ctx.timezone}`,
  );
  return ctx;
}

/* ============================================================================
   2. FECHA / HORA / EDAD (Intl NATIVO, ZONA HORARIA DEL ABUELO)
   ============================================================================ */

export function buildFechaHoraLocal(timezone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("es-CL", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat("es-CL", {
      timeZone: DEFAULT_TIMEZONE,
      dateStyle: "full",
      timeStyle: "short",
    }).format(now);
  }
}

function fechaLocalPartes(timezone: string, now: Date): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value ?? "0", 10);
  return { y: get("year"), m: get("month"), d: get("day") };
}

export function calcularEdad(
  fechaNacimiento: string | null,
  timezone: string = DEFAULT_TIMEZONE,
  now: Date = new Date(),
): number | null {
  if (!fechaNacimiento) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(fechaNacimiento);
  if (!match) return null;
  const [by, bm, bd] = [Number(match[1]), Number(match[2]), Number(match[3])];
  let hoy: { y: number; m: number; d: number };
  try {
    hoy = fechaLocalPartes(timezone, now);
  } catch {
    hoy = fechaLocalPartes(DEFAULT_TIMEZONE, now);
  }
  let edad = hoy.y - by;
  if (hoy.m < bm || (hoy.m === bm && hoy.d < bd)) edad -= 1;
  return edad >= 0 && edad < 130 ? edad : null;
}

/* ============================================================================
   3. MEMORIA CORTA (ÚLTIMOS TURNOS) — EJECUTAR EN PARALELO CON DEEPGRAM
   ============================================================================ */

const MEMORIA_VENTANA_MIN = 10;
const MEMORIA_MAX_TURNOS = 3;

export async function getRecentTurns(
  supabase: SupabaseClient,
  dispositivoId: string,
  timeoutMs = 800,
): Promise<TurnoReciente[]> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const desde = new Date(Date.now() - MEMORIA_VENTANA_MIN * 60_000).toISOString();

  try {
    const { data, error } = await supabase
      .from("historial_interacciones")
      .select("timestamp, metadata_payload")
      .eq("dispositivo_id", dispositivoId)
      .eq("emisor", "COCO")
      .gte("timestamp", desde)
      .order("timestamp", { ascending: false })
      .limit(MEMORIA_MAX_TURNOS + 2)
      .abortSignal(controller.signal);

    if (error) {
      console.warn(`[MEMORIA WARN] No se pudo leer el historial reciente: ${error.message}`);
      return [];
    }

    const ahora = Date.now();
    const turnos: TurnoReciente[] = [];
    for (const row of (data ?? []) as Array<{ timestamp: string; metadata_payload: Record<string, unknown> | null }>) {
      const meta = row.metadata_payload ?? {};
      if (meta.procesado_por_ia !== true) continue;
      const texto = typeof meta.texto_procesado === "string" ? meta.texto_procesado.trim() : "";
      if (!texto) continue;
      turnos.push({
        hace_minutos: Math.max(0, Math.round((ahora - new Date(row.timestamp).getTime()) / 60_000)),
        texto_usuario: texto,
        respuesta_coco: typeof meta.respuesta_coco === "string" ? meta.respuesta_coco : null,
      });
      if (turnos.length >= MEMORIA_MAX_TURNOS) break;
    }
    return turnos.reverse(); // orden cronológico (más antiguo primero)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[MEMORIA WARN] Lectura de memoria abortada/fallida (${msg}). Se continúa sin memoria.`);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/* ============================================================================
   4. ENSAMBLADO DEL CONTEXTO Y PISTAS PARA DEEPGRAM
   ============================================================================ */

export function buildContextoConversacional(
  device: DeviceContext,
  turnos: TurnoReciente[],
  now: Date = new Date(),
): ContextoConversacional {
  return {
    nombre_adulto: device.nombre_adulto,
    edad_adulto: calcularEdad(device.fecha_nacimiento, device.timezone, now),
    fecha_hora_local: buildFechaHoraLocal(device.timezone, now),
    timezone: device.timezone,
    red_apoyo: device.red_apoyo,
    turnos_recientes: turnos,
  };
}

const PALABRAS_NO_PISTA = new Set([
  "don", "dona", "sra", "sr", "senora", "senor", "de", "del", "la", "el", "los", "las",
  "prueba", "cuidador", "cuidadora", "mi", "tu", "su",
]);

/**
 * Palabras clave para mejorar el reconocimiento de Deepgram: el nombre del asistente
 * ("coco") y los nombres/apodos reales del abuelo y su red. Sin duplicados, máx. 20.
 */
export function buildSttHints(device: DeviceContext | null, maxHints = 20): string[] {
  const hints: string[] = ["coco"];
  const agregar = (raw: string | null | undefined) => {
    if (!raw) return;
    // Se conservan tildes/ñ (Deepgram transcribe en español con tildes); solo se limpian signos.
    const palabras = raw.toLowerCase().replace(/[^a-záéíóúüñ\s]/g, " ").split(/\s+/);
    for (const palabra of palabras) {
      const norm = normalizeSpanishText(palabra);
      if (norm.length < 3 || PALABRAS_NO_PISTA.has(norm)) continue;
      if (!hints.includes(palabra)) hints.push(palabra);
    }
  };

  if (device) {
    agregar(device.nombre_adulto);
    for (const c of device.red_apoyo) {
      agregar(c.nombre);
      for (const apodo of c.apodos_reconocimiento ?? []) agregar(apodo);
    }
  }

  const extra = Deno.env.get("DEEPGRAM_KEYWORDS");
  if (extra) {
    for (const k of extra.split(",")) agregar(k);
  }

  return hints.slice(0, maxHints);
}
