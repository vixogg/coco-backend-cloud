-- ============================================================================
-- ÍNDICES DE RENDIMIENTO NO INVASIVOS PARA EL BACKEND DE COCO (SUPABASE POSTGRESQL)
-- ============================================================================
-- Nota: Este script es 100% aditivo (solo CREATE INDEX IF NOT EXISTS).
-- Las Edge Functions (orquestador_iot y app_mensajeria) funcionan de forma
-- autónoma y no dependen de RPCs nuevas, pero aplicar estos índices en el
-- SQL Editor de Supabase acelera las lecturas de dispositivos, red_apoyo e historial.

-- 1. Índice de cobertura para validación instantánea (Index-Only Scan) por mac_address
CREATE UNIQUE INDEX IF NOT EXISTS idx_dispositivos_coco_mac_covering
    ON public.dispositivos_coco (mac_address)
    INCLUDE (id, adulto_mayor_id);

-- 2. Índice parcial de cobertura para búsqueda de emisor en app_mensajeria
CREATE INDEX IF NOT EXISTS idx_red_apoyo_mensajeria_covering
    ON public.red_apoyo (dispositivo_id, usuario_app_id)
    INCLUDE (rol, apodos_reconocimiento)
    WHERE activo = true;

-- 3. Índice parcial de cobertura para resolución de contactos activos en orquestador_iot
CREATE INDEX IF NOT EXISTS idx_red_apoyo_dispositivo_activo
    ON public.red_apoyo (dispositivo_id)
    INCLUDE (usuario_app_id, rol, apodos_reconocimiento)
    WHERE activo = true;

-- 4. Índice GIN parcial sobre el array de apodos_reconocimiento
CREATE INDEX IF NOT EXISTS idx_red_apoyo_apodos_gin
    ON public.red_apoyo USING GIN (apodos_reconocimiento)
    WHERE activo = true;

-- 5. Índices para consultas cronológicas rápidas sobre historial_interacciones
CREATE INDEX IF NOT EXISTS idx_historial_dispositivo_created
    ON public.historial_interacciones (dispositivo_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_historial_destinatario_created
    ON public.historial_interacciones (destinatario_id, created_at DESC)
    WHERE destinatario_id IS NOT NULL;

