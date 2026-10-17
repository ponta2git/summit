/** CLI entry points must reject unknown modes and may only read during frozen maintenance. */
export const allowsMaintenanceOperation = (mode: string | undefined, readOnly: boolean): boolean =>
  mode === undefined || mode === "normal" || (mode === "frozen" && readOnly);
