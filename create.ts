import * as dotenv from "dotenv";
import { BytesLike, ethers } from "ethers";
import snapshot from "@snapshot-labs/snapshot.js";
import { request, gql } from 'graphql-request'
import moment from "moment";
import axios from "axios";
import * as chains from 'viem/chains'
import config from './data/config.json';
import VOTER_ABI from './abis/Voter.json';
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'
import { createPublicClient, createWalletClient, http } from 'viem'
import { equals } from "./utils/stringsUtil";
import { IVote } from "./interfaces/IVote";
import { IProposal } from "./interfaces/IProposal";

dotenv.config();

const CHOICE_GAUGE_ADDRESS_SEP = " - ";
const THREE_DOTS = "…";

const main = async () => {
    // Check if the delegation private key is set
    if (!process.env.DELEGATION_PRIVATE_KEY) {
        throw new Error("No private key found in env");
    }

    // Check if the public key (ie : the address which delegated to DELEGATION_PRIVATE_KEY and store user votes) is set
    if (!process.env.PUBLIC_ADDRESS) {
        throw new Error("No public key found in env");
    }

    // Get env
    const publicAddress = process.env.PUBLIC_ADDRESS as `0x${string}`;
    const rpcUrl = process.env.MAINNET_RPC_URL as string;

    // Create public client
    const publicClient = createPublicClient({
        chain: mainnet,
        transport: http(rpcUrl || undefined),
        batch: {
            multicall: true,
        }
    });

    const spaces = config.spaces;
    for (const space of spaces) {
        const lastProposal = await getLastProposal(space);
        if (!lastProposal) {
            continue;
        }

        const results = await publicClient.multicall({
            contracts: [
                {
                    address: config.voterContract as `0x${string}`,
                    abi: VOTER_ABI as any,
                    functionName: 'get',
                    args: [publicAddress, space]
                },
            ],
        });

        // Should have only one result
        if (results.length > 1) {
            throw new Error("# votes > 1");
        }

        const result = results[0];

        // Should not failed here since it should return at least an "empty" vote object
        if (result.status === "failure") {
            throw new Error("Failed to fetch vote");
        }

        const data = (result.result as any) as IVote;

        // Can happened if the user didn't set a vote data for this space
        if (!equals(data.user, publicAddress)) {
            continue;
        }

        // If the user removed his vote, we still have the vote data but killed is set to true
        if (data.killed) {
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
        const choices: any = {};
        for (let i = 0; i < data.gauges.length; i++) {
            const gaugeAddress = data.gauges[i];
            const startGaugeAddress = gaugeAddress.substring(0, 17).toLowerCase();
            if (gaugeAddressesChoice[startGaugeAddress].toString() === undefined) {
                throw new Error("Gauge address not found");
            }

            choices[gaugeAddressesChoice[startGaugeAddress].toString()] = Number(data.weights[i]);
        }

        await vote(space, lastProposal.id, choices);
    }
}

const getLastProposal = async (space: string): Promise<IProposal | null> => {
    const query = gql`
    query Proposals {
        proposals (
            where: { space_in: ["sdcrv.eth"], title_contains: "Gauge vote" },
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
    const hub = process.env.HUB;

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