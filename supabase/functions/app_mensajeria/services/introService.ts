/**
 * Construcción de la frase introductoria que COCO dice antes de un mensaje/audio
 * enviado desde la app (Iteración 12).
 *
 * Combina el PARENTESCO (detectado en red_apoyo.apodos_reconocimiento) con el
 * NOMBRE REAL del familiar (usuarios_app.nombre). La columna red_apoyo.rol
 * (ADMINISTRADOR | CONTACTO) es un nivel de permiso y NUNCA se pronuncia.
 *
 * Función pura, sin dependencias de Supabase, para poder testearla aislada.
 */

export type TipoContenidoIntro = "mensaje" | "audio";

export interface DatosIntro {
  /** adultos_mayores.nombre (puede faltar si el dispositivo no tiene dueño). */
  nombreAbuelo: string | null | undefined;
  /** true si el emisor tiene una fila activa en red_apoyo para este dispositivo. */
  emisorEnRed: boolean;
  /** usuarios_app.nombre del emisor. */
  nombreFamiliar?: string | null;
  /** red_apoyo.apodos_reconocimiento del emisor. */
  apodos?: string[] | null;
  tipoContenido: TipoContenidoIntro;
}

/** Saludo que se usaba antes cuando faltaba el nombre del abuelo (se conserva). */
const NOMBRE_ABUELO_FALLBACK = "Estimado";

/**
 * Diccionario cerrado de parentescos/vínculos: clave normalizada (sin tildes,
 * minúscula) → forma para pronunciar.
 */
const PARENTESCOS: Record<string, string> = {
  hijo: "hijo",
  hija: "hija",
  nieto: "nieto",
  nieta: "nieta",
  bisnieto: "bisnieto",
  bisnieta: "bisnieta",
  sobrino: "sobrino",
  sobrina: "sobrina",
  hermano: "hermano",
  hermana: "hermana",
  esposo: "esposo",
  esposa: "esposa",
  marido: "marido",
  pareja: "pareja",
  yerno: "yerno",
  nuera: "nuera",
  cunado: "cuñado",
  cunada: "cuñada",
  primo: "primo",
  prima: "prima",
  tio: "tío",
  tia: "tía",
  padrino: "padrino",
  madrina: "madrina",
  ahijado: "ahijado",
  ahijada: "ahijada",
  amigo: "amigo",
  amiga: "amiga",
  vecino: "vecino",
  vecina: "vecina",
  cuidador: "cuidador",
  cuidadora: "cuidadora",
};

export function normalizarTexto(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Quita posesivos iniciales: "mi hija" → "hija", "mis nietos" → "nietos". */
function quitarPosesivo(valorNormalizado: string): string {
  return valorNormalizado.replace(/^(mi|mis|el|la)\s+/, "");
}

/**
 * Devuelve el parentesco pronunciable si el apodo es (o empieza con) un
 * parentesco conocido. "Nieto" → "nieto"; "mi hija" → "hija"; "Vicho" → null.
 */
export function detectarParentesco(apodo: string): string | null {
  const limpio = quitarPosesivo(normalizarTexto(apodo));
  if (!limpio) return null;
  if (PARENTESCOS[limpio]) return PARENTESCOS[limpio];
  const primeraPalabra = limpio.split(" ")[0];
  return PARENTESCOS[primeraPalabra] ?? null;
}

/**
 * Limpia un nombre para TTS: quita lo que va entre paréntesis/corchetes
 * ("Martín (Cuidador Prueba)" → "Martín"), colapsa espacios y capitaliza las
 * palabras escritas enteras en minúscula ("jose" → "Jose").
 */
export function limpiarNombre(nombre: string | null | undefined): string | null {
  if (!nombre) return null;
  const sinParentesis = nombre
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[()[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!sinParentesis) return null;
  return sinParentesis
    .split(" ")
    .map((palabra) =>
      palabra === palabra.toLowerCase()
        ? palabra.charAt(0).toUpperCase() + palabra.slice(1)
        : palabra
    )
    .join(" ");
}

/**
 * Resuelve cómo nombrar al familiar: "tu sobrino Jose", "tu hija", "Martin"…
 * Devuelve null si no hay ningún dato utilizable.
 */
export function describirFamiliar(
  nombreFamiliar: string | null | undefined,
  apodos: string[] | null | undefined,
): string | null {
  const listaApodos = (apodos ?? []).filter(
    (a): a is string => typeof a === "string" && a.trim().length > 0,
  );

  let parentesco: string | null = null;
  for (const apodo of listaApodos) {
    parentesco = detectarParentesco(apodo);
    if (parentesco) break;
  }

  let nombre = limpiarNombre(nombreFamiliar);
  if (!nombre) {
    // Sin nombre real: usar el primer apodo que NO sea parentesco (p. ej. "Vicho").
    const apodoNombre = listaApodos.find((a) => !detectarParentesco(a));
    nombre = limpiarNombre(apodoNombre);
  }

  // Evita "tu hijo Hijo" si alguien quedó registrado con el parentesco como nombre.
  if (nombre && parentesco && normalizarTexto(nombre) === normalizarTexto(parentesco)) {
    nombre = null;
  }

  if (parentesco && nombre) return `tu ${parentesco} ${nombre}`;
  if (parentesco) return `tu ${parentesco}`;
  if (nombre) return nombre;
  return null;
}

export function construirFraseIntroductoria(datos: DatosIntro): string {
  const nombreAbuelo = datos.nombreAbuelo?.trim() || NOMBRE_ABUELO_FALLBACK;
  const familiar = datos.emisorEnRed
    ? describirFamiliar(datos.nombreFamiliar, datos.apodos)
    : null;

  if (familiar) {
    return `Hola ${nombreAbuelo}, ${familiar} te envió un ${datos.tipoContenido}.`;
  }
  return `Hola ${nombreAbuelo}, te enviaron un ${datos.tipoContenido}.`;
}
