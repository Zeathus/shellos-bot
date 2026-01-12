import {
    CommandInteractionOptionResolver,
    CommandInteraction,
    ChannelType,
    GuildTextBasedChannel,
    GuildChannel,
} from "discord.js";
import { Command } from "../types/index.js";
import DraftSheet, { createPickems, createTierPayload, DraftChannelType, DraftPlayer, getPokemonToTier, LeagueStatus } from "../types/DraftSheet.js";

export const getChannelCategory = async (interaction: CommandInteraction): Promise<GuildChannel | undefined> => {
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
            name: "reload",
            description: "Reload the league and player info for this category from the spreadsheet.",
            type: 1
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
                        },
                        {
                            name: "gamestats",
                            value: "gamestats"
                        },
                        {
                            name: "draft",
                            value: "draft"
                        }
                    ]
                }
            ]
        },
        {
            name: "modrole",
            description: "Set the role to be pinged by the bot when needed.",
            type: 1,
            options: [
                {
                    name: "role",
                    description: "The role to ping.",
                    type: 8,
                    required: true
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
            name: "tier",
            description: "Get prompted to tier pokemon.",
            type: 1
        },
        {
            name: "sheet",
            description: "Post a link to the league's spreadsheet.",
            type: 1
        },
        {
            name: "loaddraftboard",
            description: "Load all draftable pokemon to the database.",
            type: 1
        },
        {
            name: "startdraft",
            description: "Begins drafting for the league, and starts the draft timer.",
            type: 1
        },
        {
            name: "setplayer",
            description: "Connect a discord user to a league player.",
            type: 1,
            options: [
                {
                    name: "coach",
                    description: "The coach's name as listed on the draft doc.",
                    type: 3,
                    required: true
                },
                {
                    name: "user",
                    description: "The discord user to connect.",
                    type: 6,
                    required: true
                }
            ]
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

                const existingSheet = await DraftSheet.from_category(category.id);
                if (existingSheet !== undefined) {
                    await interaction.editReply({
                        content: "This category already has an ongoing league. Use '/league end' first."
                    });
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
            case "reload": {
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
                await sheet.load_from_sheet();
                if (!(await sheet.verify())) {
                    await interaction.editReply({
                        content: `Failed to reload the league. Errors:\n- ${sheet.errors.join("\n- ")}`
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
                    content: `Successfully reloaded league '${sheet.setup.league_name}'!`
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
                    case "gamestats": {
                        type = DraftChannelType.GAME_STATS;
                    }
                    case "draft": {
                        type = DraftChannelType.DRAFT;
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
            case "modrole": {
                if (!interaction.channel) {
                    await interaction.editReply({
                        content: "This is not a channel."
                    });
                    return;
                }

                const role = options.getRole("role") || "";

                if (role === "") {
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

                await sheet.set_mod_role(role.id);

                await interaction.editReply({
                    content: `League mod role set to <@&${role.id}>`
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
                await sheet.load_players(false);

                if (week <= 0 || week > sheet.setup.weeks) {
                    await interaction.editReply({
                        content: "No week exists for that number."
                    });
                    return;
                }

                const playerToString = (name: string, player?: DraftPlayer) => {
                    let playerString = "";
                    if (player && player.discordId) {
                        playerString += `<@${player.discordId}>`;
                    } else {
                        playerString += `${name}`;
                    }
                    if (player && player.timeZone) {
                        playerString += ` (${player.timeZone})`
                    }
                    return playerString;
                }

                const schedule = await sheet.get_schedule(week);
                let msg = `## Week ${week} Schedule`;
                for (const match of schedule) {
                    if (match.p1 == "0" || match.p2 == "0" || match.p1.length === 0 || match.p2.length === 0) {
                        continue;
                    }
                    const player1 = sheet.find_player(match.p1);
                    const player2 = sheet.find_player(match.p2);
                    msg += `\n- ${playerToString(match.p1, player1)} vs. ${playerToString(match.p2, player2)}`;
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
                            content: `## ------------\n🔵 ${match.p1} vs. ${match.p2} 🟠`,
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
            case "loaddraftboard": {
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

                await interaction.editReply(`Loaded ${rowsAdded} Pokémon into the database.`);

                break;
            }
            case "startdraft": {
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
                await sheet.load_from_db();

                if (sheet.status === LeagueStatus.DRAFTING) {
                    await interaction.editReply(`Drafting has already been started.`);
                    return;
                }

                await sheet.load_players(true);
                const missingDiscord = [];
                for (const p of sheet.players) {
                    if (p.team.length > 0) {
                        await interaction.editReply(`To start the draft, make sure all teams in Team Data are empty.`);
                        return;
                    }
                    if (!p.discordId || p.discordId.length < 2) {
                        missingDiscord.push(p.name);
                    }
                }

                if (missingDiscord.length > 0) {
                    await interaction.editReply(`The following coaches don't have a discord user linked, and would not be able to draft:\n- ${missingDiscord.join("\n- ")}\nA moderator must use \`/league setplayer\` to register them.`);
                    return;
                }

                if (!(await sheet.add_channel(interaction.channel.id, DraftChannelType.DRAFT))) {
                    await interaction.editReply({
                        content: "Failed to set channel as the drafting channel for some reason."
                    });
                    return;
                }

                await sheet.load_draft_board_to_db();

                await sheet.reset_draft_timers();

                await sheet.set_status(LeagueStatus.DRAFTING);

                let msg = ""
                if (sheet.players[0].discordId && sheet.players[0].discordId.length > 2) {
                    msg += `The draft has officially started!\nFirst to pick is <@${sheet.players[0].discordId}>.`;
                } else {
                    msg += `The draft has officially started!\nFirst to pick is ${sheet.players[0].name}.`;
                }

                let timeRemaining = await sheet.get_player_draft_timer(sheet.players[0].number);
                let hours = 0;
                while (timeRemaining > 60) {
                    timeRemaining -= 60;
                    hours += 1;
                }
                if (hours > 0) {
                    msg += `\nYou have ${hours} ${hours === 1 ? "hour" : "hours"} and ${timeRemaining} ${timeRemaining === 1 ? "minute" : "minutes"} to pick.`;
                } else {
                    msg += `\nYou have ${timeRemaining} ${timeRemaining === 1 ? "minute" : "minutes"} to pick.`;
                }

                await interaction.editReply(msg);

                break;
            }
            case "tier": {
                return await interaction.reply(await createTierPayload(1));
            }
            case "sheet": {
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

                return await interaction.editReply(`https://docs.google.com/spreadsheets/d/${sheet.sheet_id}`);
            }
            case "setplayer": {
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

                await sheet.load_from_db();
                await sheet.load_players(false);

                const coach = options.getString("coach");
                const user = options.getUser("user");

                if (!coach || !user) {
                    await interaction.editReply({
                        content: "The command requires both a coach and a discord user."
                    });
                    return;
                }

                let player: DraftPlayer | undefined = undefined;
                for (const p of sheet.players) {
                    if (p.name.toLowerCase().trim() === coach?.toLowerCase().trim()) {
                        player = p;
                        break;
                    }
                }

                if (player === undefined) {
                    await interaction.editReply({
                        content: `Could not find a coach with the name '${coach}'.`
                    });
                    return;
                }

                player.discordId = user.id;
                
                if (!(await sheet.save())) {
                    await interaction.editReply({
                        content: `Failed to save the league for unknown reasons.`
                    });
                    return;
                }

                return await interaction.editReply(`Successfully set user for coach ${coach}`);
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
                //const imagePath = await createPickems(p1, p2);
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