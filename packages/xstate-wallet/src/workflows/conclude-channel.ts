import {Machine, StateNodeConfig, assign, DoneInvokeEvent} from 'xstate';
import {Store} from '../store';
import {VirtualDefundingAsLeaf, SupportState} from '.';
import {getDataAndInvoke, commonWorkflowActions, CommonActions} from '../utils';
import {map, first, filter} from 'rxjs/operators';
import {ParticipantIdx} from './virtual-funding-as-leaf';
import {ChannelChainInfo} from '../chain';
import {MessagingServiceInterface} from '../messaging';

const WORKFLOW = 'conclude-channel';

export type Init = {channelId: string};

const signFinalState = (store: Store) => async ({channelId}: Init): Promise<void> => {
  const {supported, latestSignedByMe} = await store.getEntry(channelId);
  if (!supported.isFinal) throw new Error('Supported state not final');
  if (latestSignedByMe.turnNum.eq(supported.turnNum)) return; // already signed
  await store.signAndAddState(channelId, supported);
};

const waitForConclusionProof = (store: Store) => async ({channelId}: Init) =>
  store
    .channelUpdatedFeed(channelId)
    .pipe(first(({hasConclusionProof}) => hasConclusionProof))
    .toPromise();

const concludeChannel = getDataAndInvoke<Init>(
  {src: signFinalState.name},
  {src: waitForConclusionProof.name},
  'determineFundingType'
);

const getFunding = (store: Store) => (ctx: Init) =>
  store.channelUpdatedFeed(ctx.channelId).pipe(
    map(({funding}) => {
      switch (funding?.type) {
        case 'Direct':
        case 'Virtual':
          return funding.type;
        default:
          throw new Error(`Unexpected funding type ${funding?.type}`);
      }
    })
  );

const determineFundingType = {
  invoke: {src: getFunding.name},
  on: {
    Virtual: 'virtualDefunding',
    Direct: 'withdrawing'
  }
};

const getRole = (store: Store) => (ctx: Init) => async cb => {
  const {myIndex} = await store.getEntry(ctx.channelId);
  if (myIndex === ParticipantIdx.Hub) cb('AmHub');
  else cb('AmLeaf');
};
const getDirectFundingRole = (store: Store) => (ctx: Init) => async cb => {
  const {myIndex} = await store.getEntry(ctx.channelId);
  if (myIndex === ParticipantIdx.A) cb('AmA');
  else cb('AmB');
};

const supportState = (store: Store) => SupportState.machine(store);

const virtualDefunding = {
  initial: 'gettingRole',
  states: {
    gettingRole: {invoke: {src: getRole.name}, on: {AmHub: 'asHub', AmLeaf: 'asLeaf'}},
    asLeaf: {
      invoke: {
        src: 'virtualDefundingAsLeaf',
        data: (ctx: Init): VirtualDefundingAsLeaf.Init => ({targetChannelId: ctx.channelId}),
        onDone: 'success'
      }
    },
    asHub: {invoke: {src: 'virtualDefundingAsHub', onDone: 'success'}},
    success: {type: 'final' as 'final'}
  },
  onDone: 'success'
};

enum Services {
  submitWithdrawTransaction = 'submitWithdrawTransaction',
  observeFundsWithdrawal = 'observeFundsWithdrawal'
}

interface FundsWithdrawn {
  type: 'FUNDS_WITHDRAWN';
}

const observeFundsWithdrawal = (store: Store) => context =>
  store.chain.chainUpdatedFeed(context.channelId).pipe(
    filter(c => c.amount.eq(0)),
    map<ChannelChainInfo, FundsWithdrawn>(() => ({type: 'FUNDS_WITHDRAWN'}))
  );

const submitWithdrawTransaction = (store: Store) => async context => {
  const channelEntry = await store.getEntry(context.channelId);
  if (!channelEntry.hasConclusionProof) {
    throw new Error(`Channel ${context.channelId} is not finalized`);
  }
  await store.chain.finalizeAndWithdraw(channelEntry.support);
};

const withdrawing = {
  initial: 'gettingRole',
  invoke: {
    id: 'observeChain',
    src: Services.observeFundsWithdrawal
  },
  on: {
    FUNDS_WITHDRAWN: 'success'
  },
  entry: CommonActions.displayUI,
  exit: CommonActions.hideUI,
  states: {
    gettingRole: {
      invoke: {src: getDirectFundingRole.name},
      on: {AmA: 'submitTransaction', AmB: 'waitForWithdrawalToComplete'}
    },
    submitTransaction: {
      invoke: {
        id: 'submitTransaction',
        src: Services.submitWithdrawTransaction,
        onDone: {
          target: 'waitForWithdrawalToComplete',
          actions: assign({
            transactionId: (context, event: DoneInvokeEvent<string>) => event.data
          })
        }
      }
    },
    waitForWithdrawalToComplete: {}
  }
};

export const config: StateNodeConfig<Init, any, any> = {
  key: WORKFLOW,
  initial: 'concludeChannel',
  states: {
    concludeChannel,
    determineFundingType,
    virtualDefunding,
    withdrawing,
    success: {type: 'final'}
  }
};

const services = (store: Store) => ({
  signFinalState: signFinalState(store),
  waitForConclusionProof: waitForConclusionProof(store),
  getFunding: getFunding(store),
  supportState: supportState(store),
  getRole: getRole(store),
  getDirectFundingRole: getDirectFundingRole(store),
  virtualDefundingAsLeaf: VirtualDefundingAsLeaf.machine(store),
  submitWithdrawTransaction: submitWithdrawTransaction(store),
  observeFundsWithdrawal: observeFundsWithdrawal(store)
});

const options = (store: Store, messagingService: MessagingServiceInterface) => ({
  services: services(store),
  actions: commonWorkflowActions(messagingService)
});
export const machine = (store: Store, messagingService: MessagingServiceInterface) =>
  Machine(config).withConfig(options(store, messagingService));
