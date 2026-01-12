// Importing required modules
import * as dotenv from "dotenv";
import axios from "axios";
import { Message, GuildMember, PermissionResolvable, REST, TextChannel, Events } from "discord.js";
import { ActivityType, ChannelType, Routes } from "discord-api-types/v10";
import {
    client,
    Prisma,
    ReplayTracker,
    LiveTracker,
    sockets,
    commands,
    update,
} from "./utils/index.js";
import { Battle, Command, Stats } from "./types/index.js";
import DraftSheet, { createTierPayload, DraftPlayer, registerElo } from "./types/DraftSheet.js";
import { draftablePokemon } from "./utils/pokemon.js";
import { ChildProcess } from "child_process";
import { CronJob } from "cron";

// Setting things up
dotenv.config();

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN || "");
(async () => {
  try {
    console.log('Started refreshing application (/) commands.');
    await rest.put(
        Routes.applicationGuildCommands('1357857239901405214', '1118327241970028624'),
        { body: Array.from(commands.values()) },
    );
    console.log('Successfully reloaded application (/) commands.');
  } catch (error) {
    console.error(error);
  }
})();

// When the client boots up
client.on("ready", () => {
    console.log(`${client.user!.username} is online!`);
    client.user!.setActivity(
        `${Battle.numBattles} PS Battles in ${client.guilds.cache.size} servers.`,
        {
            type: ActivityType.Watching,
        }
    );
});

client.on("guildCreate", () => {
    client.user!.setActivity(
        `${Battle.numBattles} PS Battles in ${client.guilds.cache.size} servers.`,
        {
            type: ActivityType.Watching,
        }
    );
});

client.on("guildDelete", () => {
    client.user!.setActivity(
        `${Battle.numBattles} PS Battles in ${client.guilds.cache.size} servers.`,
        {
            type: ActivityType.Watching,
        }
    );
});

client.on("interactionCreate", async (interaction) => {
    if (interaction.isAutocomplete()) {
        const command = interaction.commandName;
        if (command === "draft") {
            const focusedValue = interaction.options.getFocused().toLowerCase();
            const filtered = [];
            for (const pokemon of draftablePokemon) {
                if (pokemon.toLowerCase().startsWith(focusedValue)) {
                    filtered.push({
                        name: pokemon,
                        value: pokemon
                    })
                }
                if (filtered.length >= 10) {
                    break;
                }
            }
            if (filtered.length < 10) {
                for (const pokemon of draftablePokemon) {
                    if (!pokemon.toLowerCase().startsWith(focusedValue) && pokemon.toLowerCase().includes(focusedValue)) {
                        filtered.push({
                            name: pokemon,
                            value: pokemon
                        })
                    }
                    if (filtered.length >= 10) {
                        break;
                    }
                }
            }
            interaction.respond(filtered);
        }
    } else if (interaction.isCommand()) {
        //Getting info from the message if it's not a live link
        const commandName = interaction.commandName;
        const options = interaction.options;

        //Getting the actual command
        const command = commands.get(commandName);
        if (!command) return;

        //Running the command
        await command.execute(interaction, options);
    } else if (
        (interaction.isButton() || interaction.isStringSelectMenu()) &&
        interaction.message.interaction
    ) {
        const commandName = interaction.message.interaction.commandName;
        
        if (commandName == "league tier") {
            const params = interaction.customId.split("|");
            console.log(`${params[1]} ${params[2]} ${params[3]}`);
            await registerElo(params[1], params[3], params[2], interaction.user.username);
            await interaction.update(await createTierPayload(parseInt(params[0]) + 1));
            return;
        }

        const command = commands.get(commandName);
        if (!(command && command.buttonResponse)) return;

        await command.buttonResponse(interaction);
    }
});

//When a message is sent at any time
const messageFunction = async (message: Message) => {
    const channel = message.channel;
    const msgStr = message.content;
    const prefix = "porygon, use ";

    if (message.author.bot) return;

    const hasSendMessages = !(
        channel.isDMBased() ||
        channel
            .permissionsFor(message.guild?.members.me as GuildMember)
            .has("SendMessages" as PermissionResolvable)
    );

    //If it's a DM, analyze the replay
    if (channel.isDMBased()) {
        if (
            msgStr.includes("replay.pokemonshowdown.com") &&
            message.author.id !== client.user!.id
        ) {
            //Extracting URL
            const urlRegex = /(https?:\/\/[^ ]*)/;
            const links = msgStr.match(urlRegex);
            let link = "";
            if (links) link = links[0];

            let response = await axios
                .get(link + ".log", {
                    headers: { "User-Agent": "PorygonTheBot" },
                })
                .catch((e) => console.error(e));
            let data = response?.data;

            //Getting the rules
            let rules = await Prisma.getRules(channel.id);

            //Analyzing the replay
            let replayer = new ReplayTracker(link, rules);
            const matchJson = await replayer.track(data);

            await channel.send(JSON.stringify(matchJson));
            console.log(`${link} has been analyzed!`);
        }
    }
    else if ((channel.name.includes("replay") || channel.name.includes("secret") || channel.name.includes("stats")) && channel.type == ChannelType.GuildText) {
        try {
            const urlRegex = /(https?:\/\/[^ ]*)/;
            const msgStrLower = msgStr.toLowerCase();
            const links = msgStr.match(urlRegex);
            let replayLink = "";
            if (links) {
                replayLink = links[0];

                // Checks if bot has send messages perms
                const hasSendMessages =
                    channel &&
                    !channel.isDMBased() &&
                    channel
                        .permissionsFor(channel.guild?.members.me as GuildMember)
                        .has("SendMessages" as PermissionResolvable);
                if (!hasSendMessages) {
                    await channel.send(
                        ":x: I can't send messages in this channel."
                    );
                    return;
                }

                // Discord interaction message limit is 2000, so if it errors, it has to error properly
                if (replayLink.length >= 1950) {
                    return;
                }

                // Checks if given link is a valid replay
                if (!(replayLink.includes("replay") && links)) {
                    return;
                }

                const botMsg = await channel.send("Analyzing...");

                // EXTRA CODE FOR POKEATHLON ONLY
                if (replayLink.includes("pokeathlon")) {
                    const replayID = replayLink.split("=")[1]
                    replayLink = "https://sim.pokeathlon.com/replays/" + replayID;
                }

                // Gets the replay plog
                let link = replayLink + ".log";
                let response = await axios
                    .get(link, {
                        headers: { "User-Agent": "PorygonTheBot" },
                    })
                    .catch(async (e) => {
                        await botMsg.edit(
                            ":x: Something went wrong. Please check your replay link."
                        );
                        return;
                    });
                if (!(response && channel)) {
                    await botMsg.edit(
                        ":x: Something went wrong. Please check your replay link."
                    );
                    return;
                }
                let data = response.data;

                //Getting the rules
                let rules = await Prisma.getRules(channel?.id as string);

                // Starts analyzing
                let replayer = new ReplayTracker(replayLink, rules);
                const matchJson = await replayer.track(data);

                // Any error
                if (matchJson.error) {
                    await botMsg.edit(matchJson.error);
                    return;
                }

                const result = await DraftSheet.register_match(channel.id, matchJson);
                if (result.msg) {
                    await botMsg.edit(result.msg);
                }
                // Updates
                /*
                await update(
                    matchJson,
                    channel as TextChannel,
                    message.author
                );
                */
                console.log(`${link} has been analyzed!`);
            } else if (msgStrLower.includes(" vs ") || msgStrLower.includes(" vs. ")) {
                const botMsg = await channel.send("Processing...");

                const lines = msgStrLower.split("\n");
                let playerNames = undefined;
                if (lines[0].includes(" vs ")) {
                    playerNames = lines[0].split(" vs ");
                } else if (lines[0].includes(" vs. ")) {
                    playerNames = lines[0].split(" vs. ");
                }
                if (!playerNames) {
                    await botMsg.edit("Failed to find player names at the start of the message. Make sure the first line of the message is in the form of `Player1 vs. Player2`");
                    return;
                }
                playerNames = [playerNames[0].trim(), playerNames[1].trim()]

                const category = channel.parentId;
                if (!category) {
                    await botMsg.edit("This channel is not part of a category.");
                    return;
                }

                const sheet = await DraftSheet.from_category(category)
                if (!sheet) {
                    await botMsg.edit("This channel is not part of a draft league.");
                    return;
                }

                await sheet.load_from_db();
                await sheet.load_players(false);
                const players: (DraftPlayer | undefined)[] = [undefined, undefined];
                for (const player of sheet.players) {
                    if (player.name.toLowerCase() === playerNames[0]) {
                        player.team = await sheet.load_team(player.number, player.name);
                        players[0] = player;
                    } else if (player.name.toLowerCase() === playerNames[1]) {
                        player.team = await sheet.load_team(player.number, player.name);
                        players[1] = player;
                    }
                }
                if (!players[0]) {
                    await botMsg.edit(`**Failed to process match:**\n'${playerNames[0]}' is not the name of a player in this league.`);
                    return;
                }
                if (!players[1]) {
                    await botMsg.edit(`**Failed to process match:**\n'${playerNames[1]}' is not the name of a player in this league.`);
                    return;
                }

                const team1: {name?: string, killer?: string, error?: string}[] = [];
                const team2: {name?: string, killer?: string, error?: string}[] = [];
                let currentPlayer = -1;

                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].toLowerCase().replace("|", "").replace("*", "").trim();

                    const headerRegex = new RegExp(`(${playerNames[0]}|${playerNames[1]})'?s? *(team)?:?`);
                    const header = line.match(headerRegex);
                    if (header) {
                        if (header[1] === playerNames[0]) {
                            currentPlayer = 0;
                            continue;
                        } else if (header[1] === playerNames[1]) {
                            currentPlayer = 1;
                            continue;
                        }
                    }
                    const defeatRegex = /([a-z\-0-9' :é]+) *(was|is|got) *(kod|ko'd|koed|ko'ed|defeated|dies|died|slain|fainted) *(to|by|from) *([a-z\-0-9' :é]+)\.?/;
                    const defeatRegex2 = /([a-z\-0-9' :é]+) *()(kod|ko'd|koed|ko'ed|defeated|dies|died|slain|fainted) *(to|by|from) *([a-z\-0-9' :é]+)\.?/;
                    const defeat = line.match(defeatRegex) || line.match(defeatRegex2);
                    const pokemon: {name?: string, killer?: string, error?: string} = {
                        name: undefined,
                        killer: undefined,
                        error: undefined
                    }
                    if (defeat) {
                        pokemon.name = defeat[1].trim();
                        pokemon.killer = defeat[5].trim();
                    } else {
                        const surviveRegex = /([a-z\-0-9' :é]+) *(survives|survived|lives|lived|remains|remained)\.?$/;
                        const surviveRegex2 = /([a-z\-0-9' :é]+)\.?$/;
                        const survive = line.match(surviveRegex) || line.match(surviveRegex2);
                        if (survive) {
                            pokemon.name = survive[1].trim();
                        }
                    }

                    if (!pokemon.name) {
                        continue;
                    }

                    if (currentPlayer === -1) {
                        if (team1.length < 6) {
                            team1.push(pokemon);
                        } else {
                            team2.push(pokemon);
                        }
                    } else if (currentPlayer === 0) {
                        team1.push(pokemon);
                    } else if (currentPlayer === 1) {
                        team2.push(pokemon);
                    }
                }
                for (let i = 0; i < team1.length; i++) {
                    const pokemonName = team1[i].name || "nomatch";
                    team1[i].error = `There is no Pokémon matching '${team1[i].name}' on ${playerNames[0]}'s roster`;
                    // Check for exact matches
                    for (const member of players[0].team) {
                        if (member.name.toLowerCase() === pokemonName) {
                            team1[i].name = member.name;
                            team1[i].error = undefined;
                            break;
                        }
                    }
                    // Check for partial exact matches
                    if (team1[i].error) {
                        for (const member of players[0].team) {
                            if (member.name.toLowerCase().includes(pokemonName)) {
                                team1[i].name = member.name;
                                if (team1[i].error) {
                                    team1[i].error = undefined;
                                } else {
                                    team1[i].error = `'${pokemonName}' matches with more than one Pokémon. The name has to be more specific.`;
                                    break;
                                }
                            }
                        }
                    }
                    if (team1[i].error) {
                        continue;
                    }
                    if (team1[i].killer) {
                        const killerName = team1[i].killer || "nomatch";
                        team1[i].error = `There is no Pokémon matching '${team1[i].killer}' on ${playerNames[1]}'s roster`;
                        // Check for exact matches
                        for (const member of players[1].team) {
                            if (member.name.toLowerCase() === killerName) {
                                team1[i].killer = member.name;
                                team1[i].error = undefined;
                                break;
                            }
                        }
                        // Check for partial exact matches
                        if (team1[i].error) {
                            for (const member of players[1].team) {
                                if (member.name.toLowerCase().includes(killerName)) {
                                    team1[i].killer = member.name;
                                    if (team1[i].error) {
                                        team1[i].error = undefined;
                                    } else {
                                        team1[i].error = `'${killerName}' matches with more than one Pokémon. The name has to be more specific.`;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                for (let i = 0; i < team2.length; i++) {
                    const pokemonName = team2[i].name || "nomatch";
                    team2[i].error = `There is no Pokémon matching '${team2[i].name}' on ${playerNames[1]}'s roster`;
                    // Check for exact matches
                    for (const member of players[1].team) {
                        if (member.name.toLowerCase() === pokemonName) {
                            team2[i].name = member.name;
                            team2[i].error = undefined;
                            break;
                        }
                    }
                    // Check for partial exact matches
                    if (team2[i].error) {
                        for (const member of players[1].team) {
                            if (member.name.toLowerCase().includes(pokemonName)) {
                                team2[i].name = member.name;
                                if (team2[i].error) {
                                    team2[i].error = undefined;
                                } else {
                                    team2[i].error = `'${pokemonName}' matches with more than one Pokémon. The name has to be more specific.`;
                                    break;
                                }
                            }
                        }
                    }
                    if (team2[i].error) {
                        continue;
                    }
                    if (team2[i].killer) {
                        const killerName = team2[i].killer || "nomatch";
                        team2[i].error = `There is no Pokémon matching '${team2[i].killer}' on ${playerNames[0]}'s roster`;
                        // Check for exact matches
                        for (const member of players[0].team) {
                            if (member.name.toLowerCase() === killerName) {
                                team2[i].killer = member.name;
                                team2[i].error = undefined;
                                break;
                            }
                        }
                        // Check for partial exact matches
                        if (team2[i].error) {
                            for (const member of players[0].team) {
                                if (member.name.toLowerCase().includes(killerName)) {
                                    team2[i].killer = member.name;
                                    if (team2[i].error) {
                                        team2[i].error = undefined;
                                    } else {
                                        team2[i].error = `'${killerName}' matches with more than one Pokémon. The name has to be more specific.`;
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                const errorMsgs = [];
                for (const member of team1) {
                    if (member.error) {
                        errorMsgs.push(member.error);
                    }
                }
                for (const member of team2) {
                    if (member.error) {
                        errorMsgs.push(member.error);
                    }
                }
                if (errorMsgs.length > 0) {
                    await botMsg.edit(`**Failed to process match:**\n${errorMsgs.join("\n")}`);
                    return;
                }
                if (team1.length < 6) {
                    await botMsg.edit(`**Failed to process match:**\n${playerNames[0]}'s team does not have 6 Pokémon`);
                    return;
                }
                if (team2.length < 6) {
                    await botMsg.edit(`**Failed to process match:**\n${playerNames[1]}'s team does not have 6 Pokémon`);
                    return;
                }

                const matchJson = {
                    players: {},
                    playerNames: [players[0].name, players[1].name],
                    info: {
                        replay: "",
                        history: "",
                        turns: 0,
                        winner: "",
                        loser: "",
                        rules: {
                            channelId: channel.id,
                            leagueName: "Default",
                            recoil: "D",
                            suicide: "D",
                            abilityitem: "P",
                            selfteam: "N",
                            db: "P",
                            spoiler: true,
                            ping: "",
                            forfeit: "N",
                            format: "D",
                            quirks: true,
                            notalk: false,
                            tb: true,
                            combine: false,
                            redirect: "",
                        },
                        result: "",
                        battleId: ""
                    }
                } as Stats;
                matchJson.players[players[0].name] = {
                    ps: playerNames[0],
                    kills: {},
                    deaths: {}
                }
                matchJson.players[players[1].name] = {
                    ps: playerNames[0],
                    kills: {},
                    deaths: {}
                }
                for (const member of team1) {
                    matchJson.players[players[0].name].kills[member.name || ""] = {
                        count: 0
                    }
                    matchJson.players[players[0].name].deaths[member.name || ""] = {
                        count: member.killer ? 1 : 0,
                        killer: member.killer || ""
                    }
                }
                for (const member of team2) {
                    matchJson.players[players[1].name].kills[member.name || ""] = {
                        count: 0
                    }
                    matchJson.players[players[1].name].deaths[member.name || ""] = {
                        count: member.killer ? 1 : 0,
                        killer: member.killer || ""
                    }
                }
                const result = await DraftSheet.register_match(channel.id, matchJson);
                if (result.msg) {
                    await botMsg.edit(result.msg);
                }
            }
        } catch (err) {
            console.log(err);
        }
    }
    //If it's sent in a validly-named live links channel, join the battle
    /*
    else if (
        (channel.name.includes("live-links") ||
            channel.name.includes("live-battles")) &&
        channel.type == ChannelType.GuildText
    ) {
        try {
            //Extracting battlelink from the message
            const urlRegex = /(https?:\/\/[^ ]*)/;
            const links = msgStr.match(urlRegex);
            let battlelink = "";
            if (links) battlelink = links[0];
            let battleId = battlelink && battlelink.split("/")[3];

            if (Battle.battles.includes(battleId) && battleId !== "") {
                await channel.send(
                    `:x: I'm already tracking battle \`${battleId}\`. If you think this is incorrect, send a replay of this match in the #bugs-and-help channel in the Porygon server.`
                );

                return;
            }

            if (
                battlelink &&
                !(
                    battlelink.includes("google") ||
                    battlelink.includes("replay") ||
                    battlelink.includes("draft-league.nl") ||
                    battlelink.includes("porygonbot.xyz")
                )
            ) {
                let server = Object.values(sockets).filter((socket) =>
                    battlelink.includes(socket.link)
                )[0];
                if (!server) {
                    await channel.send(
                        "This link is not a valid Pokemon Showdown battle url."
                    );

                    return;
                }

                //Getting the rules
                let rules = await Prisma.getRules(channel.id);

                //Check if bot has SEND_MESSAGES perms in the channel
                if (hasSendMessages) {
                    rules.notalk = true;
                }

                console.log("Battle link received.");
                if (!rules.notalk)
                    await channel
                        .send("Joining the battle...")
                        .catch((e: Error) => console.error(e));

                Battle.incrementBattles(battleId);
                client.user!.setActivity(
                    `${Battle.numBattles} PS Battles in ${client.guilds.cache.size} servers.`,
                    {
                        type: ActivityType.Watching,
                    }
                );
                let tracker = new LiveTracker(
                    battleId,
                    server.name,
                    rules,
                    channel,
                    message.author
                );
                await tracker.track();
            }
        } catch (e) {
            console.error(e);
        }
    }
    */

    const args = message.content.slice(prefix.length).trim().split(/ +/);

    // Checks if the Message contains the Prefix at the start.
    if (message.content.toLowerCase().startsWith(prefix)) {
        //Getting info from the message if it's not a live link
        const commandName: string = args.shift()?.toLowerCase() || "";
        if (!commandName) return;

        //Check if bot has SEND_MESSAGES perms in the channel
        if (hasSendMessages) {
            await message.author.send(
                `:x: The command that you tried to run in \`${message.guild?.name}\` did not work because Chatot does not have \`Send Messages\` permissions in the channel.`
            );
            return;
        }

        //Getting the actual command
        const command =
            commands.get(commandName) ||
            commands.find(
                (cmd: Command) =>
                    (cmd.aliases &&
                        cmd.aliases.includes(commandName)) as boolean
            );
        if (!command) return;

        //Running the command
        try {
            await command.execute(message, args, client);
        } catch (error: any) {
            console.error(error);
            message.reply(
                `There was an error trying to execute that command!\n\n\`\`\`${error.stack}\`\`\``
            );
        }
    }
};
client.on("messageCreate", messageFunction);

// Log the client in.
client.login(process.env.TOKEN);

const everyMinute = async () => {
    await DraftSheet.update_ongoing_drafts(client);
}

const everyMinuteJob = new CronJob("5 * * * * *", everyMinute);
everyMinuteJob.start();