import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type MessageCreateOptions,
  type MessageEditOptions
} from "discord.js";

import {
  listResponses,
  type DbLike,
  type ResponseRow,
  type SessionRow
} from "../../db/repositories/sessions.js";
import { env } from "../../env.js";
import { buildMemberLines } from "../../members.js";
import {
  decidedStartAt,
  formatCandidateJa,
  parseCandidateDateIso,
  type AskTimeChoice
} from "../../time/index.js";

// invariant: Discord button の custom_id 末尾は ASK_CHOICES の小文字値と一致しなければならない。
//   interactions.ts の askCustomIdSchema / ASK_CUSTOM_ID_TO_DB_CHOICE と 3 箇所同時更新。
const ASK_CHOICES = ["t2200", "t2230", "t2300", "t2330", "absent"] as const;
type AskChoice = (typeof ASK_CHOICES)[number];

const ASK_BUTTON_LABELS: Record<AskChoice, string> = {
  t2200: "22:00",
  t2230: "22:30",
  t2300: "23:00",
  t2330: "23:30",
  absent: "欠席"
};

const CHOICE_LABEL_FOR_RESPONSE: Record<string, string> = {
  T2200: "22:00",
  T2230: "22:30",
  T2300: "23:00",
  T2330: "23:30",
  ABSENT: "欠席"
};

export const buildAskRow = (
  sessionId: string,
  options: { disabled?: boolean } = {}
): ActionRowBuilder<ButtonBuilder> => {
  // invariant: custom_id は interactions.ts の askCustomIdSchema (UUID v4 + choice regex) で検証される。
  //   ここで組み立てる ID はその正規表現にマッチしなければならない。
  const buttons = ASK_CHOICES.map((choice) =>
    new ButtonBuilder()
      .setCustomId(`ask:${sessionId}:${choice}`)
      .setLabel(ASK_BUTTON_LABELS[choice])
      .setStyle(choice === "absent" ? ButtonStyle.Danger : ButtonStyle.Secondary)
      .setDisabled(Boolean(options.disabled))
  );
  return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
};

const memberLinesFromState = (
  memberUserIds: readonly string[],
  responsesByUserId: ReadonlyMap<string, string>
): string =>
  buildMemberLines(memberUserIds)
    .map((member) => {
      const choice = responsesByUserId.get(member.userId);
      const label = choice ? CHOICE_LABEL_FOR_RESPONSE[choice] ?? choice : "未回答";
      return `- ${member.displayName} : ${label}`;
    })
    .join("\n");

const buildAskContent = (
  candidateDate: Date,
  memberUserIds: readonly string[],
  responsesByUserId: ReadonlyMap<string, string>,
  extraFooter: string | undefined
): string => {
  const mentions = memberUserIds.map((userId) => `<@${userId}>`).join(" ");
  const statusLines = memberLinesFromState(memberUserIds, responsesByUserId);

  const lines = [
    mentions,
    "🎲 今週の桃鉄1年勝負の出欠確認です",
    "",
    `開催候補日: ${formatCandidateJa(candidateDate)}`,
    "回答締切: 21:30（未回答者が残っていれば中止）",
    "ルール: 「欠席」が1人でも出た時点で中止 / 押した時刻 \"以降\" なら参加OK",
    "      （例: 23:00 を押すと 23:00/23:30 でも参加可能として集計されます）",
    "",
    "【回答状況】",
    statusLines
  ];
  if (extraFooter) {
    lines.push("", extraFooter);
  }
  return lines.join("\n");
};

export interface RenderAskBodyOptions {
  footer?: string;
}

export const renderAskBody = (
  session: Pick<SessionRow, "id" | "candidateDate" | "status">,
  responses: readonly ResponseRow[],
  memberLookup: ReadonlyMap<string, string>,
  options: RenderAskBodyOptions = {}
): MessageCreateOptions & MessageEditOptions => {
  const responsesByUserId = new Map<string, string>();
  for (const response of responses) {
    const userId = memberLookup.get(response.memberId);
    if (userId) {responsesByUserId.set(userId, response.choice);}
  }

  const disabled = session.status !== "ASKING";
  const candidateDate = parseCandidateDateIso(session.candidateDate);

  return {
    content: buildAskContent(
      candidateDate,
      env.MEMBER_USER_IDS,
      responsesByUserId,
      options.footer
    ),
    components: [buildAskRow(session.id, { disabled })]
  };
};

export const renderInitialAskBody = (
  sessionId: string,
  candidateDate: Date
): MessageCreateOptions => ({
  content: buildAskContent(candidateDate, env.MEMBER_USER_IDS, new Map(), undefined),
  components: [buildAskRow(sessionId, { disabled: false })]
});

/**
 * Loads session responses from DB and returns a MessageEditOptions reflecting current state.
 *
 * @remarks
 * interaction ハンドラ / cron / 起動時リカバリから共通で呼ばれる再描画経路。
 * footer 文は status に応じて切り替える (DECIDED なら開始時刻、CANCELLED なら中止表示)。
 */
export const buildAskRenderFromDb = async (
  db: DbLike,
  session: SessionRow,
  memberLookup: ReadonlyMap<string, string>
): Promise<MessageEditOptions> => {
  const responses = await listResponses(db, session.id);

  let footer: string | undefined;
  if (session.status === "DECIDED" && session.decidedStartAt) {
    const timeChoices = responses
      .map((r) => r.choice)
      .filter((c): c is AskTimeChoice => c === "T2200" || c === "T2230" || c === "T2300" || c === "T2330");
    const start = decidedStartAt(parseCandidateDateIso(session.candidateDate), timeChoices);
    if (start) {
      const hh = String(start.getHours()).padStart(2, "0");
      const mm = String(start.getMinutes()).padStart(2, "0");
      footer = `✅ 全員回答により ${hh}:${mm} 開始で確定（開催決定メッセージは追って送信）`;
    }
  } else if (session.status === "CANCELLED") {
    footer = "🛑 中止。この週の募集は締め切りました";
  }

  return renderAskBody(session, responses, memberLookup, footer ? { footer } : {});
};
