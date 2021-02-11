import {Logger} from 'pino';
import _ from 'lodash';
import {Transaction} from 'objection';

import {Channel} from '../models/channel';
import {WalletResponse} from '../wallet/wallet-response';
import {Store} from '../wallet/store';
import {State} from '../models/channel/state';
import {SimpleAllocationOutcome} from '../models/channel/outcome';
import {LedgerRequest} from '../models/ledger-request';

// Ledger Update algorithm:
//
// Define the "leader" of the channel to be the first participant.
// Let the other participant be the "follower".
//
// If both parties follow the protocol, the ledger exists in one of three possible states:
// 1. Agreeement (the latest state is double-signed)
// 2. Proposal (latest states are: double-signed, leader-signed)
// 3. Counter-proposal (latest states are: double-signed, leader-signed, follower-signed)
//
// If we ever find ourselves not in one of these states, declare a protocol violation and
// exit the channel.
//
// The leader acts as follows:
// * In Agreement, the leader takes all of their queued updates, formulates them into a new state
//   and sends it to the follower. The state is now Proposal
// * In Proposal, does nothing
// * In Counter-proposal, confirms that all the updates are in the queue, and double signs
//   The state is now Agreement.
//
// The follower acts as follows:
// * In Agreement, does nothing
// * In Proposal:
//    * If all updates are in the queue, double-signs. The state is now Proposal.
//    * Otherwise, removes the states that are not in queue and formulates new state.
//      The state is now Counter-proposal
// * In Counter-proposal, does nothing
//
export class LedgerManager {
  private store: Store;
  private logger: Logger;
  private timingMetrics: boolean;

  static create(params: LedgerManagerParams): LedgerManager {
    return new this(params);
  }

  private constructor({store, logger, timingMetrics}: LedgerManagerParams) {
    this.store = store;
    this.logger = logger;
    this.timingMetrics = timingMetrics;
  }

  async crank(ledgerChannelId: string, response: WalletResponse): Promise<boolean> {
    return this.store.lockApp(ledgerChannelId, async (tx, ledger) => {
      // The following behavior is specific to CHALLENGING_V0 requirements
      // It will eventually be removed
      // START CHALLENGING_VO
      if (ledger.initialSupport.length === 0 && ledger.isSupported) {
        await this.store.setInitialSupport(ledger.channelId, ledger.support, tx);
      }
      // END CHALLENGING_VO

      // sanity checks
      if (!ledger.isRunning) return false;
      if (!ledger.isLedger) return false;

      if (ledger.myIndex === 0) {
        await this.crankAsLeader(ledger, response, tx);
      } else {
        await this.crankAsFollower(ledger, response, tx);
      }

      return true;
    });
  }

  private async crankAsLeader(
    ledger: Channel,
    response: WalletResponse,
    tx: Transaction
  ): Promise<boolean> {
    // determine which state we're in
    const ledgerState = this.determineLedgerState(ledger);
    if (ledgerState.type === 'protocol-violation') throw new Error('protocol violation');

    // leader doesn't act in the proposal state
    if (ledgerState.type === 'proposal') return false;

    const {latestState} = ledgerState;

    if (ledgerState.type === 'counter-proposal') {
      const {antepenultimateState} = ledgerState;

      const result = await this.compareChangesWithRequests(
        ledger,
        latestState,
        antepenultimateState,
        tx
      );

      // TODO: decide how to handle protocol violations
      if (result.type !== 'full-agreement') throw new Error('protocol error');

      // we agree, so sign their state
      await this.store.signState(ledger, latestState.signedState, tx);
      response.queueChannel(ledger);

      // TODO: mark requests as complete
    }

    // Note: we are now in the 'agreement' state:
    // - either because we were in counter-proposal and just signed their state
    // - or because we were in 'agreement' at the beginning

    // so we want to craft a new proposal
    const requests = await this.store.getPendingLedgerRequests(ledger.channelId, tx);
    const proposedOutcome = await this.buildOutcome(latestState, requests, tx);
    const proposedState = latestState.advanceToOutcome(proposedOutcome);

    await this.store.signState(ledger, proposedState.signedState, tx);
    response.queueChannel(ledger);

    return true;
  }

  private async crankAsFollower(
    ledger: Channel,
    response: WalletResponse,
    tx: Transaction
  ): Promise<boolean> {
    // only take action if the ledger is in the 'proposal' state
    const ledgerState = this.determineLedgerState(ledger);
    if (ledgerState.type === 'protocol-violation') throw new Error('protocol violation');

    // follower only acts in the proposal state
    if (ledgerState.type !== 'proposal') return false;
    const {latestState, penultimateState} = ledgerState;

    const result = await this.compareChangesWithRequests(ledger, latestState, penultimateState, tx);

    let stateToSign: State;
    switch (result.type) {
      case 'full-agreement':
        // we agree on what should go into the channel, and what the new state should be
        // add our signature to the existing state
        stateToSign = latestState;
        break;
      case 'no-overlap':
        // we don't like anything our partner proposed
        // we're going to make a counter-proposal to return to the original state
        stateToSign = latestState.advanceToOutcome(result.narrowedOutcome);
        break;
      case 'some-overlap': {
        // we agree with some of what our partner proposed
        // make a counter-proposal containing the overlap
        stateToSign = latestState.advanceToOutcome(result.narrowedOutcome);
      }
    }

    // TODO: mark requests as complete

    await this.store.signState(ledger, stateToSign.signedState, tx);
    response.queueChannel(ledger);

    return true;
  }

  // compareChangesWithRequest
  // - fullAgreement => agree on channels and outcome
  // - someoverlap, narrowedOutcome => have removed
  // - noOverlap
  async compareChangesWithRequests(
    ledger: Channel,
    baselineState: State,
    candidateState: State,
    tx: Transaction
  ): Promise<CompareChangesWithRequestsResult> {
    const baselineOutcome = baselineState.simpleAllocationOutcome;
    const candidateOutcome = candidateState.simpleAllocationOutcome;

    if (!baselineOutcome || !candidateOutcome)
      throw Error("Ledger state doesn't have simple allocation outcome");

    const changedDestinations = _.xor(baselineOutcome.destinations, candidateOutcome.destinations);

    if (changedDestinations.length === 0) return {type: 'full-agreement'};

    // identify which changes from the proposal are also in our list of requests
    const requestList = await this.store.getPendingLedgerRequests(ledger.channelId, tx);
    const overlappingRequests = requestList.filter(req =>
      changedDestinations.includes(req.channelToBeFunded)
    );

    if (overlappingRequests.length === 0)
      return {type: 'no-overlap', narrowedOutcome: baselineOutcome};

    // build the outcome
    const calculatedOutcome = await this.buildOutcome(baselineState, overlappingRequests, tx);

    if (overlappingRequests.length === changedDestinations.length) {
      // we've have full overlap
      if (candidateOutcome === calculatedOutcome) {
        // all agree. happy days.
        return {type: 'full-agreement'};
      } else {
        // uh oh. We agree on the requests but not the outcome. Coding error alert
        throw new Error('Outcomes inconsistent');
      }
    } else {
      return {type: 'some-overlap', narrowedOutcome: calculatedOutcome};
    }
  }

  determineLedgerState(ledger: Channel): LedgerState {
    const [leader, follower] = ledger.participants.map(p => p.signingAddress);
    const latestTurnNum = ledger.latestTurnNum;

    const latestState = ledger.uniqueStateAt(latestTurnNum);
    if (!latestState) return {type: 'protocol-violation'};

    if (latestState.fullySigned) return {type: 'agreement', latestState};

    const penultimateState = ledger.uniqueStateAt(latestTurnNum - 1);
    if (!penultimateState) return {type: 'protocol-violation'};

    if (penultimateState.fullySigned) {
      if (latestState.signedBy(leader)) {
        return {type: 'proposal', latestState, penultimateState};
      } else {
        return {type: 'protocol-violation'};
      }
    }

    const antepenultimateState = ledger.uniqueStateAt(latestTurnNum - 2);
    if (!antepenultimateState) return {type: 'protocol-violation'};

    if (
      !antepenultimateState.fullySigned &&
      penultimateState.signedBy(leader) &&
      latestState.signedBy(follower)
    ) {
      return {type: 'protocol-violation'};
    } else {
      return {type: 'counter-proposal', latestState, penultimateState, antepenultimateState};
    }
  }

  async buildOutcome(
    state: State,
    requests: LedgerRequest[],
    tx: Transaction
  ): Promise<SimpleAllocationOutcome> {
    if (!state.simpleAllocationOutcome)
      throw Error("Ledger doesn't have simple allocation outcome");

    let currentOutcome = state.simpleAllocationOutcome;

    // we should do any defunds first
    for (const defundReq of requests.filter(r => r.type === 'defund')) {
      const updatedOutcome = currentOutcome.remove(
        defundReq.channelToBeFunded,
        state.participantDestinations,
        [defundReq.amountA, defundReq.amountB]
      );

      if (updatedOutcome) {
        currentOutcome = updatedOutcome;
      } else {
        // the only way removal fails is if the refund amounts don't match the amount in the channel
        // in that case the request is not viable and should be marked as failed
        await defundReq.markAsFailed(tx);
      }
    }

    // then we should do any fundings
    for (const fundingReq of requests.filter(r => r.type === 'fund')) {
      // the order of addition doesn't matter here. Thanks to the way that
      const updatedOutcome = currentOutcome.add(
        fundingReq.channelToBeFunded,
        state.participantDestinations,
        [fundingReq.amountA, fundingReq.amountB]
      );

      if (updatedOutcome) {
        currentOutcome = updatedOutcome;
      } else {
        // if funding failed, it means that there aren't enough funds left in the channel
        // so mark the request as failed

        // TODO: do we actually want to do this here?
        await fundingReq.markAsFailed(tx);
      }
    }

    return currentOutcome;
  }
}

// LedgerState
// ===========
type LedgerState = Agreement | Proposal | CounterProposal | ProtocolViolation;

type Agreement = {type: 'agreement'; latestState: State};
type Proposal = {type: 'proposal'; latestState: State; penultimateState: State};
type CounterProposal = {
  type: 'counter-proposal';
  latestState: State;
  penultimateState: State;
  antepenultimateState: State;
};
type ProtocolViolation = {type: 'protocol-violation'};

// CompareChangesWithRequestsResult
type CompareChangesWithRequestsResult = FullAgreement | SomeOverlap | NoOverlap;

type FullAgreement = {type: 'full-agreement'};
type SomeOverlap = {type: 'some-overlap'; narrowedOutcome: SimpleAllocationOutcome};
type NoOverlap = {type: 'no-overlap'; narrowedOutcome: SimpleAllocationOutcome};

// LedgerManagerParams
// ===================
interface LedgerManagerParams {
  store: Store;
  logger: Logger;
  timingMetrics: boolean;
}
