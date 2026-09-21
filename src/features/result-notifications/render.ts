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
  const screens = ["total_assets", "revenue", "incident_log"] as const;
  const labels = { total_assets: "総資産", revenue: "物件収益", incident_log: "事件簿" } as const;
  const reasons = {
    admission_failed: "画像を受け付けられませんでした。", admission_timeout: "画像の受付期限を過ぎました。",
    ocr_failed: "画像を読み取れませんでした。", ocr_timeout: "読み取りの制限時間を超えました。", cancelled: "読み取りが中止されました。"
  } as const;
  const lines = [
    "OCRの処理が終了しました。",
    ...(data.context.heldDateIso === null ? [] : [`開催日: ${data.context.heldDateIso}`]),
    ...(data.context.matchNoInEvent === null ? [] : [`試合番号: 第${data.context.matchNoInEvent}試合`]),
    `完了日時: ${timestamp(notification.occurredAt)}`,
    ...(data.failures.length === 0 ? [] : ["", "読み取れなかった画像:", ...screens.flatMap(screen => {
      const failure = data.failures.find(value => value.screenType === screen);
      return failure ? [`${labels[screen]}: ${reasons[failure.reason]}`] : [];
    })]),
    "", `下書きを確認: ${links.draft(data.matchDraftId)}`
  ];
  // invariant: 必須の失敗・時刻・確認先は残し、任意の表示名だけを残り予算へ収める。
  const available = 2_000 - lines.join("\n").length - "作品: \n".length;
  if (data.context.gameTitleName !== null) {
    const escaped = plain(data.context.gameTitleName);
    if (escaped.length <= available) { lines.splice(1, 0, `作品: ${escaped}`); }
    else {
      const suffix = "…（省略）";
      let shortened = "";
      for (const point of data.context.gameTitleName) {
        const next = plain(point);
        if (shortened.length + next.length + suffix.length > available) { break; }
        shortened += next;
      }
      lines.splice(1, 0, `作品: ${shortened}${suffix}`);
    }
  }
  const body = lines.join("\n");
  if (body.length > 2_000) { throw new Error("OCR notification exceeds its single-message budget."); }
  return body;
};

const renderMatch = (match: AnalysisNotificationMatch, links: NotificationLinks): string => [
  `開催日: ${match.heldDateIso} / 第${match.matchNoInEvent}試合`,
  `プレイ日時: ${timestamp(match.playedAt)}`,
  `マップ: ${plain(match.mapName)} / シーズン: ${plain(match.seasonName)}`,
  `オーナー: ${plain(match.ownerName)}`,
  ...[...match.players].sort((left, right) => left.rank - right.rank)
    .map((player) => `${player.rank}位 ${plain(player.displayName)} / 銀次 ${player.ginjiCount}回`),
  `この試合の銀次合計: ${match.ginjiTotal}回`,
  ...(match.note === null ? [] : [`メモ:\n${plain(match.note)}`]),
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
    ...(data.matches.length > 0 && data.matches.every(match => match.ginjiTotal === 0)
      ? ["今回の対象試合は銀次なし（全員0回）"] : []),
    ...data.matches.flatMap((match, index) => [
      "", `掲載試合 ${index + 1}/${data.matches.length}`, renderMatch(match, links)
    ]),
    "",
    `最新の分析を確認: ${links.analysis(data.gameTitleId)}`
  ].join("\n");
};

/** Render the fixed snapshot with the renderer retained for its kind and wire version. */
export const renderResultNotification = (
  notification: DiscordResultNotification,
  webOrigin: string,
  rendererVersion = notification.kind === "ocr_completed" ? 2 : 1
): RenderedResultNotification => {
  if (rendererVersion !== (notification.kind === "ocr_completed" ? 2 : 1)) { throw new Error("Unsupported notification renderer."); }
  const links = buildNotificationLinks(webOrigin);
  const body = notification.kind === "ocr_completed"
    ? renderOcr(notification, links) : renderAnalysis(notification, links);
  if (notification.kind === "ocr_completed") {
    return { rendererVersion, parts: [{ content: body, allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
      flags: MessageFlags.SuppressEmbeds }] };
  }
  const chunks = splitNotificationText(body);
  if (chunks.length === 0 || chunks.length > 10_000) {
    throw new Error("Notification has an invalid part count.");
  }
  const title = "分析完了";
  return {
    rendererVersion,
    parts: chunks.map((chunk, index) => ({
      content: `${title} ${index + 1}/${chunks.length}${index === 0 ? "" : "（続き）"}\n${chunk}`,
      allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
      flags: MessageFlags.SuppressEmbeds
    }))
  };
};
