import { parseDocument } from "yaml";

const MAX_USER_CONFIG_BYTES = 65_536;

/** Parse injected configuration without emitting source text through parser diagnostics. */
export const parseUserConfigYaml = (source: string): unknown => {
  try {
    if (Buffer.byteLength(source, "utf8") > MAX_USER_CONFIG_BYTES) { throw new Error(); }
    const document = parseDocument(source, { prettyErrors: false, logLevel: "error" });
    if (document.errors.length > 0 || document.warnings.length > 0) { throw new Error(); }
    return document.toJS({ maxAliasCount: 100 });
  } catch { throw new Error("Invalid configuration YAML"); }
};
