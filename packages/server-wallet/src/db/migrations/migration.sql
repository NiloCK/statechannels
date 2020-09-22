DROP SCHEMA IF EXISTS "client_utils" CASCADE;
CREATE SCHEMA "client_utils";

CREATE OR REPLACE FUNCTION client_utils.trigger_set_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


CREATE TABLE "client_utils"."payment_channels"
(
  "channel_id" TEXT NOT NULL PRIMARY KEY,
  "context_id" TEXT NOT NULL,
  "turn_number" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_timestamp
BEFORE UPDATE ON "client_utils"."payment_channels"
FOR EACH ROW EXECUTE PROCEDURE client_utils.trigger_set_timestamp();


CREATE INDEX channel_lookup_by_context_idx ON "client_utils"."payment_channels"
  (context_id);

CREATE INDEX channel_lookup_idx ON "client_utils"."payment_channels"
  (context_id, turn_number, channel_id);


-- Insert some seed data

INSERT INTO "client_utils"."payment_channels"
  ("channel_id", "context_id", "turn_number")
VALUES 
  ('0x60182385714FC5092baF37A86AB1da2e9aB204d3', 'context-1', 949),
  ('0x4A41618685588D4D87d598938ECEf19Cb40812B6', 'context-1', 73),
  ('0xDB549364c6eF69C837574d2982BBd7e6E56d465E', 'context-1', 592),
  ('0x6c66EBd9DF1Fd847016F97B3E18ED3624dab2c65', 'context-1', 427),
  ('0x96915bddDa8815843a19234C088C76d7A5F39f21', 'context-2', 195),
  ('0x70867404bC4A9a9faAd082FcBA48F6deDFc4d665', 'context-2', 576),
  ('0x66dF9e0506CA0998063b8094c9B90cbDc1359DdE', 'context-2', 599),
  ('0x062b9a68B5B1cB464210d4627BF02607123F7386', 'context-2', 633),
  ('0x167007819e008F174493D10883a4bf90D5B8B275', 'context-2', 1000),
  ('0x6e236C7D7bc6F77D5E6D345318e7D0e0080de95f', 'context-2', 78),
  ('0xfed243cD59fAC8aF8932d7790C182426618a3b66', 'context-2', 219),
  ('0x14178376608D31d9002C123Aa3Baa6F84b85D7B5', 'context-3', 451),
  ('0x32F8CB1d2fd0b69A01f984EeffE563054c1b7bc8', 'context-3', 837),
  ('0x2d2513ce9968C2FbE525997E1D8bf1ecE22fE625', 'context-3', 5),
  ('0x70cD5A7C3De3dD9C56374B9b2018eC6ED4738bC8', 'context-3', 273),
  ('0x9EC221C83279E9a39FF096435Bd7D25637bf1200', 'context-3', 994),
  ('0xadC8fC9894A1f8c3092Fbb23c818AD2D302BEbA7', 'context-3', 307),
  ('0x522B8e4DF2be2dB92F7a761E417cd903B03f2c4f', 'context-3', 3),
  ('0x52a9578Fb2Df0bC263a2c6BB141DD37d2eE54269', 'context-3', 4),
  ('0x4b9e4500d28D1e28C10432def0641e42F021493a', 'context-3', 5),
  ('0xF1B229FA0A5AF285ce940c03b636493DF21DB22f', 'context-3', 6),
  ('0xE1233dBf2C8b80324fD3E89711eAF4be3580d14E', 'context-3', 7),
  ('0x5a0c1B0839A5Bfb5739f6B3F14Aa81E0fcfc28B3', 'context-3', 8),
  ('0xe51D9f48573e2b26B8Ed2D66c4d4663E73412923', 'context-3', 9),
  ('0xB13c2dF281dfC80111f1c8721653303a41AE9C89', 'context-3', 10),
  ('0x767100D541394c7325d2fe4ED104A8fA478153bb', 'context-3', 11),
  ('0xc22707f2c52A210EA37059B7773843074FD77C1f', 'context-3', 12),
  ('0x5932A60CC075184346D870a1ca74F65F2C356B12', 'context-3', 13),
  ('0x59Aa0580260793E3b21fA9c1e65383355ea058E6', 'context-3', 14),
  ('0x7f479801Af6777256e171Feaa3B58252140950C0', 'context-3', 15),
  ('0x55B305DaDb4a0A6E4e0d220a84a0b4bf6Fca343c', 'context-3', 16),
  ('0x947519A7ce7B0B2C750009a24872ab541b4C2455', 'context-3', 17),
  ('0xa406D62c906b547dad92B48EDb27bBD964441386', 'context-3', 18),
  ('0xbAbB0b254c8990873581966653572b3eaFf96003', 'context-3', 19),
  ('0x6F3aB3bfE5Bc12eeDe8DEDBb9638187fd8Ae5972', 'context-3', 20),
  ('0x8A9005851C7cf5331DD57eBB1dc74A753699625E', 'context-3', 21),
  ('0x11E4A829e2E6c3e8e11A798A3dad83A87bf5cCbF', 'context-3', 22),
  ('0xDB101dac8EFb33C9f320A20b2F9fd8EF7174FF48', 'context-3', 23),
  ('0x9F59C2798584f74673f194860020bDB4fd09fd12', 'context-3', 24),
  ('0x8d670C6bd791ae736A370EB6A2ef80e4Cce6aB1d', 'context-3', 25),
  ('0x7d793D12383d1Bf0c6ccA27C106288D4a1A094e8', 'context-3', 26),
  ('0x454C1F037128CB7a4466f96c417F2957ad618dD1', 'context-3', 27),
  ('0x73A3C6EA486fB2378f11B3F387380540BC1c9bA4', 'context-3', 28),
  ('0xd4677667eBF259c3cA00b2Be6F71E3DB9246D0CB', 'context-3', 29),
  ('0x79ef8aD0Ac1C35CC2ac79Dd92dE1868BA2ca40db', 'context-3', 30),
  ('0xa69C359F7b1fA4203c225A8dDd5e772D424CEEe3', 'context-3', 31),
  ('0x1A469A4b7e48aBd3eB8e17717b8AD2fa9fC349CC', 'context-3', 32),
  ('0xE0960203fff85A6e3F5ed997e4130A5B1006A13b', 'context-3', 33),
  ('0xf8c65Ab17fDA1700C70111F35BF3EABc8376a653', 'context-3', 34),
  ('0x319CafA09736Ca24C85Ed1c885d71746595639E2', 'context-3', 35),
  ('0x76338A551C035E18Bd5620e9F53396D7e699451d', 'context-3', 36),
  ('0xeA5d4c4861457193bda7e2C76858c33050bBFb16', 'context-3', 37),
  ('0xaF2B60d8B8F7f76d5cDA63873A9c269b77c6FAe5', 'context-3', 38),
  ('0x174929EEe312Cb3334BEa61421fbd18275231D08', 'context-3', 39),
  ('0xc86D4390CffAEB40302a8272Ba90A55c28675Ab4', 'context-3', 40),
  ('0x8053e92696a49f751ca78d6427851D741e3687F6', 'context-3', 41),
  ('0x4b446A658dE78901A77fd6517Fb2e9A8BEc1cE96', 'context-3', 42),
  ('0x1b90893288C6285dbC77EfE4D7DA832224e71690', 'context-3', 43),
  ('0x6Af817A108C405145f2e564AcC290ce214cfa818', 'context-3', 44),
  ('0xE0075cCD49f966DFdb243EF2895F9F831BB91621', 'context-3', 45),
  ('0x68d4d673520ac8cB8Ef3DA2ad40fFccB07b531D1', 'context-3', 46),
  ('0x67cB4f60C65711970f1CfC71d90FA3Ed997e8Dcd', 'context-3', 47),
  ('0x40832806bdC1e54Ac11eFEEaBe5685416207A167', 'context-3', 48),
  ('0x03A08fD0150Fae6181D5DCEe91826BE3ceF317E2', 'context-3', 49),
  ('0xC191F7b756F1A1Cd7ebC230c6c5dBce9334B1c17', 'context-3', 50),
  ('0x2cEF35838A3ADf5f6f4B2b04B208ed3F10932Df9', 'context-3', 51),
  ('0xE6ef0168ca5f134C2BFd464F61D51978248C07EE', 'context-3', 52);

EXPLAIN ANALYZE (
  SELECT * FROM client_utils.payment_channels
  WHERE context_id = 'context-11'
  AND turn_number % 2 = 1
  LIMIT 1 
  FOR UPDATE
  SKIP LOCKED
);