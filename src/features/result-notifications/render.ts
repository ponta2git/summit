import type {
  AnalysisCompletedNotification,
  AnalysisNotificationMatch,
  DiscordResultNotification,
  OcrCompletedNotification
} from "@momo/db/notifications";
import { MessageFlags, type MessageCreateOptions } from "discord.js";

import { formatTimestampJst, parseTimestamp } from "../../time/index.ts";
import { buildNotificationLinks, type NotificationLinks } from "./links.ts";
import { renderNotificationRanks } from "./ranks.ts";
import { escapeNotificationText as plain, splitNotificationText } from "./text.ts";

export interface RenderedResultNotification {
  readonly rendererVersion: number;
  readonly parts: readonly (MessageCreateOptions & { readonly content: string })[];
}

const timestamp = (value: string): string => {
  const date = parseTimestamp(value);
  if (date === null) { throw new Error("Notification timestamp is invalid."); }
  return formatTimestampJst(date);
};

const renderOcr = (notification: OcrCompletedNotification, links: NotificationLinks): string => {
  const { data } = notification;
  const screen = { total_assets: "総資産", revenue: "物件収益", incident_log: "事件簿" } as const;
  return [
    `OCR完了: ${data.outcome === "needs_review" ? "要確認" : "成功"}`,
    `画像種別: ${screen[data.screenType]}`,
    ...(data.context.gameTitleName === null ? [] : [`作品: ${plain(data.context.gameTitleName)}`]),
    ...(data.context.heldDateIso === null ? [] : [`開催日: ${data.context.heldDateIso}`]),
    ...(data.context.matchNoInEvent === null ? [] : [`試合番号: 第${data.context.matchNoInEvent}試合`]),
    `処理日時: ${timestamp(notification.occurredAt)}`,
    "",
    `要約: ${plain(data.summary)}`,
    "",
    `下書きを確認: ${links.draft(data.matchDraftId)}`
  ].join("\n");
};

const renderMatch = (match: AnalysisNotificationMatch, links: NotificationLinks): string => [
  `開催日: ${match.heldDateIso} / 第${match.matchNoInEvent}試合`,
  `プレイ日時: ${timestamp(match.playedAt)}`,
  `マップ: ${plain(match.mapName)} / シーズン: ${plain(match.seasonName)}`,
  `オーナー: ${plain(match.ownerName)}`,
  ...[...match.players].sort((left, right) => left.rank - right.rank)
    .map((player) => `${player.rank}位 ${plain(player.displayName)} / 銀次 ${player.ginjiCount}回`),
  `この試合の銀次合計: ${match.ginjiTotal}回`,
  match.note === null ? "メモ: なし" : `メモ:\n${plain(match.note)}`,
  `試合を確認: ${links.match(match.matchId)}`
].join("\n");

const renderAnalysis = (notification: AnalysisCompletedNotification, links: NotificationLinks): string => {
  const { data } = notification;
  return [
    data.disposition === "reused" ? "分析完了（既存分析を再利用）" : "分析完了",
    `作品: ${plain(data.gameTitleName)}`,
    `通知の基準日時: ${timestamp(notification.occurredAt)}`,
    "本文はこの時点の結果です。分析のリンク先には最新の結果を表示します。",
    "",
    "作品通算（全マップ）: 前回成功分析 → 今回",
    renderNotificationRanks(data.overall),
    "",
    ...data.seasons.flatMap((season) => [
      `シーズン通算（全マップ）: ${plain(season.seasonName)}`,
      renderNotificationRanks(season.ranks),
      ""
    ]),
    `追加・変更試合: ${data.matches.length === 0 ? "なし" : `${data.matches.length}試合`}`,
    ...data.matches.flatMap((match, index) => [
      "", `掲載試合 ${index + 1}/${data.matches.length}`, renderMatch(match, links)
    ]),
    "",
    `最新の分析を確認: ${links.analysis(data.gameTitleId)}`
  ].join("\n");
};

/** Render only the successful job's snapshot. Version 1 must remain stable while retained. */
export const renderResultNotification = (
  notification: DiscordResultNotification,
  webOrigin: string,
  rendererVersion = 1
): RenderedResultNotification => {
  if (rendererVersion !== 1) { throw new Error("Unsupported notification renderer."); }
  const links = buildNotificationLinks(webOrigin);
  const body = notification.kind === "ocr_completed"
    ? renderOcr(notification, links) : renderAnalysis(notification, links);
  const chunks = splitNotificationText(body);
  if (chunks.length === 0 || chunks.length > 10_000) {
    throw new Error("Notification has an invalid part count.");
  }
  const title = notification.kind === "ocr_completed" ? "OCR完了" : "分析完了";
  return {
    rendererVersion,
    parts: chunks.map((chunk, index) => ({
      content: `${title} ${index + 1}/${chunks.length}${index === 0 ? "" : "（続き）"}\n${chunk}`,
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
      flags: MessageFlags.SuppressEmbeds
    }))
  };
};
