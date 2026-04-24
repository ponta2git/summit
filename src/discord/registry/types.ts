import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder
} from "discord.js";

import type { InteractionHandlerDeps } from "../shared/interactionHandlerDeps.js";

export type ButtonHandler = (
  interaction: ButtonInteraction,
  deps: InteractionHandlerDeps,
  ack: { readonly acknowledged: true }
) => Promise<void>;

export type CommandHandler = (
  interaction: ChatInputCommandInteraction,
  deps: InteractionHandlerDeps
) => Promise<void>;

// why: discord.js は SlashCommandBuilder の chain で .setName().setDescription() などを呼ぶたび
// 細分化された interface に narrow される。registry は toJSON() さえできれば良いので 3 形すべて受ける。
export type SlashBuilder =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder;

export interface ButtonRoute {
  /** 必ず ":" 終端。registry 構築時に検証。 */
  readonly customIdPrefix: string;
  readonly handle: ButtonHandler;
}

export interface CommandRoute {
  readonly name: string;
  readonly builder: SlashBuilder;
  readonly handle: CommandHandler;
}

export interface FeatureModule {
  /** ログ・debug 用 (例: "ask-session") */
  readonly id: string;
  readonly buttons?: readonly ButtonRoute[];
  readonly commands?: readonly CommandRoute[];
}
