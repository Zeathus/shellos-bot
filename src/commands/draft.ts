import {
    CommandInteractionOptionResolver,
    CommandInteraction,
    ChannelType,
    GuildTextBasedChannel,
    GuildChannel,
    GuildMemberRoleManager,
} from "discord.js";
import { Command } from "../types/index.js";
import DraftSheet, { addedDraftMinutesEachPick, DraftPlayer, DraftPokemonFlag, LeagueStatus } from "../types/DraftSheet.js";
import { getChannelCategory } from "./league.js";
import { sheets_v4 } from "googleapis";
import { columnToLetter } from "../utils/pokemon.js";
import { channel } from "diagnostics_channel";

const promises: { [ id: number ] : boolean } = {}

export default {
    name: "draft",
    description:
        "Draft a pokemon.",
    options: [
        {
            name: "pokemon",
            description: "The pokemon to draft",
            type: 3,
            required: true,
            autocomplete: true,
        }
    ],
    async execute(
        interaction: CommandInteraction,
        options: CommandInteractionOptionResolver
    ) {
        await interaction.reply("Working...");

        if (!interaction.channel) {
            await interaction.editReply({
                content: "This is not a channel."
            });
            return;
        }

        const pokemonName = options.getString("pokemon");
        if (!pokemonName) {
            await interaction.editReply("You need to specify a Pokémon.");
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

        if (promises[sheet.id || 0]) {
            await interaction.editReply("Please wait for the previous draft command to finish.");
            return;
        }

        promises[sheet.id || 0] = true;

        await sheet.load_from_db();

        if (sheet.status !== LeagueStatus.DRAFTING) {
            promises[sheet.id || 0] = false;
            await interaction.editReply("The draft has not started. A moderator must first run `/league startdraft`.");
            return;
        }

        await sheet.load_players(false);

        const getNextDrafter = async () => {
            let smallestTeamSize = 10;
            for (const p of sheet.players) {
                p.team = await sheet.load_team(p.number, p.name);
                if (p.team.length < smallestTeamSize) {
                    smallestTeamSize = p.team.length;
                }
            }
            if (smallestTeamSize >= 10) {
                return undefined;
            }
            let firstSmallest: DraftPlayer | undefined = undefined;
            let lastSmallest: DraftPlayer | undefined = undefined;
            for (const p of sheet.players) {
                if (p.team.length === smallestTeamSize) {
                    if (firstSmallest === undefined || p.number < firstSmallest.number) {
                        firstSmallest = p;
                    }
                    if (lastSmallest === undefined || p.number > lastSmallest.number) {
                        lastSmallest = p;
                    }
                }
            }
            if (smallestTeamSize % 2 === 0) {
                return firstSmallest;
            } else {
                return lastSmallest;
            }
        };

        const modRole = await sheet.get_mod_role();
        let moderator: string | undefined = undefined;
        let player: DraftPlayer | undefined = undefined;
        if (modRole && ((interaction.member?.roles) as GuildMemberRoleManager).cache.has(modRole)) {
            moderator = interaction.user.id;
            player = await getNextDrafter();
            if (!player) {
                promises[sheet.id || 0] = false;
                await interaction.editReply("There are no more players to draft for.");
                return;
            }
            if (player.discordId === moderator) {
                moderator = undefined;
            }
        } else {
            for (const p of sheet.players) {
                if (p.discordId === interaction.user.id) {
                    player = p;
                    break;
                }
            }
            if (!player) {
                promises[sheet.id || 0] = false;
                await interaction.editReply("You're not registered in this league.");
                return;
            }
        }

        player.team = await sheet.load_team(player.number, player.name);

        const snakeDirection = (player.team.length % 2 == 0) ? 1 : -1;
        if (player.number !== 1 || player.team.length !== 0) {
            let prevPlayer = undefined;
            for (const p of sheet.players) {
                let prevNumber = player.number - snakeDirection;
                if (prevNumber < 1) {
                    prevNumber = 2;
                } else if (prevNumber > sheet.setup.players) {
                    prevNumber = sheet.setup.players - 1;
                }
                if (p.number === prevNumber) {
                    prevPlayer = p;
                    break;
                }
            }
            if (!prevPlayer) {
                promises[sheet.id || 0] = false;
                await interaction.editReply(`An unknown error occurred (1).`);
                return;
            }
            prevPlayer.team = await sheet.load_team(prevPlayer.number, prevPlayer.name);
            if (prevPlayer.team.length <= player.team.length && (
                !(prevPlayer.team.length === player.team.length && (
                    (snakeDirection === 1 && player.number === 1) ||
                    (snakeDirection === -1 && player.number === sheet.setup.players)
                ))
            )) {
                promises[sheet.id || 0] = false;
                await interaction.editReply(`It's not your turn to draft.`);
                return;
            }
        }

        if (player.team.length >= 10) {
            promises[sheet.id || 0] = false;
            await interaction.editReply("You have already drafted all your Pokémon.");
            return;
        }

        const pokemon = await sheet.get_draft_board_pokemon(pokemonName);
        if (!pokemon || (pokemon.flags & DraftPokemonFlag.BANNED)) {
            promises[sheet.id || 0] = false;
            await interaction.editReply(`${pokemonName} is not a legal Pokémon.`);
            return;
        }

        if (pokemon.flags & DraftPokemonFlag.DRAFTED) {
            promises[sheet.id || 0] = false;
            await interaction.editReply(`${pokemon.name} has already been drafted.`);
            return;
        }

        const sheets = await sheet.get_sheets();
        const result = sheets.spreadsheets.values.get({
            spreadsheetId: sheet.sheet_id,
            range: `'Team Data'!L${2 + player.number}`,
        })
        const rows = (await result).data.values;
        if (!rows || rows.length === 0) {
            promises[sheet.id || 0] = false;
            await interaction.editReply(`Failed to get remaining budget.`);
            return;
        }
        const remainingBudget = parseInt(rows[0][0]);

        if (remainingBudget < pokemon.cost) {
            promises[sheet.id || 0] = false;
            await interaction.editReply(`You don't have enough points to draft ${pokemon.name} (${pokemon.cost} points). You have ${remainingBudget} points.`);
            return;
        }

        let realTeamLength = 0;
        for (const pkmn of player.team) {
            if (pkmn && pkmn.name !== "" && pkmn.name !== "-") {
                realTeamLength += 1;
            }
        }
        if (remainingBudget - (9 - realTeamLength) < pokemon.cost) {
            promises[sheet.id || 0] = false;
            await interaction.editReply(`If you draft ${pokemon.name} (${pokemon.cost} points), you don't have enough points for a team of 10 Pokémon. You have ${remainingBudget} points.`);
            return;
        }

        const resource: sheets_v4.Schema$BatchUpdateValuesRequest = {
            data: [
                {
                    range: `'Team Data'!${columnToLetter(1 + player.team.length)}${2 + player.number}`,
                    values: [[ pokemon.name ]]
                }
            ],
            valueInputOption: "RAW"
        }

        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheet.sheet_id,
            resource
        } as sheets_v4.Params$Resource$Spreadsheets$Values$Batchupdate);

        const getDisplayName = (p: DraftPlayer) => {
            if (p.discordId && p.discordId.length > 2) {
                return `<@${p.discordId}>`;
            } else {
                return p.name;
            }
        }

        if (moderator) {
            let minRemaining = await sheet.get_player_draft_timer(player.number);
            await sheet.set_player_draft_timer(player.number, minRemaining + addedDraftMinutesEachPick);
            await interaction.editReply({
                content: `${getDisplayName(player)} drafted ${pokemon.name} for ${pokemon.cost} points. (Pick by <@${moderator}>)\nThey have ${remainingBudget - pokemon.cost} points remaining.`,
                files: [{ attachment: `${process.env.IMAGE_PATH}/pokemon/${pokemon.name}.png` }]
            });
        } else {
            let msg = `${getDisplayName(player)} drafted ${pokemon.name} for ${pokemon.cost} points.\nThey have ${remainingBudget - pokemon.cost} points remaining.`;

            const timeNow = Date.now();
            let pickStartTime = await sheet.get_player_pick_start(player.number);
            let minRemaining = await sheet.get_player_draft_timer(player.number);
            const minutesElapsed = Math.floor((timeNow - pickStartTime) / 60000);
            minRemaining -= minutesElapsed;
            minRemaining += addedDraftMinutesEachPick;
            let hours = 0;

            await sheet.set_player_draft_timer(player.number, minRemaining);

            while (minRemaining > 60) {
                minRemaining -= 60;
                hours += 1;
            }
            if (hours > 0) {
                msg += `\nThey have ${hours} ${hours === 1 ? "hour" : "hours"} and ${minRemaining} ${minRemaining === 1 ? "minute" : "minutes"} for your next pick.`;
            } else {
                msg += `\nThey have ${minRemaining} ${minRemaining === 1 ? "minute" : "minutes"} for your next pick.`;
            }

            await interaction.editReply({
                content: msg,
                files: [{ attachment: `${process.env.IMAGE_PATH}/pokemon/${pokemon.name}.png` }]
            });
        }

        await sheet.set_pokemon_drafted(pokemon.name);

        let nextPlayer = undefined;
        for (const p of sheet.players) {
            let nextNumber = player.number + snakeDirection;
            if (nextNumber < 1) {
                nextNumber = 1;
            } else if (nextNumber > sheet.setup.players) {
                nextNumber = sheet.setup.players;
            }
            if (p.number === nextNumber) {
                nextPlayer = p;
                break;
            }
        }
        if (!nextPlayer) {
            promises[sheet.id || 0] = false;
            await interaction.channel.send(`An unknown error occurred when finding the next player to draft.`);
            return;
        }
        if (nextPlayer.team.length >= 10 || (nextPlayer == player && player.team.length >= 9)) {
            await sheet.set_status(LeagueStatus.ACTIVE);
            await interaction.channel.send("# The draft is complete!");
        } else {
            const result = sheets.spreadsheets.values.get({
                spreadsheetId: sheet.sheet_id,
                range: `'Team Data'!L${2 + nextPlayer.number}`,
            })
            const rows = (await result).data.values;
            if (!rows || rows.length === 0) {
                promises[sheet.id || 0] = false;
                await interaction.editReply(`Failed to get remaining budget.`);
                return;
            }
            const nextRemainingBudget = parseInt(rows[0][0]);

            nextPlayer.team = await sheet.load_team(nextPlayer.number, nextPlayer.name);

            let msg = "";
            if (nextPlayer.discordId && nextPlayer.discordId.length > 2) {
                msg += `Next to draft is <@${nextPlayer.discordId}>!`
            } else {
                msg += `Next to draft is ${nextPlayer.name}!\nThe coach does not have a discord user linked.`
            }

            msg += `\nYou have ${nextRemainingBudget} points to draft ${10 - nextPlayer.team.length} more Pokémon.`

            let minRemaining = await sheet.get_player_draft_timer(nextPlayer.number);
            let hours = 0;

            while (minRemaining > 60) {
                minRemaining -= 60;
                hours += 1;
            }
            if (hours > 0) {
                msg += `\nYou have ${hours} ${hours === 1 ? "hour" : "hours"} and ${minRemaining} ${minRemaining === 1 ? "minute" : "minutes"} to pick.`;
            } else {
                msg += `\nYou have ${minRemaining} ${minRemaining === 1 ? "minute" : "minutes"} to pick.`;
            }

            await interaction.channel.send(msg);
            await sheet.set_player_pick_start(nextPlayer.number, Date.now());
        }

        promises[sheet.id || 0] = false;
    },
} as Command;