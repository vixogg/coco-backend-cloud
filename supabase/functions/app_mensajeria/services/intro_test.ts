// Ejecutar: deno test --no-check supabase/functions/app_mensajeria/services/intro_test.ts
import {
  construirFraseIntroductoria,
  describirFamiliar,
  detectarParentesco,
  limpiarNombre,
} from "./introService.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`Esperado: ${JSON.stringify(expected)}\nObtenido: ${JSON.stringify(actual)}`);
  }
}

const base = { nombreAbuelo: "Don Carlos", emisorEnRed: true, tipoContenido: "mensaje" as const };

// ---- Casos reales de la BD (2026-11-12) ----

Deno.test("real: jose + ['sobrino'] → tu sobrino Jose (audio)", () => {
  assertEquals(
    construirFraseIntroductoria({ ...base, tipoContenido: "audio", nombreFamiliar: "jose", apodos: ["sobrino"] }),
    "Hola Don Carlos, tu sobrino Jose te envió un audio.",
  );
});

Deno.test("real: 'Martín (Cuidador Prueba)' + ['hijo'] → tu hijo Martín", () => {
  assertEquals(
    construirFraseIntroductoria({ ...base, nombreFamiliar: "Martín (Cuidador Prueba)", apodos: ["hijo"] }),
    "Hola Don Carlos, tu hijo Martín te envió un mensaje.",
  );
});

Deno.test("real: Vicente + ['Nieto','Vicente','Vicho','Familia'] → tu nieto Vicente", () => {
  assertEquals(
    construirFraseIntroductoria({
      ...base,
      nombreAbuelo: "Sra Juanita",
      nombreFamiliar: "Vicente",
      apodos: ["Nieto", "Vicente", "Vicho", "Familia"],
    }),
    "Hola Sra Juanita, tu nieto Vicente te envió un mensaje.",
  );
});

Deno.test("real: Ana + ['Hermana'] → tu hermana Ana", () => {
  assertEquals(
    construirFraseIntroductoria({ ...base, nombreFamiliar: "Ana", apodos: ["Hermana"] }),
    "Hola Don Carlos, tu hermana Ana te envió un mensaje.",
  );
});

Deno.test("real: apodo igual al nombre (Martin + ['martin']) → sin repetir", () => {
  assertEquals(
    construirFraseIntroductoria({ ...base, nombreFamiliar: "Martin", apodos: ["martin"] }),
    "Hola Don Carlos, Martin te envió un mensaje.",
  );
});

Deno.test("real (histórico): apodos vacíos → nombre real, nunca 'ADMINISTRADOR ADMINISTRADOR'", () => {
  assertEquals(
    construirFraseIntroductoria({ ...base, nombreFamiliar: "Vicente", apodos: [] }),
    "Hola Don Carlos, Vicente te envió un mensaje.",
  );
});

Deno.test("real: emisor fuera de red_apoyo → frase genérica", () => {
  assertEquals(
    construirFraseIntroductoria({ ...base, emisorEnRed: false, nombreFamiliar: "Ana", apodos: ["Hermana"] }),
    "Hola Don Carlos, te enviaron un mensaje.",
  );
});

// ---- Casos borde ----

Deno.test("borde: apodo con posesivo 'mi hija' → tu hija María", () => {
  assertEquals(
    construirFraseIntroductoria({ ...base, nombreFamiliar: "María", apodos: ["mi hija"] }),
    "Hola Don Carlos, tu hija María te envió un mensaje.",
  );
});

Deno.test("borde: parentesco sin nombre → tu sobrino", () => {
  assertEquals(
    construirFraseIntroductoria({ ...base, nombreFamiliar: null, apodos: ["Sobrino"] }),
    "Hola Don Carlos, tu sobrino te envió un mensaje.",
  );
});

Deno.test("borde: sin nombre ni parentesco → usa apodo cariñoso", () => {
  assertEquals(
    construirFraseIntroductoria({ ...base, nombreFamiliar: "", apodos: ["Vicho"] }),
    "Hola Don Carlos, Vicho te envió un mensaje.",
  );
});

Deno.test("borde: en red pero sin ningún dato → frase genérica", () => {
  assertEquals(
    construirFraseIntroductoria({ ...base, nombreFamiliar: null, apodos: null }),
    "Hola Don Carlos, te enviaron un mensaje.",
  );
});

Deno.test("borde: nombre igual al parentesco → no repite 'tu hijo Hijo'", () => {
  assertEquals(describirFamiliar("Hijo", ["hijo"]), "tu hijo");
});

Deno.test("borde: tildes en parentesco ('Tía', 'cunado')", () => {
  assertEquals(describirFamiliar("Rosa", ["Tía"]), "tu tía Rosa");
  assertEquals(describirFamiliar("Pedro", ["cunado"]), "tu cuñado Pedro");
});

Deno.test("borde: abuelo sin nombre conserva saludo previo 'Estimado'", () => {
  assertEquals(
    construirFraseIntroductoria({ ...base, nombreAbuelo: null, nombreFamiliar: "Ana", apodos: ["Hermana"] }),
    "Hola Estimado, tu hermana Ana te envió un mensaje.",
  );
});

Deno.test("borde: apodos con basura (vacíos/espacios) se ignoran", () => {
  assertEquals(describirFamiliar("Ana", ["", "  ", "Hermana"]), "tu hermana Ana");
});

Deno.test("helpers: detectarParentesco y limpiarNombre", () => {
  assertEquals(detectarParentesco("Familia"), null);
  assertEquals(detectarParentesco("Vicho"), null);
  assertEquals(detectarParentesco("nieta mayor"), "nieta");
  assertEquals(limpiarNombre("  jose   luis "), "Jose Luis");
  assertEquals(limpiarNombre("María José"), "María José");
  assertEquals(limpiarNombre("(prueba)"), null);
});
