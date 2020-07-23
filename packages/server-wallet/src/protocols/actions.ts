import {Notification} from '@statechannels/client-api-schema';
import {StateVariables} from '@statechannels/wallet-core';
import {providers} from 'ethers';

import {Bytes32} from '../type-aliases';
/*
Actions that protocols can declare.
*/

export type SignState = {type: 'SignState'; channelId: Bytes32} & StateVariables;
type NotifyApp = {type: 'NotifyApp'; notice: Omit<Notification, 'jsonrpc'>};

export type SubmitTransaction = {
  type: 'SubmitTransaction';
  transactionRequest: providers.TransactionRequest;
  transactionId: string;
};
const guard = <T extends ProtocolAction>(type: ProtocolAction['type']) => (
  a: ProtocolAction
): a is T => a.type === type;

export const isSignState = guard<SignState>('SignState');
export const isNotifyApp = guard<NotifyApp>('NotifyApp');
export const isSubmitTransaction = guard<SubmitTransaction>('SubmitTransaction');

export const isOutgoing = isNotifyApp;

export type Outgoing = NotifyApp;

export type ProtocolAction = SignState | NotifyApp | SubmitTransaction;
