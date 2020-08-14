import {State, toNitroState} from '@statechannels/wallet-core';
import {createValidTransitionTransaction} from '@statechannels/nitro-protocol';
import * as PureEVM from 'pure-evm';
import {utils} from 'ethers';

import {AppBytecode} from './models/app-bytecode';
import {logger} from './logger';
import {CHAIN_ID} from './wallet/constants';

export const isValidTransition = async (from: State, to: State): Promise<boolean> => {
  if (from.appDefinition !== to.appDefinition) {
    throw new Error('States are using different appDefinitions');
  }
  const bytecode = await AppBytecode.getBytecode(CHAIN_ID, from.appDefinition, undefined);
  if (!bytecode) {
    logger.warn(
      `No bytecode found for appDefinition ${from.appDefinition} and chain id ${CHAIN_ID}. Skipping valid transition check`
    );
    return true;
  }

  const {data} = await createValidTransitionTransaction(toNitroState(from), toNitroState(to));
  const result = PureEVM.exec(
    Uint8Array.from(Buffer.from(bytecode.substr(2), 'hex')),
    Uint8Array.from(Buffer.from(data ? data.toString().substr(2) : '0x0', 'hex'))
  );

  // We need to ensure the result is the correct length otherwise we might be interpreting a failed assertion
  return result.length === 32 && (utils.defaultAbiCoder.decode(['bool'], result)[0] as boolean);
};
