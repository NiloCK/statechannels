import {SimpleAllocation} from '@statechannels/wallet-core';

import {Bytes32, Uint256} from '../../type-aliases';

export class SimpleAllocationOutcome {
  private outcome: SimpleAllocation;

  constructor(outcome: SimpleAllocation) {
    this.outcome = outcome;
  }

  public get destinations(): Bytes32[] {
    return this.outcome.allocationItems.map(i => i.destination);
  }

  public remove(
    channelId: Bytes32,
    refundDestinations: Bytes32[],
    refundAmounts: Uint256[]
  ): SimpleAllocationOutcome | undefined {
    // check that channelId exists

    // and that amount is correct

    // for each refundDestination
    //   check that the destination is present

    return undefined;
  }

  public add(
    channelId: Bytes32,
    fundingSources: Bytes32[],
    fundingAmounts: Uint256[]
  ): SimpleAllocationOutcome | undefined {
    // for each funding source, check it has that amount, and decrement its total
    // don't remove if zero

    // then add the new channel in the list in the right place alphabetically

    return undefined;
  }
}
