// The core D1 migrations this build expects ([[CORE61]] D2): wrangler records each applied file by name in `d1_migrations`,
// and the Worker compares names only. The hash is the immutability record, checked against the files by
// `migrations-manifest.test.ts` (D5). Add a new file here in the same change that creates it.
export const MIGRATIONS: readonly { readonly name: string; readonly sha256: string }[] = [
  { name: '0001_typed_storage_core.sql', sha256: '840803636a61ff83981a1167fcf1f821028be70e401f60e92c52a56e35aa2b28' },
  { name: '0002_identity_model.sql', sha256: '07e1acd7c69725566cbc1f4c1f1ff679901fc674604e47e9ee0994a507834e04' },
  { name: '0003_administration.sql', sha256: '0bb874b36add95daf240289cdecaab72f33771c38d2a9ecd9cc64562e4307298' },
  { name: '0004_messaging_model.sql', sha256: 'f0f593123db2e36be74679eec659a723c68fe6127c9d96a541416a885afabe18' },
  { name: '0005_associations.sql', sha256: 'b394e82a489bf55cfd2e96768cedb903c7e40750de160a88ac1b103b4a895720' },
  { name: '0006_notes.sql', sha256: '23f84b50970ff072c96f145c3dc505f1de75f7c1a59a156eb7a4d95963457a06' },
  { name: '0007_agent_principals.sql', sha256: 'fb5089a327faa39307c392026d0ad3405cfc253c9c626922ccf4592a287ea2b9' },
  { name: '0008_tags.sql', sha256: '97fc288974ee61d84825b34982be96cc103896a43db561c93d9ddbfd0a80686f' },
  { name: '0009_deals.sql', sha256: '347580988c57aed61ec7d196a7cb0fc37c5b4312943be14998a40d1268111ae6' },
  { name: '0010_gmail_capture.sql', sha256: '7344e270458ce89205f806a7b864fcc7750650b4e1e5466451c53b7d2f13e882' },
  { name: '0011_action_requests.sql', sha256: '6a8f58182f94f91b18870e2ca35c7e056c4608cec35fc207f75efb3474d884d2' },
  { name: '0012_action_executions.sql', sha256: '944cf0a990c42c13a02544f572d12eccc237d94a5c49f693a270d8fa69dcbfd9' },
  { name: '0013_send_connection.sql', sha256: 'b303609fe45131a0535978aa185af957a10e424d0906174dcedd4508f93a88d5' },
  { name: '0014_search_indexes.sql', sha256: 'efc3f4f79ef3d5185cf0288a16ef5b0c5e3470aa852442d9004bed3e79958628' },
  { name: '0015_event_sequence.sql', sha256: '03e4e9625506319fa269ecff4c83bbda9065e0326abeb1ffbad5b4fcd8ce5eb1' },
  { name: '0016_webhooks.sql', sha256: 'd90a949693c7a07a587d06da1006137700efdb8566c857d7e0f2c91ffc8ecbfa' },
  { name: '0017_webhook_deliveries.sql', sha256: '35d3550e1f5837d29f756dcc593599c9eb2a4a90cdb228b64ec7b397dd178293' },
  { name: '0018_auth_tables.sql', sha256: 'f137071da09fcd78880950efb157a38d05dd2f703d5d2f8681cd279c3c058967' },
  { name: '0019_drop_auth_tables.sql', sha256: '292bcca70d8df37eb19ee2a4ccdd81242bd719fe4f46082377bf091bfaa81376' },
]
