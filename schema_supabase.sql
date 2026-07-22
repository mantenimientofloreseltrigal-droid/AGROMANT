-- ============================================================================
--  AGROMANT — ESQUEMA SUPABASE (POSTGRES)
--  Reemplaza las 8 hojas de Google Sheets por tablas relacionales reales.
--  Ejecutar completo, de una sola vez, en Supabase → SQL Editor → "New query".
-- ============================================================================


-- ============================================================================
-- 1. TABLAS DE REFERENCIA (catálogos base)
-- ============================================================================

-- Reemplaza la constante M2 que hoy vive hardcodeada en app.js
create table sedes (
  id        text primary key,        -- 'OLAS' | 'MANANTIALES' (mismos valores que ya usa tu app)
  nombre    text not null,
  hectareas numeric not null,
  area_m2   numeric not null
);
comment on table sedes is 'Reemplaza la constante M2 de app.js. 2 filas fijas.';

insert into sedes (id, nombre, hectareas, area_m2) values
  ('OLAS',        'Sede Olas',        32.5, 325000),
  ('MANANTIALES', 'Sede Manantiales', 16,   160000);


-- Reemplaza la hoja CATALOGO (antes: CATEGORIA + TIPOS_JSON en una sola celda)
create table categorias (
  id     uuid primary key default gen_random_uuid(),
  nombre text not null unique
);
comment on table categorias is 'Reemplaza la columna CATEGORIA de la hoja CATALOGO.';

create table tipos_actividad (
  id           uuid primary key default gen_random_uuid(),
  categoria_id uuid not null references categorias(id) on delete cascade,
  nombre       text not null,
  unique (categoria_id, nombre)
);
comment on table tipos_actividad is 'Reemplaza el array TIPOS_JSON de la hoja CATALOGO (uno por fila en vez de JSON en una celda).';

-- Nota: las categorías NO se insertan aquí. Las trae datos_agromant.sql con los
-- nombres exactos de tu hoja CATALOGO (p. ej. 'Electricos' sin tilde), para que
-- los costos históricos calcen con su categoría sin partirse en dos.


-- Reemplaza la hoja CENTRO_COSTOS
create table centros_costos (
  id            text primary key,          -- ej. 'OL2517' (mismo código que ya usas)
  sede_id       text not null references sedes(id),
  clasificacion text not null,             -- 'MANTENIMIENTO' | 'PROYECTO DE INVERSION'
  descripcion   text,
  estado        text,
  presupuesto   numeric not null default 0
);
comment on table centros_costos is 'Reemplaza la hoja CENTRO_COSTOS. El id conserva tu código existente (OL2517, etc.).';


-- Reemplaza la hoja EQUIPO
-- Nota: en tu hoja actual el "Código" se repite entre varios equipos físicos
-- (ej. MTAT001 aparece en dos ATADORAs distintas) -> no puede ser llave única,
-- por eso la llave real es un uuid nuevo y el código queda como dato normal.
create table equipos (
  id          uuid primary key default gen_random_uuid(),
  codigo      text,
  descripcion text,
  referencia  text,
  ubicacion   text,
  marca       text,
  sede_id     text references sedes(id)
);
comment on table equipos is 'Reemplaza la hoja EQUIPO. codigo NO es único (así viene tu dato real).';

create index idx_equipos_codigo on equipos (codigo);
create index idx_equipos_sede on equipos (sede_id);


-- ============================================================================
-- 2. ÓRDENES DE TRABAJO / COTIZACIONES  (reemplaza OT_MANTENIMIENTO)
-- ============================================================================

create table ordenes_trabajo (
  id              uuid primary key default gen_random_uuid(),
  ot_id           text not null unique,     -- código humano: 'OT-20260704-1234' o 'COTIZACION N° 0059'
  fecha           date not null,
  empresa         text not null,            -- proveedor
  sede_id         text not null references sedes(id),
  clasificacion   text,
  observaciones   text,
  precio_total    numeric not null default 0,
  centro_costo_id text references centros_costos(id),
  estado          text not null default 'PENDIENTE'
                    check (estado in ('PENDIENTE','EN PROCESO','CERRADO')),
  archivo_pdf_url text,                     -- URL en Supabase Storage (antes: link de Drive)
  creado_en       timestamptz not null default now()
);
comment on table ordenes_trabajo is 'Reemplaza OT_MANTENIMIENTO. ot_id conserva el mismo formato humano que ya generas en app.js.';

create index idx_ot_sede on ordenes_trabajo (sede_id);
create index idx_ot_estado on ordenes_trabajo (estado);
create index idx_ot_cc on ordenes_trabajo (centro_costo_id);

-- Reemplaza la columna ACTAS_JSON (antes un JSON adentro de una celda)
create table ot_actas (
  id              uuid primary key default gen_random_uuid(),
  ot_id           uuid not null references ordenes_trabajo(id) on delete cascade,
  nombre_archivo  text not null,
  url             text not null,            -- URL en Supabase Storage
  subido_en       timestamptz not null default now()
);
comment on table ot_actas is 'Reemplaza ACTAS_JSON: una fila por acta/adjunto en vez de un JSON en una celda.';

create index idx_actas_ot on ot_actas (ot_id);


-- ============================================================================
-- 3. LÍNEAS DE COSTO  (reemplaza COSTOS_MANTENIMIENTO)
-- ============================================================================

create table costos_mantenimiento (
  id              uuid primary key default gen_random_uuid(),
  ot_id           uuid not null references ordenes_trabajo(id) on delete cascade,
  fecha           date not null,
  empresa         text,
  categoria_id    uuid references categorias(id),
  tipo            text,                     -- texto libre (no FK a tipos_actividad, ver nota abajo)
  labor           text,
  descripcion     text,
  ubicacion       text,
  equipo_id       uuid references equipos(id),
  cantidad        numeric not null default 1,
  precio_unitario numeric not null default 0,
  total_linea     numeric generated always as (cantidad * precio_unitario) stored,
  adjunto         text,
  sede_id         text references sedes(id),
  centro_costo_id text references centros_costos(id),
  creado_en       timestamptz not null default now()
);
comment on table costos_mantenimiento is
  'Reemplaza COSTOS_MANTENIMIENTO. total_linea ya no se guarda manual: Postgres lo calcula solo '
  '(cantidad*precio_unitario) y nunca puede desincronizarse. '
  'tipo queda como texto libre (no FK) para no romper si un dato futuro no calza exacto con el catálogo.';

create index idx_costos_ot on costos_mantenimiento (ot_id);
create index idx_costos_sede on costos_mantenimiento (sede_id);
create index idx_costos_categoria on costos_mantenimiento (categoria_id);
create index idx_costos_fecha on costos_mantenimiento (fecha);
create index idx_costos_cc on costos_mantenimiento (centro_costo_id);
create index idx_costos_equipo on costos_mantenimiento (equipo_id);


-- ============================================================================
-- 4. INVERNADEROS  (reemplaza MANTENIMIENTO_INVERNADEROS)
-- ============================================================================

create table invernaderos_bloques (
  id                 uuid primary key default gen_random_uuid(),
  sede_id            text not null references sedes(id),
  ubicacion          text not null,          -- 'BLOQUE 1', etc.
  num_naves          numeric,
  num_medianave      numeric,
  fecha_prog_cambio  date,
  fecha_eje_cambio   date,
  fecha_prog_lavado  date,
  fecha_eje_lavado   date,
  unique (sede_id, ubicacion)
);
comment on table invernaderos_bloques is 'Reemplaza MANTENIMIENTO_INVERNADEROS. La regla "3 lavados = cambio requerido" sigue calculándose en el código (cuenta filas en costos_mantenimiento), no aquí.';


-- ============================================================================
-- 5. ENERGÍA  (reemplaza la hoja ENERGIA que ya armamos)
-- ============================================================================

create table energia (
  id                 uuid primary key default gen_random_uuid(),
  sede_id            text not null references sedes(id),
  anio               int not null,
  mes                int not null check (mes between 1 and 12),
  consumo_kwh        numeric not null default 0,
  generacion_fv_kwh  numeric not null default 0,
  valor_factura      numeric not null default 0,
  observaciones      text,
  creado_en          timestamptz not null default now(),
  unique (sede_id, anio, mes)
);
comment on table energia is
  'Reemplaza la hoja ENERGIA. La unique(sede_id,anio,mes) hace que el "upsert" '
  '(que en Apps Script recorría filas a mano) sea un solo INSERT ... ON CONFLICT.';

create index idx_energia_sede on energia (sede_id);
create index idx_energia_periodo on energia (anio, mes);


-- ============================================================================
-- 6. SEGURIDAD: RLS + GRANTS
--    Nota (julio 2026): en proyectos nuevos de Supabase, una tabla YA NO
--    queda expuesta a la API automáticamente al crearla -> hace falta el
--    GRANT explícito además del RLS. Antes esto era automático; ahora no.
--    Aquí se deja el modelo MÁS SIMPLE posible: igual de abierto que tu app
--    actual (sin login, "quien tenga el link entra"). Si más adelante quieres
--    que solo usuarios autenticados puedan escribir, se ajustan estas
--    políticas — pero eso es un cambio aparte, no hace falta hoy.
-- ============================================================================

alter table sedes                 enable row level security;
alter table categorias            enable row level security;
alter table tipos_actividad       enable row level security;
alter table centros_costos        enable row level security;
alter table equipos               enable row level security;
alter table ordenes_trabajo       enable row level security;
alter table ot_actas              enable row level security;
alter table costos_mantenimiento  enable row level security;
alter table invernaderos_bloques  enable row level security;
alter table energia               enable row level security;

grant select, insert, update, delete on
  sedes, categorias, tipos_actividad, centros_costos, equipos,
  ordenes_trabajo, ot_actas, costos_mantenimiento, invernaderos_bloques, energia
to anon, authenticated;

create policy "acceso_total_sedes"        on sedes                for all to anon, authenticated using (true) with check (true);
create policy "acceso_total_categorias"   on categorias           for all to anon, authenticated using (true) with check (true);
create policy "acceso_total_tipos"        on tipos_actividad      for all to anon, authenticated using (true) with check (true);
create policy "acceso_total_cc"           on centros_costos       for all to anon, authenticated using (true) with check (true);
create policy "acceso_total_equipos"      on equipos              for all to anon, authenticated using (true) with check (true);
create policy "acceso_total_ot"           on ordenes_trabajo      for all to anon, authenticated using (true) with check (true);
create policy "acceso_total_actas"        on ot_actas             for all to anon, authenticated using (true) with check (true);
create policy "acceso_total_costos"       on costos_mantenimiento for all to anon, authenticated using (true) with check (true);
create policy "acceso_total_invernaderos" on invernaderos_bloques for all to anon, authenticated using (true) with check (true);
create policy "acceso_total_energia"      on energia              for all to anon, authenticated using (true) with check (true);


-- ============================================================================
-- 7. STORAGE: bucket para PDFs de cotización y actas (reemplaza Google Drive)
-- ============================================================================

insert into storage.buckets (id, name, public)
values ('ot-adjuntos', 'ot-adjuntos', true)
on conflict (id) do nothing;

create policy "lectura_publica_adjuntos" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'ot-adjuntos');

create policy "subida_adjuntos" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'ot-adjuntos');

create policy "borrado_adjuntos" on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'ot-adjuntos');
