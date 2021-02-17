import {Model, TransactionOrKnex} from 'objection';

import {Bytes32, Uint256} from '../type-aliases';

export type LedgerRequestStatus =
  | 'queued'
  | 'cancelled'
  | 'pending' // Request added to DB to be handled by ProcessLedgerQueue
  | 'succeeded' // Ledger update became supported and thus request succeeded
  | 'insufficient-funds'
  | 'failed'; // if the ledger closes, or there's a protocol error

export interface LedgerRequestType {
  ledgerChannelId: Bytes32;
  channelToBeFunded: Bytes32;
  status: LedgerRequestStatus;
  amountA: Uint256;
  amountB: Uint256;
  lastProcessedTurnNum: number;
  missedOpportunityCount: number;
  type: 'fund' | 'defund';
}

export class LedgerRequest extends Model implements LedgerRequestType {
  channelToBeFunded!: LedgerRequestType['channelToBeFunded'];
  ledgerChannelId!: LedgerRequestType['ledgerChannelId'];
  status!: LedgerRequestType['status'];
  type!: LedgerRequestType['type'];
  amountA!: string;
  amountB!: string;
  missedOpportunityCount!: number;

  static tableName = 'ledger_requests';
  static get idColumn(): string[] {
    return ['channelToBeFunded', 'type'];
  }

  static async getRequest(
    channelToBeFunded: Bytes32,
    type: 'fund' | 'defund',
    tx: TransactionOrKnex
  ): Promise<LedgerRequestType | undefined> {
    return LedgerRequest.query(tx).findById([channelToBeFunded, type]);
  }

  static async setRequest(request: LedgerRequestType, tx: TransactionOrKnex): Promise<void> {
    await LedgerRequest.query(tx).insert(request);
  }

  async markAsFailed(tx: TransactionOrKnex): Promise<void> {
    await LedgerRequest.query(tx)
      .findById([this.channelToBeFunded, this.type])
      .patch({status: 'failed'});
  }

  static async setRequestStatus(
    channelToBeFunded: Bytes32,
    type: 'fund' | 'defund',
    status: LedgerRequestStatus,
    tx: TransactionOrKnex
  ): Promise<void> {
    await LedgerRequest.query(tx).findById([channelToBeFunded, type]).patch({status});
  }

  static async getPendingRequests(
    ledgerChannelId: string,
    tx: TransactionOrKnex
  ): Promise<LedgerRequest[]> {
    return LedgerRequest.query(tx).select().where({ledgerChannelId, status: 'pending'});
  }

  static async getAllPendingRequests(tx: TransactionOrKnex): Promise<LedgerRequest[]> {
    return LedgerRequest.query(tx).where({status: 'pending'});
  }

  static async requestLedgerFunding(
    channelToBeFunded: Bytes32,
    ledgerChannelId: Bytes32,
    amountA: Uint256, // amount to be removed from/added to participant 0's balance
    amountB: Uint256, // amount to be removed from/added to participant 0's balance
    tx: TransactionOrKnex
  ): Promise<void> {
    await this.setRequest(
      {
        ledgerChannelId,
        status: 'pending',
        channelToBeFunded,
        amountA,
        amountB,
        type: 'fund',
        missedOpportunityCount: 0,
      },
      tx
    );
  }

  static async requestLedgerDefunding(
    channelToBeFunded: Bytes32,
    ledgerChannelId: Bytes32,
    amountA: Uint256, // amount to be removed from/added to participant 0's balance
    amountB: Uint256, // amount to be removed from/added to participant 0's balance
    tx: TransactionOrKnex
  ): Promise<void> {
    await this.setRequest(
      {
        ledgerChannelId,
        status: 'pending',
        channelToBeFunded,
        amountA,
        amountB,
        type: 'defund',
        missedOpportunityCount: 0,
      },
      tx
    );
  }

  static async markLedgerRequestsSuccessful(
    requests: Bytes32[],
    type: 'fund' | 'defund',
    tx: TransactionOrKnex
  ): Promise<void> {
    await Promise.all(
      requests.map(req => LedgerRequest.setRequestStatus(req, type, 'succeeded', tx))
    );
  }
}
