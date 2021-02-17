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
// ------------------------
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
//
// Managing the request queue:
// ---------------------------
//
// Requests can exist in one of 6 states:
// 1. queued - when waiting to go into a proposal
// 2. pending - request included in current proposal/counter-proposal signed by us
// 3. success - [terminal] when included in an agreed state
// 4. cancelled - [terminal] if a defund is sent before the fund was included in the ledger
// 5. insufficient-funds - [terminal] if there aren't enough funds in the ledger
// 6. failed - [terminal] if the ledger ends due to a closure or a protocol exception
//
//      ┌────────────────────────┐
//      │                        v
//   queued <---> pending ---> success               failed [from any state]
//      │
//      ├──────────────────┐
//      v                  v
//   cancelled      insufficient-funds
//
// Requests also maintain a missedOpportunityCount and a lastAgreedStateSeen.
//
// The missedOpportunityCount tracks how many agreed states the request has failed to be
// included in. Protocols can use this to determine whether a request has stalled (e.g. if
// their counterparty isn't processing the objective anymore).
//
// The lastAgreedStateSeen is a piece of bookkeeping to so that the LedgerManager can
// accurately update the missedOpportunityCount.
//
// 1. identify any potential cancellations (defunds for which the fundings are still active)
// 2. see which requests (excluding potential cancellations) are in the agreed state
//    - mark them as success, also setting lastAgreedStateSeen
//    - for all other requests, if haven't seen this agreedState:
//      - increase the lastAgreedStateSeen
//      - increase missedOps
//      - mark as queued
// 3. if the potential cancellation's partner is queued, cancel both. If not, add back in to requests
// 4. decide whether to sign the current state
//    - if yes, mark all included as done
//    - and for all other requests, if haven't seen this agreedState (they won't have!):
//      - increase the lastAgreedStateSeen
//      - increase missedOps
//      - mark as queued
// 5. decide whether to propose a new state
//    - if yes, mark all included as pending
//    - if any don't fit, mark them as insuffient-funds
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

      // determine which state we're in
      const ledgerState = this.determineLedgerState(ledger);
      if (ledgerState.type === 'protocol-violation') throw new Error('protocol violation');

      // grab the requests
      const requests = await this.store.getPendingLedgerRequests(ledger.channelId, tx);

      // identify potential cancellations (defunds for which the fund is still active)
      // we need to temporarily remove these so we don't mistakenly think that the defund
      // has succeeded just because the channel isn't in the ledger
      const {cancellationDefunds, nonCancellations} = this.identifyPotentialCancellations(requests);

      // this marks any requests that are in the agreedState as success
      // any pending requests that haven't seen this agreedState yet will be reset to queued
      // the missedOpportunity counts will be increased for any requests that haven't seen this agreedState yet
      this.updateRequestsWithAgreed(nonCancellations, ledgerState.agreedState);

      // we can now apply the cancellations to any requests that are now in the queued state
      this.applyCancellations(cancellationDefunds, requests);

      // what happens next depends on whether we're the leader or follower
      if (ledger.myIndex === 0) {
        await this.crankAsLeader(ledger, ledgerState, response, tx);
      } else {
        await this.crankAsFollower(ledger, ledgerState, response, tx);
      }

      // save all requests
      // save the ledger
      // send response

      return true;
    });
  }

  private async crankAsLeader(
    ledger: Channel,
    ledgerState: Omit<LedgerState, ProtocolViolation>,
    response: WalletResponse,
    tx: Transaction
  ): Promise<boolean> {
    // determine which state we're in
    const ledgerState = this.determineLedgerState(ledger);

    // leader doesn't act in the proposal state
    if (ledgerState.type === 'proposal') return false;

    const {agreedState} = ledgerState;

    if (ledgerState.type === 'counter-proposal') {
      const {antepenultimateState} = ledgerState;

      const requests = await this.store.getPendingLedgerRequests(ledger.channelId, tx);
      const result = this.compareChangesWithRequests(requests, latestState, antepenultimateState);

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
    const proposedOutcome = this.buildOutcome(latestState, requests);
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

    const requests = await this.store.getPendingLedgerRequests(ledger.channelId, tx);
    const result = await this.compareChangesWithRequests(requests, latestState, penultimateState);
    // also detect those requests that are included in the original

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

    // Requests
    // * immediately mark requests that weren't in the proposal as missed opportunities
    // * also need to mark off any requests that are included in the agreed state
    //   (that could have come from the leader agreeing my counterproposal)
    // * if full agreement, mark those requests as done

    // request is:
    //   - queued
    //   - pending
    //   - succeeded
    //   - cancelled (when they cancelled out)
    //   - insufficient-funds

    // the leader tries to put the request in every time
    // the follower notes each time the leader didn't put it in
    // store lastProcessedAt on the requests - each time the follower processes at a new turnnumber they increase the failure count

    // how do I know if a request has failed? maybe I don't - maybe the objective failing tells me that

    await this.store.signState(ledger, stateToSign.signedState, tx);
    response.queueChannel(ledger);

    return true;
  }

  // see which requests are in the agreed state
  //    - mark them as success, also setting lastAgreedStateSeen
  //    - for all other requests, if haven't seen this agreedState:
  //      - increase the lastAgreedStateSeen
  //      - increase missedOps
  //      - mark as queued
  //    - don't mark potential cancellations
  updateRequestsWithAgreed(requests: LedgerRequest[], agreedState: State): void {
    // todo
  }

  // compareChangesWithRequest
  // - fullAgreement => agree on channels and outcome
  // - someoverlap, narrowedOutcome => have removed
  // - noOverlap
  compareChangesWithRequests(
    requests: LedgerRequest[],
    baselineState: State,
    candidateState: State
  ): CompareChangesWithRequestsResult {
    const baselineOutcome = baselineState.simpleAllocationOutcome;
    const candidateOutcome = candidateState.simpleAllocationOutcome;

    if (!baselineOutcome || !candidateOutcome)
      throw Error("Ledger state doesn't have simple allocation outcome");

    const changedDestinations = _.xor(baselineOutcome.destinations, candidateOutcome.destinations);

    if (changedDestinations.length === 0) return {type: 'full-agreement'};

    // identify which changes from the proposal are also in our list of requests
    const overlappingRequests = requests.filter(req =>
      changedDestinations.includes(req.channelToBeFunded)
    );

    if (overlappingRequests.length === 0)
      return {type: 'no-overlap', narrowedOutcome: baselineOutcome};

    // build the outcome
    const calculatedOutcome = this.buildOutcome(baselineState, overlappingRequests);

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

  buildOutcome(state: State, requests: LedgerRequest[]): SimpleAllocationOutcome {
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
        // await defundReq.markAsFailed(tx);
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
        // await fundingReq.markAsFailed(tx);
      }
    }

    return currentOutcome;
  }
}

// LedgerState
// ===========
type LedgerState = Agreement | Proposal | CounterProposal | ProtocolViolation;

type Agreement = {type: 'agreement'; agreedState: State};
type Proposal = {type: 'proposal'; agreedState: State; proposal: State};
type CounterProposal = {
  type: 'counter-proposal';
  counterProposal: State;
  proposal: State;
  agreedState: State;
};
type ProtocolViolation = {type: 'protocol-violation'};

// CompareChangesWithRequestsResult
// ================================
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
