import type {
  AnalysisCompletedNotification,
  AnalysisNotificationMatch,
  DiscordResultNotification,
  OcrCompletedNotification
} from "@momo/db/notifications";
import { MessageFlags, type MessageCreateOptions } from "discord.js";

import { NotificationInputError } from "../../domain/notificationInput.ts";
import { RESULT_NOTIFICATION_MAX_PARTS } from "../../notifications/config.ts";
import { formatTimestampJst, parseTimestamp } from "../../time/index.ts";
import { buildNotificationLinks, type NotificationLinks } from "./links.ts";
import { renderNotificationRankParts } from "./ranks.ts";
import { escapeNotificationText as plain, escapeNotificationTextParts, splitNotificationTextParts } from "./text.ts";

type NotificationPart = MessageCreateOptions & { readonly content: string };

export interface RenderedResultNotification {
  readonly rendererVersion: number;
  readonly parts: readonly NotificationPart[];
}

export interface PlannedResultNotification {
  readonly rendererVersion: number;
  readonly partCount: number;
  readonly parts: () => Generator<NotificationPart, void, unknown>;
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
  if (body.length > 2_000) { throw new NotificationInputError("payload_too_large"); }
  return body;
};

function* renderMatch(match: AnalysisNotificationMatch, links: NotificationLinks): Generator<string, void, unknown> {
  yield `開催日: ${match.heldDateIso} / 第${match.matchNoInEvent}試合\nプレイ日時: ${timestamp(match.playedAt)}\nマップ: `;
  yield* escapeNotificationTextParts(match.mapName);
  yield " / シーズン: ";
  yield* escapeNotificationTextParts(match.seasonName);
  yield "\nオーナー: ";
  yield* escapeNotificationTextParts(match.ownerName);
  for (const player of [...match.players].sort((left, right) => left.rank - right.rank)) {
    yield `\n${player.rank}位 `;
    yield* escapeNotificationTextParts(player.displayName);
    yield ` / 銀次 ${player.ginjiCount}回`;
  }
  yield `\nこの試合の銀次合計: ${match.ginjiTotal}回`;
  if (match.note !== null) {
    yield "\nメモ:\n";
    yield* escapeNotificationTextParts(match.note);
  }
  yield `\n試合を確認: ${links.match(match.matchId)}`;
}

function* renderAnalysis(notification: AnalysisCompletedNotification, links: NotificationLinks): Generator<string, void, unknown> {
  const { data } = notification;
  yield data.disposition === "reused" ? "分析完了（既存分析を再利用）" : "分析完了";
  yield "\n作品: ";
  yield* escapeNotificationTextParts(data.gameTitleName);
  yield `\n通知の基準日時: ${timestamp(notification.occurredAt)}\n本文はこの時点の結果です。分析のリンク先には最新の結果を表示します。\n\n作品通算（全マップ）: 前回成功分析 → 今回\n`;
  yield* renderNotificationRankParts(data.overall);
  yield "\n\n";
  for (const season of data.seasons) {
    yield "シーズン通算（全マップ）: ";
    yield* escapeNotificationTextParts(season.seasonName);
    yield "\n";
    yield* renderNotificationRankParts(season.ranks);
    yield "\n\n";
  }
  yield `追加・変更試合: ${data.matches.length === 0 ? "なし" : `${data.matches.length}試合`}`;
  if (data.matches.length > 0 && data.matches.every(match => match.ginjiTotal === 0)) {
    yield "\n今回の対象試合は銀次なし（全員0回）";
  }
  for (const [index, match] of data.matches.entries()) {
    yield `\n\n掲載試合 ${index + 1}/${data.matches.length}\n`;
    yield* renderMatch(match, links);
  }
  yield `\n\n最新の分析を確認: ${links.analysis(data.gameTitleId)}`;
}

const countParts = (parts: Iterable<string>, maximum: number): number => {
  let count = 0;
  for (const part of parts) { if (part.length > 0 && ++count > maximum) { return count; } }
  return count;
};

/** Check the actual escaped text and configured links before accepting a new notification. */
export const assertNewNotificationPartLimit = (notification: DiscordResultNotification, webOrigin: string): void => {
  const links = buildNotificationLinks(webOrigin);
  if (notification.kind === "ocr_completed") { renderOcr(notification, links); return; }
  if (countParts(splitNotificationTextParts(renderAnalysis(notification, links)), RESULT_NOTIFICATION_MAX_PARTS)
    > RESULT_NOTIFICATION_MAX_PARTS) { throw new NotificationInputError("payload_too_large"); }
};

/** Count once, then yield retained renderer parts without holding the expanded full body. */
export const planResultNotification = (
  notification: DiscordResultNotification,
  webOrigin: string,
  rendererVersion = notification.kind === "ocr_completed" ? 2 : 1
): PlannedResultNotification => {
  if (rendererVersion !== (notification.kind === "ocr_completed" ? 2 : 1)) { throw new Error("Unsupported notification renderer."); }
  const links = buildNotificationLinks(webOrigin);
  if (notification.kind === "ocr_completed") {
    const content = renderOcr(notification, links);
    return { rendererVersion, partCount: 1, *parts() {
      yield { content, allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }, flags: MessageFlags.SuppressEmbeds };
    } };
  }
  const partCount = countParts(splitNotificationTextParts(renderAnalysis(notification, links)), 10_000);
  if (partCount === 0 || partCount > 10_000) { throw new Error("Notification has an invalid part count."); }
  return {
    rendererVersion, partCount,
    *parts() {
      let index = 0;
      for (const chunk of splitNotificationTextParts(renderAnalysis(notification, links))) {
        yield {
          content: `分析完了 ${index + 1}/${partCount}${index === 0 ? "" : "（続き）"}\n${chunk}`,
          allowedMentions: { parse: [], users: [], roles: [], repliedUser: false }, flags: MessageFlags.SuppressEmbeds
        };
        index += 1;
      }
    }
  };
};

/** Materialize the retained rendering for callers that need a complete value. */
export const renderResultNotification = (
  notification: DiscordResultNotification,
  webOrigin: string,
  rendererVersion = notification.kind === "ocr_completed" ? 2 : 1
): RenderedResultNotification => {
  const plan = planResultNotification(notification, webOrigin, rendererVersion);
  return { rendererVersion: plan.rendererVersion, parts: [...plan.parts()] };
};
