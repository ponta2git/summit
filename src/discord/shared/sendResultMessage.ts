import type { MessageCreateOptions, TextChannel } from "discord.js";

/** Release the sent result message from the SDK cache and retain only its identity. */
export const sendResultMessage = (channel: Pick<TextChannel, "send" | "messages">, options: MessageCreateOptions): Promise<string> =>
  channel.send(options).then(message => {
    const id = message.id;
    // race: 呼出側の待機期限後でも、実際の送信成功に続けて自分の本文だけを解放する。
    try { channel.messages.cache.delete(id); } catch {
      // why: 補助的なcache清掃の失敗で、Discord送信成功を失敗・再送へ変えない。
    }
    return id;
  });
