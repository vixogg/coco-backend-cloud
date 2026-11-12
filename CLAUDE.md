@CONTEXTO_GENERAL_COCO.md @AGENTS.md

## Reglas de trabajo

- Responde en español.
- Antes de editar código o BD, muestra un plan y espera mi aprobación.
- Cambios de BD: primero como archivo en supabase/migrations/, nunca ejecutar
  DDL directo sin que yo lo apruebe.
- No cambiar las firmas públicas de los servicios de IA ni los contratos JSON
  (ver sección 10 del contexto).
- Al terminar, actualiza AGENTS.md (Log de Iteraciones).
- Si tocas ttsService.ts o performanceUtils.ts, replica el cambio en ambas
  funciones.
- Avisame cuando los cambios salgan del rol de backend y vayan en relación a
  otros roles.
