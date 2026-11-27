// The question set (OPS670 D3). Stub: the red commit.
export type NoulQuestion = { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> }
export type ScoreQuestion = { type: 'score'; instructions: string; criteria: string[] }
export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion
export const QUESTION_SET_VERSION = ''
export const QUESTIONS: Record<string, Question> = {}
