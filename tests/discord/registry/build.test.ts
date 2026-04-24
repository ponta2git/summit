import { SlashCommandBuilder } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  FeatureRegistryBuildError,
  buildFeatureRegistry
} from "../../../src/discord/registry/index.js";
import type { FeatureModule } from "../../../src/discord/registry/types.js";

const stubButtonHandler = vi.fn(async () => undefined);
const stubCommandHandler = vi.fn(async () => undefined);

const builder = (name: string): SlashCommandBuilder =>
  new SlashCommandBuilder().setName(name).setDescription("test") as SlashCommandBuilder;

const moduleWithButton = (id: string, prefix: string): FeatureModule => ({
  id,
  buttons: [{ customIdPrefix: prefix, handle: stubButtonHandler }]
});

const moduleWithCommand = (id: string, name: string): FeatureModule => ({
  id,
  commands: [{ name, builder: builder(name), handle: stubCommandHandler }]
});

describe("buildFeatureRegistry", () => {
  it("returns resolvers and slashBuilders for a valid configuration", () => {
    const registry = buildFeatureRegistry([
      moduleWithButton("ask-session", "ask:"),
      moduleWithCommand("status-command", "status")
    ]);

    expect(registry.resolveButton("ask:t2200")?.customIdPrefix).toBe("ask:");
    expect(registry.resolveButton("postpone:ok")).toBeUndefined();
    expect(registry.resolveCommand("status")?.name).toBe("status");
    expect(registry.resolveCommand("unknown")).toBeUndefined();
    expect(registry.slashBuilders).toHaveLength(1);
  });

  it("throws when customIdPrefix does not end with ':'", () => {
    expect(() =>
      buildFeatureRegistry([moduleWithButton("bad", "ask")])
    ).toThrow(FeatureRegistryBuildError);
  });

  it("throws when customIdPrefix is just ':' (empty)", () => {
    expect(() =>
      buildFeatureRegistry([moduleWithButton("bad", ":")])
    ).toThrow(FeatureRegistryBuildError);
  });

  it("throws on duplicate customIdPrefix across modules", () => {
    expect(() =>
      buildFeatureRegistry([
        moduleWithButton("first", "ask:"),
        moduleWithButton("second", "ask:")
      ])
    ).toThrow(/Duplicate customIdPrefix/);
  });

  it("throws when one prefix is contained in another (resolve order would matter)", () => {
    expect(() =>
      buildFeatureRegistry([
        moduleWithButton("outer", "ask:"),
        moduleWithButton("inner", "ask:foo:")
      ])
    ).toThrow(/conflicts with/);
  });

  it("throws on duplicate command name across modules", () => {
    expect(() =>
      buildFeatureRegistry([
        moduleWithCommand("first", "status"),
        moduleWithCommand("second", "status")
      ])
    ).toThrow(/Duplicate command name/);
  });

  it("collects all slashBuilders in registration order", () => {
    const registry = buildFeatureRegistry([
      moduleWithCommand("a", "alpha"),
      moduleWithCommand("b", "beta")
    ]);
    expect(registry.slashBuilders.map((b) => b.name)).toEqual(["alpha", "beta"]);
  });
});
