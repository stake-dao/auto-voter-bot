import * as dotenv from "dotenv";
import { ethers } from "ethers";
import snapshot from "@snapshot-labs/snapshot.js";
import { request, gql } from 'graphql-request'
import config from './data/config.json';
import { equals } from "./utils/stringsUtil";
import { IProposal } from "./interfaces/IProposal";
import moment from "moment";
import axios from "axios";

dotenv.config();

const CHOICE_GAUGE_ADDRESS_SEP = " - ";
const THREE_DOTS = "…";
const hub = 'https://hub.snapshot.org';

const main = async () => {
    // Check if the delegation private key is set
    if (!process.env.DELEGATION_PRIVATE_KEY) {
        throw new Error("No private key found in env");
    }

    // Get available locker spaces
    const {data: lockersConfig} = await axios.get("https://autovoter.stakedao.org/lockers/lockers.json")
    const availableSpaces = lockersConfig.map((l: any) => l.space);

    const spaces = Object.keys(config.votes.reduce((acc, vote) => {
        acc[vote.space.toLowerCase()] = true;
        return acc;
    }, {}));
    const now = moment().unix();

    for (const space of spaces) {
        let isAvailableSpace = false;
        for (const availableSpace of availableSpaces) {
            if (equals(availableSpace, space)) {
                isAvailableSpace = true;
                break;
            }
        }

        if(!isAvailableSpace) {
            continue;
        }

        const lastProposal = await getLastProposal(space);
        if (!lastProposal) {
            continue;
        }

        // Check if proposal still ongoing
        const stillOngoing = lastProposal.start <= now && lastProposal.end >= now;
        if (!stillOngoing) {
            continue;
        }

        // Extract begin address in the proposal
        const gaugeAddressesChoice: any = {};
        for (let i = 0; i < lastProposal.choices.length; i++) {
            const choice = lastProposal.choices[i];
            const lastIndexof = choice.lastIndexOf(CHOICE_GAUGE_ADDRESS_SEP);
            if (lastIndexof === -1) {
                continue;
            }

            let gaugeAddress = choice.substring(lastIndexof + CHOICE_GAUGE_ADDRESS_SEP.length);
            if (gaugeAddress.length < 17) {
                continue;
            }

            const indexOfThreeDot = choice.lastIndexOf(THREE_DOTS);
            if (indexOfThreeDot === -1) {
                continue;
            }

            gaugeAddress = choice.substring(lastIndexof + CHOICE_GAUGE_ADDRESS_SEP.length, indexOfThreeDot);

            // + 1 because snapshot choice start at 1 when we vote
            gaugeAddressesChoice[gaugeAddress.toLowerCase()] = i + 1;
        }

        // Construct vote choices based on user vote data
        const votes = config.votes.filter((vote) => equals(vote.space, space));

        const choices: any = {};
        for (const vote of votes) {
            const gaugeAddress = vote.gaugeAddress;
            const startGaugeAddress = gaugeAddress.substring(0, 17).toLowerCase();
            if (gaugeAddressesChoice[startGaugeAddress].toString() === undefined) {
                throw new Error("Gauge address not found");
            }

            choices[gaugeAddressesChoice[startGaugeAddress].toString()] = Number(vote.weight);
        }

        await vote(space, lastProposal.id, choices);
    }
}

const getLastProposal = async (space: string): Promise<IProposal | null> => {
    const query = gql`
    query Proposals {
        proposals (
            where: { space_in: ["${space}"], title_contains: "Gauge vote" },
            orderBy: "created",
            orderDirection: desc
            first: 1
        ) {
            id
            title
            choices
            start
            end
        }
    }`;

    const data = (await request("https://hub.snapshot.org/graphql", query)) as any;
    if (data.proposals.length === 0) {
        return null;
    }

    return data.proposals[0];
}

/**
 * Cast a vote on snapshot
 */
const vote = async (space: string, proposalId: string, choice: any) => {

    const client = new snapshot.Client712(hub);
    const pk = process.env.DELEGATION_PRIVATE_KEY as `0x${string}`;
    const web3 = new ethers.Wallet(pk);

    await client.vote(web3, web3.address, {
        space,
        proposal: proposalId,
        type: 'weighted',
        choice,
    });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});