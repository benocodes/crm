import { describe, expect, it } from 'vitest'
import { QUESTION_SET_VERSION, QUESTIONS } from './questions.ts'

// OPS670 D3: the question set is the spec's table, in one versioned file.
describe('the question set (D3)', () => {
  it('has a version string', () => {
    expect(QUESTION_SET_VERSION).toMatch(/\S/)
  })

  it('has the fourteen keys, with their types', () => {
    const types = Object.fromEntries(Object.entries(QUESTIONS).map(([k, q]) => [k, q.type]))
    expect(types).toEqual({
      expected_source: 'choice',
      exercises: 'choice',
      r1_inventory_breaks_it: 'noul',
      r2_inventory_size: 'noul',
      r3_parked_target: 'noul',
      r4_existence_only: 'noul',
      r5_mock_echo: 'noul',
      r6_library_behaviour: 'noul',
      r7_past_transition: 'noul',
      k1_refusal: 'noul',
      k2_names_bug: 'noul',
      k3_invariant: 'noul',
      k4_entry_point_result: 'noul',
      bug_risk_if_deleted: 'score',
    })
  })

  it('has the spec options on the two choice questions', () => {
    expect(Object.keys(QUESTIONS.expected_source?.criteria ?? {})).toEqual([
      'own_fixtures',
      'declared_inventory',
      'generated_fixture',
      'refusal',
      'other',
    ])
    expect(Object.keys(QUESTIONS.exercises?.criteria ?? {})).toEqual([
      'entry_point',
      'internal_function',
      'schema_metadata',
      'source_text',
      'constant_only',
    ])
  })

  it('every noul question has instructions and true and false criteria; the score has five levels', () => {
    for (const [key, q] of Object.entries(QUESTIONS)) {
      expect(q.instructions, key).toMatch(/\S{3}/)
      if (q.type === 'noul') {
        expect(q.criteria.true, key).toMatch(/\S{3}/)
        expect(q.criteria.false, key).toMatch(/\S{3}/)
      }
      if (q.type === 'choice') for (const d of Object.values(q.criteria)) expect(d).toMatch(/\S{3}/)
    }
    const score = QUESTIONS.bug_risk_if_deleted
    expect(score?.type === 'score' && score.criteria).toHaveLength(5)
  })
})
