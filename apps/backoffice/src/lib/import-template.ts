// Cabecera de la plantilla de importación (REQUIRED_COLUMNS + OPTIONAL_COLUMNS de la API, Task 7).
export const REQUIRED_COLUMNS = ["codigo", "viajero_nombre", "viajero_telefono", "viajero_email", "destino", "inicio", "fin"] as const;
export const OPTIONAL_COLUMNS = ["traslado_proveedor", "traslado_telefono", "traslado_email", "traslado_inicio", "traslado_lugar", "traslado_referencia"] as const;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const templateCsv = (): string => `${[...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].join(",")}\n`;
