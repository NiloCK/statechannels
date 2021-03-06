import {
  CreateChannelParams,
  Participant,
  Allocation,
  CloseChannelParams,
} from '@statechannels/client-api-schema';
import {makeAddress, makeDestination} from '@statechannels/wallet-core';
import {BigNumber, ethers, constants} from 'ethers';

import {DBAdmin} from '../../db-admin/db-admin';
import {defaultTestConfig, overwriteConfigWithDatabaseConnection} from '../../config';
import {Wallet} from '../../wallet';
import {getChannelResultFor, getPayloadFor, ONE_DAY} from '../test-helpers';
let a: Wallet;
let b: Wallet;

const aWalletConfig = overwriteConfigWithDatabaseConnection(defaultTestConfig(), {
  database: 'TEST_A',
});
const bWalletConfig = overwriteConfigWithDatabaseConnection(defaultTestConfig(), {
  database: 'TEST_B',
});

let channelId: string;
let participantA: Participant;
let participantB: Participant;

beforeAll(async () => {
  await DBAdmin.createDatabase(aWalletConfig);
  await DBAdmin.createDatabase(bWalletConfig);
  await Promise.all([
    DBAdmin.migrateDatabase(aWalletConfig),
    DBAdmin.migrateDatabase(bWalletConfig),
  ]);
  a = await Wallet.create(aWalletConfig);
  b = await Wallet.create(bWalletConfig);
});
afterAll(async () => {
  await Promise.all([a.destroy(), b.destroy()]);
  await Promise.all([DBAdmin.dropDatabase(aWalletConfig), DBAdmin.dropDatabase(bWalletConfig)]);
});

it('Create a fake-funded channel between two wallets ', async () => {
  participantA = {
    signingAddress: await a.getSigningAddress(),
    participantId: 'a',
    destination: makeDestination(
      '0x00000000000000000000000000000000000000000000000000000000000aaaa1'
    ),
  };
  participantB = {
    signingAddress: await b.getSigningAddress(),
    participantId: 'b',
    destination: makeDestination(
      '0x00000000000000000000000000000000000000000000000000000000000bbbb2'
    ),
  };

  const assetHolderAddress = makeAddress(constants.AddressZero);
  const aBal = BigNumber.from(1).toHexString();

  const allocation: Allocation = {
    allocationItems: [{destination: participantA.destination, amount: aBal}],
    assetHolderAddress,
  };

  const channelParams: CreateChannelParams = {
    participants: [participantA, participantB],
    allocations: [allocation],
    appDefinition: ethers.constants.AddressZero,
    appData: '0x00', // must be even length
    fundingStrategy: 'Fake',
    challengeDuration: ONE_DAY,
  };

  //        A <> B
  // PreFund0
  const aCreateChannelOutput = await a.createChannel(channelParams);

  channelId = aCreateChannelOutput.channelResults[0].channelId;

  expect(getChannelResultFor(channelId, aCreateChannelOutput.channelResults)).toMatchObject({
    status: 'opening',
    turnNum: 0,
  });

  // A sends PreFund0 to B
  const bProposeChannelPushOutput = await b.pushMessage(
    getPayloadFor(participantB.participantId, aCreateChannelOutput.outbox)
  );

  expect(getChannelResultFor(channelId, bProposeChannelPushOutput.channelResults)).toMatchObject({
    status: 'proposed',
    turnNum: 0,
  });

  // after joinChannel, B signs PreFund1 and PostFund3
  const bJoinChannelOutput = await b.joinChannel({channelId});

  expect(getChannelResultFor(channelId, [bJoinChannelOutput.channelResult])).toMatchObject({
    status: 'opening',
    turnNum: 0,
  });

  // B sends signed PreFund1 and PostFund3 to A
  const aPushJoinChannelOutput = await a.pushMessage(
    getPayloadFor(participantA.participantId, bJoinChannelOutput.outbox)
  );
  expect(getChannelResultFor(channelId, aPushJoinChannelOutput.channelResults)).toMatchObject({
    status: 'running',
    turnNum: 3,
  });

  // A sends PostFund2 to B
  const bPushPostFundOutput = await b.pushMessage(
    getPayloadFor(participantB.participantId, aPushJoinChannelOutput.outbox)
  );
  expect(getChannelResultFor(channelId, bPushPostFundOutput.channelResults)).toMatchObject({
    status: 'running',
    turnNum: 3,
  });

  const closeChannelParams: CloseChannelParams = {
    channelId,
  };

  // A generates isFinal4
  const aCloseChannelResult = await a.closeChannel(closeChannelParams);

  expect(getChannelResultFor(channelId, [aCloseChannelResult.channelResult])).toMatchObject({
    status: 'closing',
    turnNum: 4,
  });

  const bPushMessageResult = await b.pushMessage(
    getPayloadFor(participantB.participantId, aCloseChannelResult.outbox)
  );

  // B pushed isFinal4, generated countersigned isFinal4
  expect(getChannelResultFor(channelId, bPushMessageResult.channelResults)).toMatchObject({
    status: 'closed',
    turnNum: 4,
  });

  // A pushed the countersigned isFinal4
  const aPushMessageResult = await a.pushMessage(
    getPayloadFor(participantA.participantId, bPushMessageResult.outbox)
  );

  expect(getChannelResultFor(channelId, aPushMessageResult.channelResults)).toMatchObject({
    status: 'closed',
    turnNum: 4,
  });
});
