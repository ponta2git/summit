import { describe, expect, it } from "vitest";
import { commandsMatch, InvalidCommandResponseError } from "../../../src/commands/sync.compare.ts";

const command = { name: "ask", type: 1, description: "募集", options: [] };
describe("guild command comparison", () => {
  it("normalizes Discord-generated fields, defaults, localizations and command order", () => {
    expect(commandsMatch([command, { ...command, name: "status" }], [
      { ...command, name: "status", id: "server-id", application_id: "app", guild_id: "guild", version: "v", contexts: [0] },
      { name: "ask", type: 1, description: "募集", name_localizations: null, description_localizations: null,
        default_permission: true, default_member_permissions: null, nsfw: false, description_localized: "localized" }
    ])).toBe(true);
  });
  it.each([
    [], [{ ...command, description: "変更" }], [{ ...command, name: "other" }],
    [command, command], [{ ...command, nsfw: true }], [{ ...command, default_member_permissions: "0" }],
    [{ ...command, name_localizations: { ja: "別名" } }], [{ ...command, options: [{ name: "value", type: 3, description: "入力" }] }]
  ].map(registered => ({ registered })))("detects changes instead of equating only names/counts", ({ registered }) => {
    expect(commandsMatch([command], registered)).toBe(false);
  });
  it("normalizes option defaults but preserves option/choice order and values", () => {
    const option = { name: "choice", description: "選択", type: 3, choices: [{ name: "A", value: "a" }, { name: "B", value: "b" }] };
    const expected = [{ ...command, options: [option] }];
    expect(commandsMatch(expected, [{ ...command, options: [{ ...option, required: false, autocomplete: false, options: [], name_localizations: null }] }])).toBe(true);
    expect(commandsMatch(expected, [{ ...command, options: [{ ...option, choices: [...option.choices].reverse() }] }])).toBe(false);
    expect(commandsMatch(expected, [{ ...command, options: [{ ...option, required: true }] }])).toBe(false);
  });
  it.each([null, {}, [null], [{ name: "ask" }], [{ ...command, options: {} }]].map(registered => ({ registered })))("rejects malformed responses before overwriting", ({ registered }) => {
    expect(() => commandsMatch([command], registered)).toThrow(InvalidCommandResponseError);
  });
});
