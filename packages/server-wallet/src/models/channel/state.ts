import {
  Address,
  SignedState,
  isSimpleAllocation,
  makeDestination,
} from '@statechannels/wallet-core';
import _ from 'lodash';

import {Bytes32} from '../../type-aliases';

import {SimpleAllocationOutcome} from './outcome';

// This is a wrapper around SignedState that adds a few convenience methods that will
// be useful to protocols
export class State {
  private state: SignedState;
  constructor(state: SignedState) {
    this.state = state;
  }

  public signedBy(address: Address): boolean {
    return !!this.state.signatures.find(sig => sig.signer == address);
  }

  public get fullySigned(): boolean {
    return _.every(this.state.participants, p => this.signedBy(p.signingAddress));
  }

  public get participantDestinations(): Bytes32[] {
    return this.state.participants.map(p => makeDestination(p.destination));
  }

  public get simpleAllocationOutcome(): SimpleAllocationOutcome | undefined {
    if (isSimpleAllocation(this.state.outcome)) {
      return new SimpleAllocationOutcome(this.state.outcome);
    } else {
      return undefined;
    }
  }

  public advanceToOutcome(outcome: SimpleAllocationOutcome): State {
    // TODO: actually do update
    return new State(this.state);
  }

  public get signedState(): SignedState {
    return this.state;
  }
}
