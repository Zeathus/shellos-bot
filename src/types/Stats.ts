import { Rules } from "@prisma/client";

interface Stats {
    players: {
        [key: string]: {
            ps: string;
            kills: { [key: string]: { [key: string]: number } };
            deaths: { [key: string]: { count: number; killer: string } };
            league_id?: string;
        };
    };
    playerNames: string[];
    info: {
        replay: string;
        history: string;
        turns: number;
        winner: string;
        loser: string;
        rules: Rules;
        result: string;
        battleId: string;
    };
    error?: string;
}

export default Stats;
