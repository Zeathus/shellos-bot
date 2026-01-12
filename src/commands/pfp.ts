import {
    CommandInteractionOptionResolver,
    CommandInteraction,
    ChannelType,
    GuildTextBasedChannel,
    GuildChannel,
} from "discord.js";
import { Command } from "../types/index.js";

export default {
    name: "pfp",
    description:
        "Get a user's profile picture.",
    options: [
        {
            name: "user",
            description: "User",
            type: 6,
            required: true,
        }
    ],
    async execute(
        interaction: CommandInteraction,
        options: CommandInteractionOptionResolver
    ) {
        const user = options.getUser("user");
        if (!user) {
            await interaction.reply("User not found");
            return;
        }
        await interaction.reply(user.avatarURL({size: 1024}) || "No avatar URL found");
    },
} as Command;