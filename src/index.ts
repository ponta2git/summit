// why: 通常 module の import 自体が DB / Discord の初期化を伴うため、先に分岐する。
const mode = process.env["MOMO_CUTOVER_MODE"];
if (mode === "maintenance") {
  const { runMaintenance } = await import("./startup/maintenance.ts");
  await runMaintenance(process.env);
} else if ((mode === undefined || mode === "") &&
  !Object.keys(process.env).some(key => key.startsWith("MOMO_CUTOVER_") && key !== "MOMO_CUTOVER_MODE")) {
  await import("./startup/normal.ts");
} else {
  process.stderr.write("CUTOVER_MODE_INVALID\n");
  process.exitCode = 1;
}
export {};
