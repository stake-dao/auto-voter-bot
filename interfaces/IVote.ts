export interface IVote {
    user: `0x${string}`;
    gauges: `0x${string}`[];
    weights: number[];
    killed: boolean;
}