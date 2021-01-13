import {
  objectiveId,
  Objective,
  OpenChannel,
  CloseChannel,
  State,
  SharedObjective,
  SubmitChallenge,
} from '@statechannels/wallet-core';
import {Model, TransactionOrKnex} from 'objection';
import _ from 'lodash';

function extractReferencedChannels(objective: Objective): string[] {
  switch (objective.type) {
    case 'OpenChannel':
    case 'CloseChannel':
    case 'VirtuallyFund':
    case 'SubmitChallenge':
      return [objective.data.targetChannelId];
    case 'FundGuarantor':
      return [objective.data.guarantorId];
    case 'FundLedger':
    case 'CloseLedger':
      return [objective.data.ledgerId];

    default:
      return [];
  }
}

type ObjectiveStatus = 'pending' | 'approved' | 'rejected' | 'failed' | 'succeeded';

/**
 * Objectives that are currently supported by the server wallet (wire format)
 */
export type SupportedWireObjective = OpenChannel | CloseChannel;

export type DBOpenChannelObjective = OpenChannel & {objectiveId: string; status: ObjectiveStatus};
export type DBCloseChannelObjective = CloseChannel & {
  objectiveId: string;
  status: ObjectiveStatus;
};

export type DBSubmitChallengeObjective = {
  data: {targetChannelId: string; challengeState: State};
  objectiveId: string;
  status: ObjectiveStatus;
  type: 'SubmitChallenge';
};

export function isSharedObjective(
  objective: DBObjective
): objective is DBOpenChannelObjective | DBCloseChannelObjective {
  return objective.type === 'OpenChannel' || objective.type === 'CloseChannel';
}

/**
 * A DBObjective is a wire objective with a status and an objectiveId
 *
 * Limited to 'OpenChannel' and 'CloseChannel', which are the only objectives
 * that are currently supported by the server wallet
 */
export type DBObjective =
  | DBOpenChannelObjective
  | DBCloseChannelObjective
  | DBSubmitChallengeObjective;

export const toWireObjective = (dbObj: DBObjective): SharedObjective => {
  if (dbObj.type === 'SubmitChallenge') {
    throw new Error('SubmitChallenge objectives are not supported as wire objectives');
  }
  return _.omit(dbObj, ['objectiveId', 'status']);
};

export class ObjectiveChannelModel extends Model {
  readonly objectiveId!: DBObjective['objectiveId'];
  readonly channelId!: string;

  static tableName = 'objectives_channels';
  static get idColumn(): string[] {
    return ['objectiveId', 'channelId'];
  }
}

export class ObjectiveModel extends Model {
  readonly objectiveId!: DBObjective['objectiveId'];
  readonly status!: DBObjective['status'];
  readonly type!: DBObjective['type'];
  readonly data!: DBObjective['data'];

  static tableName = 'objectives';
  static get idColumn(): string[] {
    return ['objectiveId'];
  }

  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  static get relationMappings() {
    // Prevent a require loop
    // https://vincit.github.io/objection.js/guide/relations.html#require-loops
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {Channel} = require('./channel');

    return {
      objectivesChannels: {
        relation: Model.ManyToManyRelation,
        modelClass: Channel,
        join: {
          from: 'objectives.objectiveId',
          through: {
            from: 'objectives_channels.objectiveId',
            to: 'objectives_channels.channelId',
          },
          to: 'channels.channelId',
        },
      },
    };
  }

  static async insert(
    objectiveToBeStored: (SupportedWireObjective | SubmitChallenge) & {
      status: 'pending' | 'approved' | 'rejected' | 'failed' | 'succeeded';
    },
    tx: TransactionOrKnex
  ): Promise<ObjectiveModel> {
    const id: string = objectiveId(objectiveToBeStored);

    return tx.transaction(async trx => {
      const objective = await ObjectiveModel.query(trx).insert({
        objectiveId: id,
        status: objectiveToBeStored.status,
        type: objectiveToBeStored.type,
        data: objectiveToBeStored.data,
      });

      // Associate the objective with any channel that it references
      // By inserting an ObjectiveChannel row for each channel
      // Requires objective and channels to exist
      await Promise.all(
        extractReferencedChannels(objectiveToBeStored).map(async value =>
          ObjectiveChannelModel.query(trx).insert({objectiveId: id, channelId: value})
        )
      );
      return objective;
    });
  }

  static async forId(objectiveId: string, tx: TransactionOrKnex): Promise<DBObjective> {
    const model = await ObjectiveModel.query(tx).findById(objectiveId);
    return model.toObjective();
  }

  static async approve(objectiveId: string, tx: TransactionOrKnex): Promise<void> {
    await ObjectiveModel.query(tx).findById(objectiveId).patch({status: 'approved'});
  }

  static async succeed(objectiveId: string, tx: TransactionOrKnex): Promise<void> {
    await ObjectiveModel.query(tx).findById(objectiveId).patch({status: 'succeeded'});
  }

  static async forChannelIds(
    targetChannelIds: string[],
    tx: TransactionOrKnex
  ): Promise<DBObjective[]> {
    const objectiveIds = (
      await ObjectiveChannelModel.query(tx)
        .column('objectiveId')
        .select()
        .whereIn('channelId', targetChannelIds)
    ).map(oc => oc.objectiveId);

    return (await ObjectiveModel.query(tx).findByIds(objectiveIds)).map(m => m.toObjective());
  }

  toObjective(): DBObjective {
    return {
      ...this,
      participants: [],
      data: this.data as any, // Here we will trust that the row respects our types
    };
  }
}
