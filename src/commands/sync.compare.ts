export class InvalidCommandResponseError extends Error {
  constructor() { super("Invalid command response"); }
}

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { throw new InvalidCommandResponseError(); }
  return value as Record<string, unknown>;
};

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const localizations = (value: unknown): Record<string, unknown> => {
  const result = value === undefined || value === null ? {} : object(value);
  if (!Object.values(result).every(item => item === null || item === undefined || text(item))) { throw new InvalidCommandResponseError(); }
  return Object.fromEntries(Object.entries(result).filter(([, item]) => item !== null && item !== undefined));
};
const boolean = (value: unknown, fallback = false): boolean => {
  if (value === undefined) { return fallback; }
  if (typeof value !== "boolean") { throw new InvalidCommandResponseError(); }
  return value;
};

const normalize = (value: unknown, depth = 0): unknown => {
  if (depth > 16) { throw new InvalidCommandResponseError(); }
  if (Array.isArray(value)) { return value.map(item => normalize(item, depth + 1)); }
  if (typeof value !== "object" || value === null) { return value; }
  return Object.fromEntries(Object.entries(value).filter(([key, item]) =>
    item !== undefined && key !== "name_localized" && key !== "description_localized"
  ).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item, depth + 1)]));
};

const normalizeOptions = (value: unknown, depth = 0): unknown[] => {
  if (depth > 8 || !Array.isArray(value)) { throw new InvalidCommandResponseError(); }
  return value.map(item => {
    const option = object(item);
    const type = option["type"];
    if (!text(option["name"]) || !text(option["description"]) || typeof type !== "number"
      || !Number.isInteger(type) || type < 1 || type > 11) { throw new InvalidCommandResponseError(); }
    for (const key of ["min_value", "max_value", "min_length", "max_length"]) {
      const number = option[key];
      if (number !== undefined && (typeof number !== "number" || !Number.isFinite(number))) { throw new InvalidCommandResponseError(); }
    }
    const channels = option["channel_types"];
    if (channels !== undefined && (!Array.isArray(channels) || !channels.every(Number.isInteger))) { throw new InvalidCommandResponseError(); }
    const files = option["file_types"];
    if (files !== undefined && (!Array.isArray(files) || !files.every(text))) { throw new InvalidCommandResponseError(); }
    const choices = option["choices"] === undefined ? [] : option["choices"];
    if (!Array.isArray(choices)) { throw new InvalidCommandResponseError(); }
    return { ...option, required: boolean(option["required"]), autocomplete: boolean(option["autocomplete"]),
      name_localizations: localizations(option["name_localizations"]), description_localizations: localizations(option["description_localizations"]),
      options: normalizeOptions(option["options"] === undefined ? [] : option["options"], depth + 1),
      choices: choices.map(entry => {
        const choice = object(entry);
        if (!text(choice["name"]) || (typeof choice["value"] !== "string"
          && !(typeof choice["value"] === "number" && Number.isFinite(choice["value"])))) { throw new InvalidCommandResponseError(); }
        return { ...choice, name_localizations: localizations(choice["name_localizations"]) };
      }) };
  });
};

const normalizeCommands = (value: unknown): string[] => {
  if (!Array.isArray(value)) { throw new InvalidCommandResponseError(); }
  return value.map(item => {
    const command = object(item);
    const type = command["type"] === undefined ? 1 : command["type"];
    if (!text(command["name"]) || (type !== 1 && type !== 2 && type !== 3)
      || (type === 1 ? !text(command["description"]) : command["description"] !== undefined && command["description"] !== "")) {
      throw new InvalidCommandResponseError();
    }
    const permissions = command["default_member_permissions"] ?? null;
    if (permissions !== null && (typeof permissions !== "string" || !/^\d+$/.test(permissions))) { throw new InvalidCommandResponseError(); }
    // why: Guild 登録に有効な定義を比較。ID/version と global 専用の contexts/integration_types は対象外。
    return JSON.stringify(normalize({ name: command["name"], type, description: command["description"] ?? "",
      name_localizations: localizations(command["name_localizations"]), description_localizations: localizations(command["description_localizations"]),
      options: normalizeOptions(command["options"] === undefined ? [] : command["options"]), default_member_permissions: permissions,
      default_permission: boolean(command["default_permission"] ?? true), nsfw: boolean(command["nsfw"]) }));
  }).sort();
};

/** Compares writable guild-command fields, rejecting malformed data instead of treating it as drift. */
export const commandsMatch = (expected: unknown, registered: unknown): boolean =>
  JSON.stringify(normalizeCommands(expected)) === JSON.stringify(normalizeCommands(registered));
