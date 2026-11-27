// The question set (OPS670 D3): one fixed set, sent in full with every case. Every question is answerable from the
// state alone (the test file's own text), with no counting and no comparison with other tests.
// Any change to a question's text, key or options is a new version: bump QUESTION_SET_VERSION, and the next run asks everything again.
export type NoulQuestion = { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> }
export type ScoreQuestion = { type: 'score'; instructions: string; criteria: string[] }
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion

export const QUESTION_SET_VERSION = '1'

const noul = (instructions: string, yes: string, no: string): NoulQuestion => ({
  type: 'noul',
  instructions,
  criteria: { true: yes, false: no },
})

export const QUESTIONS: Record<string, Question> = {
  expected_source: {
    type: 'choice',
    instructions: "Where does the expected value in this test's assertions come from?",
    criteria: {
      own_fixtures: 'Rows or values the test itself created or passed in.',
      declared_inventory:
        'A hand-written list of things the product declares: columns, operations, scopes, routes, tables or names.',
      generated_fixture: 'A generated fixture or golden file that the test reads or compares against.',
      refusal: 'An error or a refusal: a status code, an error code or a thrown error.',
      other: 'None of the above.',
    },
  },
  exercises: {
    type: 'choice',
    instructions: 'What does this test run?',
    criteria: {
      entry_point: 'An operation, an HTTP route or a CLI command, called the way a client calls it.',
      internal_function: 'An internal function or class, called directly.',
      schema_metadata: 'Database schema metadata: table or column listings, pragma output, migration state.',
      source_text: 'A source file read as text, matched or parsed to check what it contains.',
      constant_only: 'Only a constant or an import: nothing is executed beyond reading a value.',
    },
  },
  r1_inventory_breaks_it: noul(
    'Would adding a new column, operation, scope or route, with no bug, make this test fail?',
    'Yes: the test pins a complete list or count, so a legitimate addition turns it red.',
    'No: a legitimate addition leaves this test green.',
  ),
  r2_inventory_size: noul(
    'Does it assert the size of a product inventory, as opposed to rows the test created?',
    'Yes: it asserts how many columns, operations, scopes, routes or tables the product has.',
    'No: any size it asserts is of data the test itself created.',
  ),
  r3_parked_target: noul(
    'Is the thing it compares against Postgres, an old name or a removed feature?',
    'Yes: the comparison target is a parked Postgres adapter, a name that was renamed away, or a feature that was removed.',
    'No: the comparison target is current D1 behaviour or current names.',
  ),
  r4_existence_only: noul(
    'Is its strongest assertion that something merely exists or does not throw?',
    'Yes: it only checks that a value is defined, a file exists or a call does not throw.',
    'No: it checks a specific value, state or error.',
  ),
  r5_mock_echo: noul(
    'Does it assert that a stub was called with arguments the test itself supplied?',
    'Yes: the assertion is that a mock or spy received what the test just passed in.',
    'No: it asserts a result or an effect, not the echo of its own input.',
  ),
  r6_library_behaviour: noul(
    'Is the behaviour it asserts provided by a library (zod, SQLite, Kysely), not by Vibase code?',
    'Yes: the assertion would hold with no Vibase code at all, because the library does the work.',
    'No: the behaviour asserted is Vibase logic.',
  ),
  r7_past_transition: noul(
    'Does it only prove that a past migration or rename happened?',
    'Yes: it checks that an old schema or name changed into the new one, and nothing else.',
    'No: it checks behaviour that still has to keep working.',
  ),
  k1_refusal: noul(
    'Does it assert a refusal for permission, scope, authentication or input validation?',
    'Yes: it checks that a caller without the right, or sending bad input, is refused.',
    'No: it asserts no refusal of that kind.',
  ),
  k2_names_bug: noul(
    'Does its title or a comment name a bug issue?',
    'Yes: the title or a comment refers to an issue or bug number it guards against.',
    'No: no bug or issue is named.',
  ),
  k3_invariant: noul(
    'Does it assert that an event was emitted, that tenancy held or that an import boundary held?',
    'Yes: it checks an emitted event, tenant isolation or an import-boundary rule.',
    'No: it checks none of these.',
  ),
  k4_entry_point_result: noul(
    'Does it call an operation, route or CLI command and check the resulting row, event or response?',
    'Yes: it calls an entry point and asserts what that call produced.',
    'No: it does not call an entry point, or it checks nothing that the call produced.',
  ),
  bug_risk_if_deleted: {
    type: 'score',
    instructions: 'If this test were deleted, how likely is a real bug to ship unnoticed?',
    criteria: [
      'No realistic bug: nothing that matters could break unseen.',
      'A cosmetic or very unlikely bug could ship unseen.',
      'A bug in an ordinary feature could ship unseen.',
      'A bug in an important behaviour could ship unseen.',
      'A bug in a core guarantee (tenancy, permissions, data integrity, events) could ship unseen.',
    ],
  },
}
