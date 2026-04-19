process.env.TZ = "Asia/Tokyo";

import { env } from "./env.js";
import { logger } from "./logger.js";

logger.info(
  {
    guildId: env.DISCORD_GUILD_ID,
    channelId: env.DISCORD_CHANNEL_ID
  },
  "Development bootstrap completed."
);
