import {Contract, Wallet, BigNumber} from 'ethers';

import {getTestProvider, setupContracts, randomExternalDestination} from '../../test-helpers';
// eslint-disable-next-line import/order
import AssetHolderArtifact from '../../../artifacts/contracts/test/TESTAssetHolder.sol/TESTAssetHolder.json';

const provider = getTestProvider();

let AssetHolder: Contract;

const participants = ['', '', ''];
const wallets = new Array(3);

// Populate wallets and participants array
for (let i = 0; i < 3; i++) {
  wallets[i] = Wallet.createRandom();
  participants[i] = wallets[i].address;
}

beforeAll(async () => {
  AssetHolder = await setupContracts(
    provider,
    AssetHolderArtifact,
    process.env.TEST_ASSET_HOLDER_ADDRESS
  );
});

import {AllocationItem} from '../../../src';
import {computeNewAllocation} from '../../../src/contract/asset-holder';

const randomAllocation = (numAllocationItems: number): AllocationItem[] => {
  return numAllocationItems > 0
    ? [...Array(numAllocationItems)].map(e => ({
        destination: randomExternalDestination(),
        amount: BigNumber.from(Math.ceil(Math.random() * 10)).toHexString(),
      }))
    : [];
};

const heldBefore = BigNumber.from(100).toHexString();
const allocation = randomAllocation(10);
const indices = [...Array(3)].map(e => ~~(Math.random() * 10));

describe('AsserHolder._computeNewAllocation', () => {
  it('matches on chain method', async () => {
    // check local function works as expected
    const locallyComputedNewAllocation = computeNewAllocation(heldBefore, allocation, indices);

    const result = await AssetHolder._computeNewAllocation(heldBefore, allocation, indices);
    expect(result).toBeDefined();

    expect((result as ReturnType<typeof computeNewAllocation>).newAllocation).toMatchObject(
      locallyComputedNewAllocation.newAllocation.map(a => ({
        ...a,
        amount: BigNumber.from(a.amount),
      }))
    );

    expect((result as any).safeToDelete).toEqual(locallyComputedNewAllocation.deleted);

    expect((result as ReturnType<typeof computeNewAllocation>).payouts).toMatchObject(
      locallyComputedNewAllocation.payouts.map(p => BigNumber.from(p))
    );

    expect((result as ReturnType<typeof computeNewAllocation>).totalPayouts).toEqual(
      BigNumber.from(locallyComputedNewAllocation.totalPayouts)
    );
  });
});