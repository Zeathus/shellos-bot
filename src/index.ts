// Importing required modules
import * as dotenv from "dotenv";
import axios from "axios";
import { Message, GuildMember, PermissionResolvable, REST, TextChannel } from "discord.js";
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
import { Battle, Command } from "./types/index.js";
import DraftSheet, { createTierPayload, registerElo } from "./types/DraftSheet.js";
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
    if (interaction.isCommand()) {
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
    else if ((channel.name.includes("replay") || channel.name.includes("secret")) && channel.type == ChannelType.GuildText) {
        try {
            const urlRegex = /(https?:\/\/[^ ]*)/;
            const links = msgStr.match(urlRegex);
            let replayLink = "";
            if (links) replayLink = links[0];

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
