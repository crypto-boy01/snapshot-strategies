import { formatUnits } from '@ethersproject/units';

import { subgraphRequest, Multicaller } from '../../utils';

const abi = ['function getVotingPowerMultiplier(uint8) view returns (uint256)'];

export const author = 'dev@doubledice';
export const version = '0.1.0';

enum Multipliers {
  room = 0,
  lazy = 1
}

const LIMIT = 1000; // 1000 addresses per query in Subgraph

async function stakingSubgraphQuery(
  snapshot: any,
  subgraphEndpoint: string,
  addresses: string[],
  tokenDecimals: number,
  roomMultiplier: number,
  lazyMultiplier: number
): Promise<{ [propName: string]: number }> {
  const query = {
    lockEntities: {
      __args: {
        first: LIMIT,
        where: {
          beneficiary_in: addresses.map((adr) => adr.toLowerCase()),
          claimed: false
        }
      },
      beneficiary: true,
      amount: true
    },
    lazyPoolUserLockInfoEntities: {
      __args: {
        first: LIMIT,
        where: {
          user_in: addresses.map((adr) => adr.toLowerCase()),
          claimed: false
        }
      },
      user: true,
      amount: true
    }
  };

  if (snapshot !== 'latest') {
    query.lockEntities.__args['block'] = { number: +snapshot };
    query.lazyPoolUserLockInfoEntities.__args['block'] = { number: +snapshot };
  }

  const data = await subgraphRequest(subgraphEndpoint, query);

  const subgraphBalance = {};

  for (let i = 0; i < data.lockEntities.length; i++) {
    const { beneficiary, amount } = data.lockEntities[i];

    const existingBalance = subgraphBalance[beneficiary] ?? 0;

    subgraphBalance[beneficiary] =
      existingBalance +
      parseFloat(formatUnits(amount, tokenDecimals).toString()) *
        roomMultiplier;
  }

  for (let i = 0; i < data.lazyPoolUserLockInfoEntities.length; i++) {
    const { user, amount } = data.lazyPoolUserLockInfoEntities[i];

    const existingBalance = subgraphBalance[user] ?? 0;

    subgraphBalance[user] =
      existingBalance +
      parseFloat(formatUnits(amount, tokenDecimals).toString()) *
        lazyMultiplier;
  }

  return subgraphBalance;
}

export async function strategy(
  space,
  network,
  provider,
  addresses,
  options,
  snapshot
): Promise<Record<string, number>> {
  // trim addresses to sub of "LIMIT" addresses.
  const addressSubsets = Array.apply(
    null,
    Array(Math.ceil(addresses.length / LIMIT))
  ).map((_e, i) => addresses.slice(i * LIMIT, (i + 1) * LIMIT));

  const blockTag = typeof snapshot === 'number' ? snapshot : 'latest';

  const multi = new Multicaller(network, provider, abi, { blockTag });

  multi.call(
    'roomOwnersPoolMultiplier',
    options.votingPowerContractAddress,
    'getVotingPowerMultiplier',
    [Multipliers.room]
  );

  multi.call(
    'lazyPoolMultiplier',
    options.votingPowerContractAddress,
    'getVotingPowerMultiplier',
    [Multipliers.lazy]
  );
  const { roomOwnersPoolMultiplier, lazyPoolMultiplier } =
    await multi.execute();

  const roomMultiplier = parseFloat(roomOwnersPoolMultiplier.toString());
  const lazyMultiplier = parseFloat(lazyPoolMultiplier.toString());

  const returnedFromSubgraph = await Promise.all(
    addressSubsets.map((subset) =>
      stakingSubgraphQuery(
        snapshot,
        options.subgraphEndpoint,
        subset,
        options.decimals,
        roomMultiplier,
        lazyMultiplier
      )
    )
  );

  // get and parse balance from subgraph
  const subgraphBalance = Object.assign({}, ...returnedFromSubgraph);

  const subgraphScore = addresses.map(
    (address) => subgraphBalance[address.toLowerCase()] ?? 0
  );

  return Object.fromEntries(addresses.map((adr, i) => [adr, subgraphScore[i]]));
}
