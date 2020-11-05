import * as Knex from 'knex';

import {addAddressCheck, addBytes32Check, dropConstraint} from '../utils';

import {
  dropByteConstraints as dropOldByteConstraints,
  addByteContraints as addOldByteContraints,
} from './20200707165856_initial';

const channels = 'channels';
const signingWallets = 'signing_wallets';

export async function addByteContraints(knex: Knex): Promise<void> {
  await addBytes32Check(knex, signingWallets, 'private_key');
  await addAddressCheck(knex, signingWallets, 'address');

  await addBytes32Check(knex, channels, 'channel_id');
  await addAddressCheck(knex, channels, 'app_definition');
  await addAddressCheck(knex, channels, 'signing_address');
}

export async function dropByteConstraints(knex: Knex): Promise<void> {
  await dropConstraint(knex, signingWallets, 'private_key_is_bytes32');
  await dropConstraint(knex, signingWallets, 'address_is_address');

  await dropConstraint(knex, channels, 'channel_id_is_bytes32');
  await dropConstraint(knex, channels, 'app_definition_is_address');
  await dropConstraint(knex, channels, 'signing_address_is_address');
}

export async function up(knex: Knex): Promise<any> {
  await dropOldByteConstraints(knex);
  await addByteContraints(knex);
}

export async function down(knex: Knex): Promise<any> {
  await dropByteConstraints(knex);
  await addOldByteContraints(knex);
}
