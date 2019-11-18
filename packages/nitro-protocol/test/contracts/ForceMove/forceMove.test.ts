import { expectRevert } from '@statechannels/devtools';
import { Contract, Wallet } from 'ethers';
import { HashZero } from 'ethers/constants';
import { defaultAbiCoder, hexlify } from 'ethers/utils';
// @ts-ignore
import ForceMoveArtifact from '../../../build/contracts/TESTForceMove.json';
import { Channel, getChannelId } from '../../../src/contract/channel';
import { ChannelStorage, hashChannelStorage } from '../../../src/contract/channel-storage';
import { getFixedPart, getVariablePart, State } from '../../../src/contract/state';
import {
  CHALLENGER_NON_PARTICIPANT,
  CHANNEL_FINALIZED,
  TURN_NUM_RECORD_DECREASED,
  TURN_NUM_RECORD_NOT_INCREASED,
} from '../../../src/contract/transaction-creators/revert-reasons';
import { SignedState } from '../../../src/index';
import { signChallengeMessage } from '../../../src/signatures';
import { COUNTING_APP_INVALID_TRANSITION } from '../../revert-reasons';
import {
  clearedChallengeHash,
  finalizedOutcomeHash,
  getTestProvider,
  ongoingChallengeHash,
  setupContracts,
  signStates,
  getPlaceHolderContractAddress,
} from '../../test-helpers';

const provider = getTestProvider();

let ForceMove: Contract;

const chainId = '0x1234';
const participants = ['', '', ''];
const wallets = new Array(3);
const challengeDuration = 0x1;
const outcome = [{ allocation: [], assetHolderAddress: Wallet.createRandom().address }];

let appDefinition;

// populate wallets and participants array
for (let i = 0; i < 3; i++) {
  wallets[i] = Wallet.createRandom();
  participants[i] = wallets[i].address;
}

beforeAll(async () => {
  ForceMove = await setupContracts(provider, ForceMoveArtifact);
  appDefinition = getPlaceHolderContractAddress();
});

// Scenarios are synonymous with channelNonce:

const acceptsWhenOpen = 'It accepts for an open channel, and updates storage correctly, ';
const accepts1 = acceptsWhenOpen + 'when the slot is empty, n states submitted';
const accepts2 = acceptsWhenOpen + 'when the slot is empty, 1 state submitted';
const accepts3 = acceptsWhenOpen + 'when the slot is not empty, n states submitted';
const accepts4 = acceptsWhenOpen + 'when the slot is not empty, 1 state submitted';

const acceptsWhenChallengePresent =
  'It accepts when a challenge is present, and updates storage correctly, ';
const accepts5 = acceptsWhenChallengePresent + 'when the turnNumRecord increases, 1 state';
const accepts6 = acceptsWhenChallengePresent + 'when the turnNumRecord increases, n states';

const revertsWhenOpenIf = 'It reverts for an open channel if ';
const reverts1 = revertsWhenOpenIf + 'the turnNumRecord does not increase';
const reverts2 = revertsWhenOpenIf + 'the challengerSig is incorrect';
const reverts3 = revertsWhenOpenIf + 'the states do not form a validTransition chain';

const reverts4 = 'It reverts when a challenge is present if the turnNumRecord does not increase';
const reverts5 = 'It reverts when the channel is finalized';

describe('forceMove', () => {
  const threeStates = { appDatas: [0, 1, 2], whoSignedWhat: [0, 1, 2] };
  const oneState = { appDatas: [2], whoSignedWhat: [0, 0, 0] };
  const invalid = { appDatas: [0, 2, 1], whoSignedWhat: [0, 1, 2] };
  const largestTurnNum = 8;
  const isFinalCount = 0;
  const challenger = wallets[2];
  const wrongSig = { v: 1, s: HashZero, r: HashZero };

  const empty = HashZero; // equivalent to openAtZero
  const openAtFive = clearedChallengeHash(5);
  const openAtLargestTurnNum = clearedChallengeHash(largestTurnNum);
  const openAtTwenty = clearedChallengeHash(20);
  const challengeAtFive = ongoingChallengeHash(5);
  const challengeAtLargestTurnNum = ongoingChallengeHash(largestTurnNum);
  const challengeAtTwenty = ongoingChallengeHash(20);
  const finalizedAtFive = finalizedOutcomeHash(5);

  let channelNonce = 200;
  beforeEach(() => (channelNonce += 1));
  it.each`
    description | initialChannelStorageHash    | stateData      | challengeSignature | reasonString
    ${accepts1} | ${empty}                     | ${oneState}    | ${undefined}       | ${undefined}
    ${accepts2} | ${empty}                     | ${threeStates} | ${undefined}       | ${undefined}
    ${accepts3} | ${openAtFive}                | ${oneState}    | ${undefined}       | ${undefined}
    ${accepts3} | ${openAtLargestTurnNum}      | ${oneState}    | ${undefined}       | ${undefined}
    ${accepts4} | ${openAtFive}                | ${threeStates} | ${undefined}       | ${undefined}
    ${accepts5} | ${challengeAtFive}           | ${oneState}    | ${undefined}       | ${undefined}
    ${accepts6} | ${challengeAtFive}           | ${threeStates} | ${undefined}       | ${undefined}
    ${reverts1} | ${openAtTwenty}              | ${oneState}    | ${undefined}       | ${TURN_NUM_RECORD_DECREASED}
    ${reverts2} | ${empty}                     | ${oneState}    | ${wrongSig}        | ${CHALLENGER_NON_PARTICIPANT}
    ${reverts3} | ${empty}                     | ${invalid}     | ${undefined}       | ${COUNTING_APP_INVALID_TRANSITION}
    ${reverts4} | ${challengeAtTwenty}         | ${oneState}    | ${undefined}       | ${TURN_NUM_RECORD_NOT_INCREASED}
    ${reverts4} | ${challengeAtLargestTurnNum} | ${oneState}    | ${undefined}       | ${TURN_NUM_RECORD_NOT_INCREASED}
    ${reverts5} | ${finalizedAtFive}           | ${oneState}    | ${undefined}       | ${CHANNEL_FINALIZED}
  `(
    '$description', // for the purposes of this test, chainId and participants are fixed, making channelId 1-1 with channelNonce

    async ({ initialChannelStorageHash, stateData, challengeSignature, reasonString }) => {
      const { appDatas, whoSignedWhat } = stateData;
      const channel: Channel = {
        chainId,
        participants,
        channelNonce: hexlify(channelNonce),
      };
      const channelId = getChannelId(channel);

      const states: State[] = appDatas.map((data, idx) => ({
        turnNum: largestTurnNum - appDatas.length + 1 + idx,
        isFinal: idx > appDatas.length - isFinalCount,
        channel,
        challengeDuration,
        outcome,
        appDefinition,
        appData: defaultAbiCoder.encode(['uint256'], [data]),
      }));
      const variableParts = states.map(state => getVariablePart(state));
      const fixedPart = getFixedPart(states[0]);

      // sign the states
      const signatures = await signStates(states, wallets, whoSignedWhat);
      const challengeState: SignedState = {
        state: states[states.length - 1],
        signature: { v: 0, r: '', s: '' },
      };
      challengeSignature =
        challengeSignature || signChallengeMessage([challengeState], challenger.privateKey);

      // set current channelStorageHashes value
      await (await ForceMove.setChannelStorageHash(channelId, initialChannelStorageHash)).wait();

      const tx = ForceMove.forceMove(
        fixedPart,
        largestTurnNum,
        variableParts,
        isFinalCount,
        signatures,
        whoSignedWhat,
        challengeSignature
      );
      if (reasonString) {
        await expectRevert(() => tx, reasonString);
      } else {
        const receipt = await (await tx).wait();
        const event = receipt.events.pop();

        // catch ForceMove event
        const {
          channelId: eventChannelId,
          turnNumRecord: eventTurnNumRecord,
          finalizesAt: eventFinalizesAt,
          challenger: eventChallenger,
          isFinal: eventIsFinal,
          fixedPart: eventFixedPart,
          variableParts: eventVariableParts,
        } = event.args;

        // check this information is enough to respond
        expect(eventChannelId).toEqual(channelId);
        expect(eventTurnNumRecord._hex).toEqual(hexlify(largestTurnNum));
        expect(eventChallenger).toEqual(challenger.address);
        expect(eventFixedPart[0]._hex).toEqual(hexlify(fixedPart.chainId));
        expect(eventFixedPart[1]).toEqual(fixedPart.participants);
        expect(eventFixedPart[2]._hex).toEqual(hexlify(fixedPart.channelNonce));
        expect(eventFixedPart[3]).toEqual(fixedPart.appDefinition);
        expect(eventFixedPart[4]._hex).toEqual(hexlify(fixedPart.challengeDuration));
        expect(eventIsFinal).toEqual(isFinalCount > 0);
        expect(eventVariableParts[eventVariableParts.length - 1][0]).toEqual(
          variableParts[variableParts.length - 1].outcome
        );
        expect(eventVariableParts[eventVariableParts.length - 1][1]).toEqual(
          variableParts[variableParts.length - 1].appData
        );

        const expectedChannelStorage: ChannelStorage = {
          turnNumRecord: largestTurnNum,
          finalizesAt: eventFinalizesAt,
          state: states[states.length - 1],
          challengerAddress: challenger.address,
          outcome,
        };
        const expectedChannelStorageHash = hashChannelStorage(expectedChannelStorage);

        // check channelStorageHash against the expected value
        expect(await ForceMove.channelStorageHashes(channelId)).toEqual(expectedChannelStorageHash);
      }
    }
  );
});
