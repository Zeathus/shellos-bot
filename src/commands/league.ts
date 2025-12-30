import {
    CommandInteractionOptionResolver,
    CommandInteraction,
    ChannelType,
    GuildTextBasedChannel,
    GuildChannel,
} from "discord.js";
import { Command } from "../types/index.js";
import DraftSheet, { createPickems, createTierPayload, DraftChannelType, getPokemonToTier } from "../types/DraftSheet.js";

const getChannelCategory = async (interaction: CommandInteraction): Promise<GuildChannel | undefined> => {
    let category = undefined;
    if (interaction.channel?.type === ChannelType.GuildText) {
        category = (interaction.channel as GuildTextBasedChannel).parent
    }
    if (!category) {
        await interaction.editReply({
            content: "This command has to be ran in a channel that's part of a channel category/group.",
        });
        return undefined;
    }
    return category;
}

export default {
    name: "league",
    description:
        "Command for configuring a league and its related channels.",
    options: [
        {
            name: "start",
            description: "Start a new league in this channel and the other channels in its category",
            type: 1,
            options: [
                {
                    name: "spreadsheet",
                    description: "URL to the draft spreadsheet for the league (Has to be a copy Zeathus' sheet)",
                    type: 3,
                    required: true
                }
            ]
        },
        {
            name: "channel",
            description: "Give this channel a specific purpose for the league",
            type: 1,
            options: [
                {
                    name: "type",
                    description: "The purpose of the channel.",
                    type: 3,
                    required: true,
                    choices: [
                        {
                            name: "replays",
                            value: "replays"
                        },
                        {
                            name: "pickems",
                            value: "pickems"
                        }
                    ]
                }
            ]
        },
        {
            name: "schedule",
            description: "Make the bot post the schedule for the specified week.",
            type: 1,
            options: [
                {
                    name: "week",
                    description: "The week, usually between 1 and 8",
                    type: 4,
                    required: true
                }
            ]
        },
        {
            name: "pickems",
            description: "Make the bot post the pickems for the specified week.",
            type: 1,
            options: [
                {
                    name: "week",
                    description: "The week, usually between 1 and 8",
                    type: 4,
                    required: true
                }
            ]
        },
        {
            name: "draft",
            description: "Unfinished.",
            type: 1,
            options: [
                {
                    name: "test",
                    description: "Unfinished.",
                    type: 4,
                    required: true
                }
            ]
        },
        {
            name: "tier",
            description: "Get prompted to tier pokemon",
            type: 1
        },
        {
            name: "test",
            description: "Just for testing WIP stuff",
            type: 1
        }
    ],
    async execute(
        interaction: CommandInteraction,
        options: CommandInteractionOptionResolver
    ) {
        const command = options.getSubcommand();

        if (command !== "tier") {
            await interaction.reply("Working...");
        }

        switch (command) {
            case "start": {
                const category = await getChannelCategory(interaction);
                if (!category) {
                    return;
                }

                const sheet = DraftSheet.from_url_and_category(options.getString("spreadsheet") || "", category.id);
                if (sheet === undefined) {
                    await interaction.editReply({
                        content: "Invalid draft sheet link."
                    });
                    return;
                }
                await sheet.load_from_sheet();
                if (!(await sheet.verify())) {
                    await interaction.editReply({
                        content: `Failed to prepare the league. Errors:\n- ${sheet.errors.join("\n- ")}`
                    });
                    return;
                }

                await sheet.release_sheets();

                if (!(await sheet.save())) {
                    await interaction.editReply({
                        content: `Failed to save the league for unknown reasons.`
                    });
                    return;
                }

                await interaction.editReply({
                    content: `Successfully started league '${sheet.setup.league_name}' in category '${category.name}'!`
                });

                break;
            }
            case "channel": {
                if (!interaction.channel) {
                    await interaction.editReply({
                        content: "This is not a channel."
                    });
                    return;
                }

                let type = -1;
                switch (options.getString("type")) {
                    case "replays": {
                        type = DraftChannelType.REPLAYS;
                    }
                    case "pickems": {
                        type = DraftChannelType.PICKEMS;
                    }
                }
                if (type === -1) {
                    await interaction.editReply({
                        content: "Not a valid channel type."
                    });
                    return;
                }

                const category = await getChannelCategory(interaction);
                if (!category) {
                    return;
                }

                const sheet = await DraftSheet.from_category(category.id);
                if (sheet === undefined) {
                    await interaction.editReply({
                        content: "This channel category/group does not belong to a league. Use '/league start' first."
                    });
                    return;
                }
                await sheet.load_from_db();

                if (!(await sheet.add_channel(interaction.channel.id, type))) {
                    await interaction.editReply({
                        content: "Failed to add channel for an unknown reason."
                    });
                    return;
                }

                await interaction.editReply({
                    content: `This channel is now the ${options.getString("type")} channel for '${sheet.setup.league_name}'.`
                });

                break;
            }
            case "schedule": {
                if (!interaction.channel) {
                    await interaction.editReply({
                        content: "This is not a channel."
                    });
                    return;
                }

                const week = options.getInteger("week") || 0;

                const category = await getChannelCategory(interaction);
                if (!category) {
                    return;
                }

                const sheet = await DraftSheet.from_category(category.id);
                if (sheet === undefined) {
                    await interaction.editReply({
                        content: "This channel category/group does not belong to a league. Use '/league start' first."
                    });
                    return;
                }
                await sheet.load_from_db();

                if (week <= 0 || week > sheet.setup.weeks) {
                    await interaction.editReply({
                        content: "No week exists for that number."
                    });
                    return;
                }

                const schedule = await sheet.get_schedule(week);
                let msg = `## Week ${week} Schedule`;
                for (const match of schedule) {
                    msg += `\n- ${match.p1} vs. ${match.p2}`;
                }

                await interaction.editReply({
                    content: msg
                });

                break;
            }
            case "pickems": {
                if (!interaction.channel) {
                    await interaction.editReply({
                        content: "This is not a channel."
                    });
                    return;
                }

                const week = options.getInteger("week") || 0;

                const category = await getChannelCategory(interaction);
                if (!category) {
                    return;
                }

                const sheet = await DraftSheet.from_category(category.id);
                if (sheet === undefined) {
                    await interaction.editReply({
                        content: "This channel category/group does not belong to a league. Use '/league start' first."
                    });
                    return;
                }
                await sheet.load_from_db();
                await sheet.load_players(true);

                if (week <= 0 || week > sheet.setup.weeks) {
                    await interaction.editReply({
                        content: "No week exists for that number."
                    });
                    return;
                }

                const schedule = await sheet.get_schedule(week);

                await interaction.editReply({
                    content: `## PICKEMS WEEK ${week}`
                });

                for (const match of schedule) {
                    const p1 = sheet.find_player(match.p1);
                    const p2 = sheet.find_player(match.p2);
                    if (p1 && p2) {
                        const imagePath = await createPickems(p1, p2);
                        const msg = await interaction.channel.send({
                            content: `${match.p1} vs. ${match.p2}`,
                            files: [{ attachment: imagePath }]
                        });
                        await msg?.react("🔵");
                        await msg?.react("🟠");
                    } else {
                        await interaction.channel.send({
                            content: `Failed to make pickems for ${match.p1} vs. ${match.p2}`
                        });
                    }
                }

                break;
            }
            case "draft": {
                if (!interaction.channel) {
                    await interaction.editReply({
                        content: "This is not a channel."
                    });
                    return;
                }

                const category = await getChannelCategory(interaction);
                if (!category) {
                    return;
                }

                const sheet = await DraftSheet.from_category(category.id);
                if (sheet === undefined) {
                    await interaction.editReply({
                        content: "This channel category/group does not belong to a league. Use '/league start' first."
                    });
                    return;
                }
                const rowsAdded = await sheet.load_draft_board_to_db();
                console.log(rowsAdded);

                break;
            }
            case "tier": {
                return await interaction.reply(await createTierPayload(1));
            }
            case "test": {
                const p1 = {
                    number: 1,
                    name: "Tom Campbell",
                    teamName: "Central Coast Clawitzers",
                    team: ["Iron Valiant", "Gyarados", "Jirachi", "Raging Bolt", "Talonflame", "Glimmora", "Ursaluna", "Thwackey", "Araquanid", "Malamar"]
                }
                const p2 = {
                    number: 2,
                    name: "Forte Darkscale",
                    teamName: "Roaring Knights",
                    team: ["Iron Valiant", "Ting-Lu", "Primarina", "Pecharunt", "Rillaboom", "Talonflame", "Zygarde-10%", "Magnezone", "Ariados", "Registeel"]
                }
                const imagePath = await createPickems(p1, p2);
                /*
                const msg = await interaction.channel?.send({
                    content: `**${p1.name} vs. ${p2.name}**`,
                    files: [{ attachment: imagePath }]
                });
                await msg?.react("🔵");
                await msg?.react("🟠");
                */
            }
        }
    },
} as Command;