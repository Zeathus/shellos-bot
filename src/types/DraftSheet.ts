import { google, sheets_v4 } from "googleapis";
import { resolve } from "path";
import { Jimp, loadFont, HorizontalAlign, VerticalAlign } from "jimp";
import { SANS_32_WHITE } from "jimp/fonts"
import fs from "fs";
import sqlite3 from 'sqlite3';
import Stats from "./Stats.js";
import axios from "axios";
const db = new sqlite3.Database("database.sqlite");

db.serialize(() => {
    // Ensure database tables
    db.run("CREATE TABLE IF NOT EXISTS League (league_id integer PRIMARY KEY AUTOINCREMENT, status integer, name varchar(255), budget integer, players integer, weeks integer, sheet_id varchar(255))");
    db.run("CREATE TABLE IF NOT EXISTS LeagueCategory (category varchar(127) PRIMARY KEY, league_id integer)");
    db.run("CREATE TABLE IF NOT EXISTS LeaguePlayer (player_id integer PRIMARY KEY AUTOINCREMENT, league_id integer, player_number integer, name varchar(255), team_name varchar(255), time_zone varchar(32), showdown_name varchar(255), showdown_key varchar(255), discord_id varchar(255))");
    db.run("CREATE TABLE IF NOT EXISTS LeagueChannel (channel varchar(127) PRIMARY KEY, league_id integer, channel_type integer)");
    db.run("CREATE TABLE IF NOT EXISTS LeagueDraftBoard (league_id integer, pokemon varchar(63), cost integer, github_name varchar(63), flags integer, PRIMARY KEY (league_id, pokemon))");
    db.run("CREATE TABLE IF NOT EXISTS LeagueDraftTimer (league_id integer, player_id integer, pick_start integer, minutes integer, PRIMARY KEY (league_id, player_id))");
    db.run("CREATE TABLE IF NOT EXISTS LeagueDraftSkip (league_id integer, player_id integer, pick_number integer, PRIMARY KEY (league_id, player_id, pick_number))");
    db.run("CREATE TABLE IF NOT EXISTS LeagueGroup (league_id integer, group_type integer, discord_id_type integer, discord_id varchar(127), PRIMARY KEY (league_id, discord_id_type, discord_id))");
    db.run("CREATE TABLE IF NOT EXISTS PokemonELO (pokemon varchar(63), elo integer DEFAULT 1000, matches integer DEFAULT 0, PRIMARY KEY (pokemon))");
    db.run("CREATE TABLE If NOT EXISTS ELOContributor (user varchar(127), contributions integer DEFAULT 0, PRIMARY KEY (user))");

    // Ensure indexes exist
    db.run("CREATE INDEX IF NOT EXISTS League_sheet_id ON League (sheet_id)");
    db.run("CREATE INDEX IF NOT EXISTS LeagueCategory_league_id ON LeagueCategory (league_id)");
    db.run("CREATE INDEX IF NOT EXISTS LeaguePlayer_league_id ON LeaguePlayer (league_id)");
    db.run("CREATE INDEX IF NOT EXISTS LeaguePlayer_showdown_key ON LeaguePlayer (showdown_key)");
    db.run("CREATE INDEX IF NOT EXISTS LeagueChannel_league_id ON LeagueChannel (league_id)");
    db.run("CREATE INDEX IF NOT EXISTS PokemonELO_elo ON PokemonELO (elo)");
    db.run("CREATE INDEX IF NOT EXISTS PokemonELO_matches ON PokemonELO (matches)");
});

export async function getPokemonToTier() {
    const pokemon_a =  await new Promise<string | undefined>((resolve, reject) => {
        db.get("SELECT pokemon FROM PokemonELO ORDER BY matches ASC, RANDOM() LIMIT 1", [], (err, row: any) => {
            if (err) {
                throw err;
            }
            if (row) {
                resolve(row.pokemon);
            }
            resolve(undefined);
        });
    });
    const elo_a = await getELORating(pokemon_a || "");
    const pokemon_b =  await new Promise<string | undefined>((resolve, reject) => {
        db.get("SELECT pokemon FROM PokemonELO WHERE pokemon != ? ORDER BY (-LOG(1.0 - (0.5 - RANDOM() / CAST(-9223372036854775808 AS REAL) / 2)) / (1 + (CAST(ABS(elo - ?) AS REAL) / 100))) DESC LIMIT 1", [pokemon_a, elo_a], (err, row: any) => {
            if (err) {
                throw err;
            }
            if (row) {
                resolve(row.pokemon);
            }
            resolve(undefined);
        });
    });
    return [pokemon_a, pokemon_b];
}

async function getELORating(pokemon: string) {
    return await new Promise<number | undefined>((resolve, reject) => {
        db.get("SELECT elo FROM PokemonELO WHERE pokemon = ?", [pokemon], (err, row: any) => {
            if (err) {
                throw err;
            }
            if (row) {
                resolve(row.elo);
            }
            resolve(undefined);
        });
    });
}

async function setELORating(pokemon: string, elo: number) {
    return await new Promise<boolean>((resolve, reject) => {
        db.run("UPDATE PokemonELO SET elo = ?, matches = matches + 1 WHERE pokemon = ?", [elo, pokemon], (err) => {
            if (err) {
                throw err;
            }
            resolve(true);
        });
    });
}

function getRatingDelta(myRating: number, opponentRating: number, myGameResult: number) {
    if ([0, 0.5, 1].indexOf(myGameResult) === -1) {
        return 0;
    }
    
    var myChanceToWin = 1 / ( 1 + Math.pow(10, (opponentRating - myRating) / 400));

    return Math.round(32 * (myGameResult - myChanceToWin));
}

function getNewRating(myRating: number, opponentRating: number, myGameResult: number) {
    return myRating + getRatingDelta(myRating, opponentRating, myGameResult);
}

export async function registerElo(pokemon_a: string, pokemon_b: string, comparator: string, user: string) {
    const elo_a = await getELORating(pokemon_a) || 1000;
    const elo_b = await getELORating(pokemon_b) || 1000;
    const result_a = comparator == ">" ? 1 : (comparator == "<" ? 0 : 0.5);
    const result_b = comparator == ">" ? 0 : (comparator == "<" ? 1 : 0.5);
    const new_elo_a = getNewRating(elo_a, elo_b, result_a);
    const new_elo_b = getNewRating(elo_b, elo_a, result_b);
    await setELORating(pokemon_a, new_elo_a);
    await setELORating(pokemon_b, new_elo_b);
    console.log(`${pokemon_a}'s new rating is ${new_elo_a}`);
    console.log(`${pokemon_b}'s new rating is ${new_elo_b}`);
    return await new Promise<boolean>((resolve, reject) => {
        db.serialize(() => {
            db.run("INSERT OR IGNORE INTO ELOContributor (user) VALUES (?)", [user], (err) => {
                if (err) {
                    throw err;
                }
                resolve(true);
            });
            db.run("UPDATE ELOContributor SET contributions = contributions + 1 WHERE user = ?", [user], (err) => {
                if (err) {
                    throw err;
                }
                resolve(true);
            });
        });
    });
}

export async function createTierPayload(num: number) {
    const pokemonToTier = await getPokemonToTier();
    return {
        content: `Tiering Choice #${num}`,
        components: [
            {
                type: 1,  // ComponentType.ACTION_ROW
                components: [
                    {
                        type: 2,  // ComponentType.BUTTON,
                        custom_id: `${num}|${pokemonToTier[0]}|>|${pokemonToTier[1]}`,
                        label: `${pokemonToTier[0]} >`,
                        style: 1
                    },
                    {
                        type: 2,  // ComponentType.BUTTON,
                        custom_id: `${num}|${pokemonToTier[0]}|=|${pokemonToTier[1]}`,
                        label: "=",
                        style: 2
                    },
                    {
                        type: 2,  // ComponentType.BUTTON,
                        custom_id: `${num}|${pokemonToTier[0]}|<|${pokemonToTier[1]}`,
                        label: `< ${pokemonToTier[1]}`,
                        style: 3
                    }
                ]
            }
        ],
        ephemeral: true,
    }
}

const toShowdownKey = (showdown_name: string | undefined) => {
    if (showdown_name === undefined) {
        return "";
    }
    const re = / /gi;
    return showdown_name.replace(re, "").toLowerCase();
}

const columnToLetter = (column: number) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let columnName = "";
    while (true) {
        columnName = alphabet.charAt((column % alphabet.length)) + columnName;
        column -= column % alphabet.length;
        if (column <= 0) {
            break;
        } else {
            column = Math.floor(column / alphabet.length) - 1;
        }
    }
    return columnName;
}

export enum DraftChannelType {
    GENERIC = 0,
    ANNOUNCEMENTS = 1,
    SCHEDULING = 2,
    REPLAYS = 3,
    PICKEMS = 4,
}

export enum LeagueStatus {
    ACTIVE = 0,
    INACTIVE = 1,
}

export enum LeagueGroupType {
    STANDARD = 0,
    MODERATOR = 1,
}

export enum DiscordIdType {
    USER = 0,
    ROLE = 1,
}

export enum DraftPokemonFlag {
    NONE = 0,
    BANNED = 1,
}

interface DraftPlayer {
    number: number,
    name: string,
    teamName?: string,
    timeZone?: string,
    showdownName?: string,
    discordId?: string,
    team: string[],
}

interface DraftMatch {
    p1: string,
    p2: string,
    week: number,
    match: number,
}

interface DraftBoardPokemon {
    name: string,
    githubName: string,
    cost: number,
    flags: number,
}

export async function createPickems(player1: DraftPlayer, player2: DraftPlayer) {
    const image = await Jimp.read(`${process.env.IMAGE_PATH}/pickems_bg.png`)
    for (let i = 0; i < player1.team.length; i++) {
        const pokemon = player1.team[i];
        const pokemonImage = await Jimp.read(`${process.env.IMAGE_PATH}/pokemon/${pokemon}.png`);
        pokemonImage.resize({w: 128, h: 128});
        image.composite(pokemonImage, 48 + 256 + (i % 5) * 128, 16 + Math.floor(i / 5) * 128);
    }
    for (let i = 0; i < player2.team.length; i++) {
        const pokemon = player2.team[i];
        const pokemonImage = await Jimp.read(`${process.env.IMAGE_PATH}/pokemon/${pokemon}.png`);
        pokemonImage.resize({w: 128, h: 128});
        image.composite(pokemonImage, 16 + (i % 5) * 128, 48 + 256 + 64 + Math.floor(i / 5) * 128);
    }

    const font = await loadFont(`${process.env.IMAGE_PATH}/Cabin-32.fnt`);

    const logoSize = {w: 288, h: 256};

    try {
        const logo1 = await Jimp.read(`${process.env.IMAGE_PATH}/logos/${player1.teamName}.png`);
        if (logo1.width > logo1.height) {
            const ratio = logo1.height / logo1.width;
            logo1.resize({w: logoSize.w, h: Math.floor(logoSize.h * ratio)});
        } else if (logo1.height > logo1.width) {
            const ratio = logo1.width / logo1.height;
            logo1.resize({w: Math.floor(logoSize.w * ratio), h: logoSize.h});
        } else {
            logo1.resize({w: logoSize.h, h: logoSize.h});
        }
        image.composite(logo1,
            16 + ((logoSize.w - logo1.width) / 2),
            16 + ((logoSize.h - logo1.height) / 2)
        );
    } catch (err) {
        console.log(`No logo for ${player1.teamName}`);
        image.print({
            font, x: 16, y: 16,
            text: {text: player1.teamName || "Team", alignmentX: HorizontalAlign.CENTER, alignmentY: VerticalAlign.MIDDLE},
            maxWidth: logoSize.w,
            maxHeight: logoSize.h
        });
    }

    try {
        const logo2 = await Jimp.read(`${process.env.IMAGE_PATH}/logos/${player2.teamName}.png`);
        if (logo2.width > logo2.height) {
            const ratio = (logo2.height / logoSize.h) / (logo2.width / logoSize.w);
            logo2.resize({w: logoSize.w, h: Math.floor(logoSize.h * ratio)});
        } else if (logo2.height > logo2.width) {
            const ratio = (logo2.width / logoSize.w) / (logo2.height / logoSize.h);
            logo2.resize({w: Math.floor(logoSize.w * ratio), h: logoSize.h});
        } else {
            logo2.resize({w: logoSize.h, h: logoSize.h});
        }
        image.composite(
            logo2,
            image.width - 288 - 16 + ((logoSize.w - logo2.width) / 2),
            256 + 64 + 48 + ((logoSize.h - logo2.height) / 2)
        );
    } catch (err) {
        console.log(`No logo for ${player2.teamName}`);
        image.print({
            font, x: image.width - 288 - 16, y: 256 + 64 + 48,
            text: {text: player2.teamName || "Team", alignmentX: HorizontalAlign.CENTER, alignmentY: VerticalAlign.MIDDLE},
            maxWidth: logoSize.w,
            maxHeight: logoSize.h
        });
    }

    image.print({
        font, x: 16, y: image.height / 2 - 112,
        text: {text: player1.name, alignmentX: HorizontalAlign.CENTER, alignmentY: VerticalAlign.BOTTOM},
        maxWidth: 288,
        maxHeight: 128
    });
    image.print({
        font, x: image.width - 48 - 256, y: image.height / 2 - 16,
        text: {text: player2.name, alignmentX: HorizontalAlign.CENTER, alignmentY: VerticalAlign.TOP},
        maxWidth: 288,
        maxHeight: 128
    });
    /*
    image.print({
        font, x: image.width / 2 - 128, y: image.height / 2 - 32,
        text: {text: "VS.", alignmentX: HorizontalAlign.CENTER, alignmentY: VerticalAlign.MIDDLE},
        maxWidth: 256,
        maxHeight: 64
    });
    */

    const imagePath = `${process.env.GENERATED_IMAGE_PATH}/${player1.name} vs ${player2.name}`;
    await image.write(`${imagePath}.png`);

    return `${imagePath}.png`;
}

async function downloadPokemonImages() {
    const pokemonList = await new Promise<{pokemon: string, github_name: string}[]>((resolve, reject) => {
        db.all("SELECT pokemon, github_name FROM LeagueDraftBoard", (err, rows: any) => {
            if (err) {
                throw err;
            }
            resolve(rows);
        });
    });
    for (const pokemon of pokemonList) {
        console.log(pokemon);
        try {
            const response = await axios({
                url: `https://raw.githubusercontent.com/Autumnchi/coloured-gen-9-sprites/main/${pokemon.github_name}.png`,
                method: "GET",
                responseType: "stream"
            });
            const path = `${process.env.IMAGE_PATH}/pokemon/${pokemon.pokemon}.png`;
            const writer = fs.createWriteStream(path);
            response.data.pipe(writer);
            await new Promise((resolve, reject) => {
                writer.on("finish", resolve);
                writer.on("error", reject);
            })
        } catch (err) {
            console.log("Failed to get.");
        }
    }
}

class DraftSheet {
    id?: number;
	sheet_id: string;
    categories: string[];
    setup: {
        league_name: string,
        budget: number,
        players: number,
        weeks: number,
    };
    players: DraftPlayer[];
    errors: string[];
    sheets?: sheets_v4.Sheets;

	constructor(sheet_id: string) {
        this.sheet_id = sheet_id;
        this.categories = [];
        this.setup = {
            league_name: "",
            budget: 0,
            players: 0,
            weeks: 0,
        }
        this.errors = [];
        this.players = [];
        this.sheets = undefined;
	}

    static from_url_and_category(url: string, category: string): DraftSheet | undefined {
        const re = new RegExp("/d/[^/]+");
        const pos = url.search(re);
        if (pos === -1) {
            return undefined;
        }
        const sheet_id = url.substring(pos + 3, url.indexOf("/", pos + 3));
        if (sheet_id.length < 3) {
            return undefined;
        }
        const sheet = new DraftSheet(sheet_id);
        sheet.categories.push(category);
        return sheet;
    }

    static async from_category(category_id: string) {
        return await new Promise<DraftSheet | undefined>((resolve, reject) => {
            db.get("SELECT league_id, sheet_id FROM LeagueCategory JOIN League USING (league_id) WHERE category = ?", [category_id], (err, row: any) => {
                if (err) {
                    throw err;
                }
                if (row) {
                    const sheet = new DraftSheet(row.sheet_id);
                    sheet.id = row.league_id;
                    sheet.categories.push(category_id);
                    resolve(sheet);
                }
                resolve(undefined);
            });
        });
    }

    static async register_match(channel_id: string, matchJson: Stats): Promise<{success: boolean, msg?: string}> {
        const sheet = await new Promise<DraftSheet | undefined>((resolve, reject) => {
            db.get("SELECT league_id, sheet_id FROM LeagueChannel JOIN League USING (league_id) WHERE channel = ?", [channel_id], (err, row: any) => {
                if (err) {
                    throw err;
                }
                if (!row) {
                    resolve(undefined);
                }
                const sheet = new DraftSheet(row.sheet_id);
                sheet.id = row.league_id;
                resolve(sheet);
            });
        });
        if (!sheet) {
            return {success: false};
        }
        const match = await new Promise<DraftMatch | undefined>((resolve, reject) => {
            db.get(
                "SELECT league_id, a.name AS name_a, b.name AS name_b FROM LeaguePlayer a JOIN LeaguePlayer b USING (league_id) WHERE league_id = ? AND a.showdown_key = ? AND b.showdown_key = ?",
                [sheet.id, toShowdownKey(matchJson.playerNames[0]), toShowdownKey(matchJson.playerNames[1])],
                (err, row: any) => {
                    if (err) {
                        throw err;
                    }
                    if (!row) {
                        resolve(undefined);
                    }
                    resolve({
                        p1: row.name_a,
                        p2: row.name_b,
                        week: 0,
                        match: 0,
                    } as DraftMatch)
                }
            )
        });
        if (!match) {
            return {success: false};
        }

        await sheet.prepare_sheets();

        const sheets = await sheet.get_sheets();
        const drive = await sheet.get_drive();

        const permissionResponse = await drive.files.get({
            fileId: sheet.sheet_id,
            fields: "capabilities(canEdit)",
        });

        if (permissionResponse.data.capabilities && !permissionResponse.data.capabilities.canEdit) {
            console.log("No edit rights");
            await sheet.release_sheets();
            return {success: false};
        }

        await sheet.load_setup();

        let flip_match = false;

        for (let i = 1; i <= sheet.setup.weeks; i++) {
            const schedule = await sheet.get_schedule(i);
            for (let j = 0; j < schedule.length; j++) {
                const m = schedule[j];
                if ((m.p1 == match.p1 && m.p2 == match.p2) ||
                    (m.p1 == match.p2 && m.p2 == match.p1)) {
                    match.week = i;
                    match.match = j + 1;
                    if (m.p1 == match.p2) {
                        flip_match = true;
                    }
                    break;
                }
            }
            if (match.week > 0 && match.match > 0) {
                break;
            }
        }

        if (match.week == 0 || match.match == 0) {
            await sheet.release_sheets();
            return {success: false};
        }

        console.log(`Match #${match.match} for week ${match.week}`);

        const makeTeamRange = (
            killJson: {
                [key: string]: {
                    [key: string]: number;
                };
            }, deathJson: {
                [key: string]: {
                    count: number;
                    killer: string;
                };
            }, second: boolean) => {
            const values: (string | undefined)[][] = [
                ["", ""],
                ["", ""],
                ["", ""],
                ["", ""],
                ["", ""],
                ["", ""]
            ];

            const keys = Object.keys(killJson);
            for (let i = 0; i < keys.length; i++) {
                const pokemon = keys[i];
                values[i][second ? 1 : 0] = pokemon;
                if (deathJson[pokemon].count == 0) {
                    values[i][second ? 0 : 1] = undefined;
                } else {
                    if (deathJson[pokemon].killer === "") {
                        values[i][second ? 0 : 1] = "Self KO";
                    } else {
                        values[i][second ? 0 : 1] = deathJson[pokemon].killer;
                    }
                }
            }

            return values;
        }

        let psPlayer1 = matchJson.playerNames[flip_match ? 1 : 0];
        let psPlayer2 = matchJson.playerNames[flip_match ? 0 : 1];
        let killJson1 = matchJson.players[psPlayer1].kills;
        let deathJson1 = matchJson.players[psPlayer1].deaths;
        let killJson2 = matchJson.players[psPlayer2].kills;
        let deathJson2 = matchJson.players[psPlayer2].deaths;

        const startRow = 9 + (match.match - 1) * 14;

        const resource: sheets_v4.Schema$BatchUpdateValuesRequest = {
            data: [
                {
                    range: `'Match Stats'!${columnToLetter(3 + (match.week - 1) * 12)}${startRow}:${columnToLetter(4 + (match.week - 1) * 12)}${startRow + 5}`,
                    values: makeTeamRange(killJson1, deathJson1, false)
                },
                {
                    range: `'Match Stats'!${columnToLetter(8 + (match.week - 1) * 12)}${startRow}:${columnToLetter(9 + (match.week - 1) * 12)}${startRow + 5}`,
                    values: makeTeamRange(killJson2, deathJson2, true)
                },
                {
                    range: `'Match Stats'!${columnToLetter(2 + (match.week - 1) * 12)}${startRow + 7}`,
                    values: [[matchJson.info.replay]]
                }
            ],
            valueInputOption: "RAW"
        }
        console.log(JSON.stringify(resource))

        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId: sheet.sheet_id,
            resource
        } as sheets_v4.Params$Resource$Spreadsheets$Values$Batchupdate);
        
        await sheet.release_sheets();
        return {success: true, msg: `Match stats added to the **${sheet.setup.league_name}** sheet for **Week ${match.week}: ${match.p1} vs. ${match.p2}**!`};
    }

    async get_sheets() {
        if (this.sheets) {
            return this.sheets;
        }

        //Sheets authentication
        const creds = process.env.GOOGLE_SERVICE_ACCOUNT;
        const serviceAuth = new google.auth.GoogleAuth({
            credentials: JSON.parse(creds as string),
            scopes: [
                "https://www.googleapis.com/auth/drive",
                "https://www.googleapis.com/auth/spreadsheets",
            ],
        });
        google.options({ auth: serviceAuth });
        return google.sheets({
            version: "v4",
            auth: serviceAuth,
        });
    }

    async get_drive() {
        //Sheets authentication
        const creds = process.env.GOOGLE_SERVICE_ACCOUNT;
        const serviceAuth = new google.auth.GoogleAuth({
            credentials: JSON.parse(creds as string),
            scopes: [
                "https://www.googleapis.com/auth/drive",
                "https://www.googleapis.com/auth/spreadsheets",
            ],
        });
        google.options({ auth: serviceAuth });
        return google.drive({
            version: "v3",
            auth: serviceAuth,
        });
    }

    async prepare_sheets() {
        this.sheets = await this.get_sheets();
    }

    async release_sheets() {
        this.sheets = undefined;
    }

    async verify() {
        return (
            this.errors.length === 0 &&
            this.setup.league_name.length > 0 &&
            this.players.length > 1
        );
    }

    async load_from_db() {
        await new Promise<boolean>((resolve, reject) => {
            db.serialize(() => {
                db.get("SELECT name, budget, players, weeks FROM League WHERE league_id = ?", [this.id], (err, row: any) => {
                    this.setup.league_name = row.name;
                    this.setup.budget = row.budget;
                    this.setup.players = row.players;
                    this.setup.weeks = row.weeks;
                    resolve(true);
                });
            })
        });
    }

    async load_from_sheet() {
        if (!(await this.load_setup())) {
            console.log("Failed to load setup");
            return false;
        }
        await this.load_players(true);
        return true;
    }

    async load_setup() {
        const sheets = this.get_sheets();
        const result = (await sheets).spreadsheets.values.get({
            spreadsheetId: this.sheet_id,
            range: "Setup!H2:I17",
        })
        const rows = (await result).data.values;
        if (!rows || rows.length === 0) {
            this.errors.push("Could not fetch Setup page.");
            return false;
        }
        rows.forEach((row) => {
            switch (row[0]) {
                case "League Name": {
                    this.setup.league_name = row[1];
                    break;
                }
                case "Budget": {
                    try {
                        this.setup.budget = parseInt(row[1]);
                    } catch (err) {
                        this.errors.push("Setup: Failed to read budget.");
                    }
                    break;
                }
                case "Players": {
                    try {
                        this.setup.players = parseInt(row[1]);
                    } catch (err) {
                        this.errors.push("Setup: Failed to read number of players.");
                    }
                    break;
                }
                case "Weeks": {
                    try {
                        this.setup.weeks = parseInt(row[1]);
                    } catch (err) {
                        this.errors.push("Setup: Failed to read number of weeks.");
                    }
                    break;
                }
            }
        });
        return this.errors.length === 0 && this.setup.players >= 2 && this.setup.weeks > 0;
    }

    async load_players(loadTeams: boolean) {
        const sheets = this.get_sheets();
        const result = (await sheets).spreadsheets.values.get({
            spreadsheetId: this.sheet_id,
            range: `Setup!A2:F${1+this.setup.players}`,
        })
        const rows = (await result).data.values;
        if (!rows || rows.length === 0) {
            this.errors.push("Could not fetch Setup player list.");
            return false;
        }
        for (const row of rows) {
            try {
                const player = {
                    number: parseInt(row[0]),
                    name: row[1],
                    team: [],
                } as DraftPlayer;
                if (row[5] && row[5].length > 0) {
                    player.showdownName = row[5];
                }
                if (row[2] && row[2].length > 0) {
                    player.teamName = row[2];
                }
                if (row[3] && row[3].length > 0) {
                    player.timeZone = row[3];
                }
                if (loadTeams) {
                    player.team = await this.load_team(player.number);
                }
                this.players.push(player);
            } catch (err) {
                console.log(err);
                this.errors.push("Failed to read player");
            }
        };
    }

    async load_team(playerNumber: number) {
        const team: string[] = [];
        const sheets = this.get_sheets();
        const teamRow = 2 + playerNumber;
        const result = (await sheets).spreadsheets.values.get({
            spreadsheetId: this.sheet_id,
            range: `'Team Data'!$B${teamRow}:K${teamRow + 6}`,
        })
        const rows = (await result).data.values;
        if (!rows || rows.length === 0) {
            this.errors.push("Could not fetch player team.");
            return team;
        }
        const row = rows[0];
        for (let i = 0; i < 10; i++) {
            if (row.length > i && row[i] && row[i].length > 0) {
                team.push(row[i]);
            }
        }
        return team;
    }

    async load_draft_board_to_db() {
        const sheets = this.get_sheets();
        const result = (await sheets).spreadsheets.values.get({
            spreadsheetId: this.sheet_id,
            range: `'Pokedex'!B3:L`,
        })
        const rows = (await result).data.values;
        if (!rows || rows.length === 0) {
            this.errors.push("Could not fetch draft board.");
            return 0;
        }
        return await new Promise<number>((resolve, reject) => {
            db.serialize(() => {
                for (const row of rows) {
                    let cost = 0;
                    let flags = 0;
                    try {
                        const costStr = row[5].toString();
                        cost = (costStr === "0") ? 1 : parseInt(costStr);
                        if (isNaN(cost) || cost >= 99) {
                            cost = 0;
                            flags = DraftPokemonFlag.BANNED;
                        }
                    } catch (err) {
                        cost = 0;
                        flags = DraftPokemonFlag.BANNED;
                    }
                    if (row[6] != "Y") {
                        flags = DraftPokemonFlag.BANNED;
                    }
                    const pkmn: DraftBoardPokemon = {
                        name: row[10],
                        githubName: row[0],
                        cost: cost,
                        flags: flags,
                    }
                    db.run(
                        "INSERT OR IGNORE INTO LeagueDraftBoard (league_id, pokemon, cost, github_name, flags) VALUES (?, ?, ?, ?, ?)",
                        [this.id, pkmn.name, pkmn.cost, pkmn.githubName, pkmn.flags]
                    )
                }
                db.get("SELECT COUNT(*) AS count FROM LeagueDraftBoard WHERE league_id = ?", [this.id], (err, row: any) => {
                    if (err) {
                        throw err;
                    }
                    if (!row) {
                        resolve(0);
                    }
                    resolve(row.count);
                });
            });
        });
    }

    find_player(name: string): DraftPlayer | undefined {
        for (const p of this.players) {
            if (p.name == name) {
                return p;
            }
        }
        return undefined;
    }

    async get_schedule(week: number) {
        const schedule: DraftMatch[] = [];
        const sheets = this.get_sheets();
        const startRow = 6 + (week - 1) * 11;
        const result = (await sheets).spreadsheets.values.get({
            spreadsheetId: this.sheet_id,
            range: `Schedule!$I${startRow}:Q${startRow + 7}`,
        })
        const rows = (await result).data.values;
        if (!rows || rows.length === 0) {
            this.errors.push("Could not fetch player team.");
            return schedule;
        }
        for (let i = 0; i < 8; i++) {
            if (rows.length > i && rows[i]) {
                const row = rows[i];
                if (row[0] && row[8] && row[0].length > 0 && row[8].length > 0) {
                    schedule.push({
                        p1: row[0],
                        p2: row[8],
                        week: week,
                        match: i,
                    } as DraftMatch);
                }
            }
        }
        return schedule;
    }

    async add_channel(channel_id: string, type: DraftChannelType) {
        return await new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run("DELETE FROM LeagueChannel WHERE (league_id = ? AND channel_type = ?) OR channel = ?", [this.id, type, channel_id]);
                db.run("INSERT INTO LeagueChannel (channel, league_id, channel_type) VALUES (?, ?, ?)", [channel_id, this.id, type], (err) => {
                    resolve(true);
                });
            });
        });
    }

    async save() {
        let success = true;

        // Check if the league sheet is already in the database
        if (this.id === undefined) {
            await new Promise<number | undefined>((resolve, reject) => {
                db.get("SELECT league_id FROM League WHERE sheet_id=?", [this.sheet_id], (err, row: any) => {
                    if (err) {
                        throw err;
                    }
                    if (row) {
                        resolve(row.league_id);
                    }
                    resolve(undefined);
                });
            });
        }

        // Add to database if not there
        if (this.id === undefined) {
            await new Promise((resolve, reject) => {
                db.prepare("INSERT OR IGNORE INTO League (name, budget, players, weeks, sheet_id) VALUES (?, ?, ?, ?, ?)")
                    .run(this.setup.league_name, this.setup.budget, this.setup.players, this.setup.weeks, this.sheet_id)
                    .finalize((err) => {
                        resolve(true);
                    });
            });

            this.id = await new Promise<number | undefined>((resolve, reject) => {
                db.get("SELECT league_id FROM League WHERE sheet_id=?", [this.sheet_id], (err, row: any) => {
                    if (err) {
                        throw err;
                    }
                    if (row) {
                        resolve(row.league_id);
                    }
                    resolve(undefined);
                });
            });
        }

        // Verify it was added correctly
        if (this.id === undefined) {
            success = false;
            return;
        }

        let stmt = db.prepare("INSERT OR IGNORE INTO LeagueCategory (category, league_id) VALUES (?, ?)");
        for (const cat of this.categories) {
            stmt.run(cat, this.id);
        }
        stmt.finalize();

        stmt = db.prepare("INSERT OR IGNORE INTO LeaguePlayer (league_id, player_number, name, team_name, time_zone, showdown_name, showdown_key, discord_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        for (const p of this.players) {
            stmt.run(this.id, p.number, p.name, p.teamName, p.timeZone, p.showdownName, toShowdownKey(p.showdownName), p.discordId);
        }
        stmt.finalize();

        return success;
    }
}

export default DraftSheet;
