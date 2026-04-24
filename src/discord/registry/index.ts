import type {
  ButtonRoute,
  CommandRoute,
  FeatureModule,
  SlashBuilder
} from "./types.js";

export interface FeatureRegistry {
  readonly resolveButton: (customId: string) => ButtonRoute | undefined;
  readonly resolveCommand: (name: string) => CommandRoute | undefined;
  readonly slashBuilders: readonly SlashBuilder[];
}

export class FeatureRegistryBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureRegistryBuildError";
  }
}

// invariant: prefix は必ず ":" 終端、互いに包含関係を持たないこと。包含を許すと resolve 順依存になる。
const validatePrefix = (prefix: string, moduleId: string): void => {
  if (!prefix.endsWith(":")) {
    throw new FeatureRegistryBuildError(
      `[${moduleId}] customIdPrefix must end with ':' (got "${prefix}")`
    );
  }
  if (prefix === ":") {
    throw new FeatureRegistryBuildError(
      `[${moduleId}] customIdPrefix must not be empty before ':' (got "${prefix}")`
    );
  }
};

export const buildFeatureRegistry = (
  modules: readonly FeatureModule[]
): FeatureRegistry => {
  const buttonsByPrefix = new Map<string, { readonly route: ButtonRoute; readonly moduleId: string }>();
  const commandsByName = new Map<string, { readonly route: CommandRoute; readonly moduleId: string }>();
  const slashBuilders: SlashBuilder[] = [];

  for (const mod of modules) {
    for (const route of mod.buttons ?? []) {
      validatePrefix(route.customIdPrefix, mod.id);

      const existing = buttonsByPrefix.get(route.customIdPrefix);
      if (existing !== undefined) {
        throw new FeatureRegistryBuildError(
          `Duplicate customIdPrefix "${route.customIdPrefix}" registered by [${existing.moduleId}] and [${mod.id}]`
        );
      }

      // 包含関係チェック (双方向)
      for (const [otherPrefix, otherEntry] of buttonsByPrefix) {
        if (
          route.customIdPrefix.startsWith(otherPrefix) ||
          otherPrefix.startsWith(route.customIdPrefix)
        ) {
          throw new FeatureRegistryBuildError(
            `customIdPrefix "${route.customIdPrefix}" from [${mod.id}] conflicts with "${otherPrefix}" from [${otherEntry.moduleId}] (one is a prefix of the other)`
          );
        }
      }

      buttonsByPrefix.set(route.customIdPrefix, { route, moduleId: mod.id });
    }

    for (const route of mod.commands ?? []) {
      const existing = commandsByName.get(route.name);
      if (existing !== undefined) {
        throw new FeatureRegistryBuildError(
          `Duplicate command name "${route.name}" registered by [${existing.moduleId}] and [${mod.id}]`
        );
      }
      commandsByName.set(route.name, { route, moduleId: mod.id });
      slashBuilders.push(route.builder);
    }
  }

  const resolveButton = (customId: string): ButtonRoute | undefined => {
    for (const [prefix, entry] of buttonsByPrefix) {
      if (customId.startsWith(prefix)) {
        return entry.route;
      }
    }
    return undefined;
  };

  const resolveCommand = (name: string): CommandRoute | undefined =>
    commandsByName.get(name)?.route;

  return {
    resolveButton,
    resolveCommand,
    slashBuilders
  };
};
