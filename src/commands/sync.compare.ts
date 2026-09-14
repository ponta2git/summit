export class InvalidCommandResponseError extends Error {
  constructor() { super("Invalid command response"); }
}

const object = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) { throw new InvalidCommandResponseError(); }
  return value as Record<string, unknown>;
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
    const choices = option["choices"] ?? [];
    if (!Array.isArray(choices)) { throw new InvalidCommandResponseError(); }
    return { ...option, required: option["required"] ?? false, autocomplete: option["autocomplete"] ?? false,
      name_localizations: option["name_localizations"] ?? {}, description_localizations: option["description_localizations"] ?? {},
      options: normalizeOptions(option["options"] ?? [], depth + 1),
      choices: choices.map(choice => ({ ...object(choice), name_localizations: object(choice)["name_localizations"] ?? {} })) };
  });
};

const normalizeCommands = (value: unknown): string[] => {
  if (!Array.isArray(value)) { throw new InvalidCommandResponseError(); }
  return value.map(item => {
    const command = object(item);
    if (typeof command["name"] !== "string" || typeof command["type"] !== "number") { throw new InvalidCommandResponseError(); }
    // why: Guild 登録に有効な定義を比較。ID/version と global 専用の contexts/integration_types は対象外。
    return JSON.stringify(normalize({ name: command["name"], type: command["type"], description: command["description"] ?? "",
      name_localizations: command["name_localizations"] ?? {}, description_localizations: command["description_localizations"] ?? {},
      options: normalizeOptions(command["options"] ?? []), default_member_permissions: command["default_member_permissions"] ?? null,
      default_permission: command["default_permission"] ?? true, nsfw: command["nsfw"] ?? false }));
  }).sort();
};

export const commandsMatch = (expected: unknown, registered: unknown): boolean =>
  JSON.stringify(normalizeCommands(expected)) === JSON.stringify(normalizeCommands(registered));
