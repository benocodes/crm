// [[API7]] D7, D12 ([[API220]]): STUB for the red commit.
export async function signatureHeader(_a: { secrets: string[]; id: string; timestamp: number; body: string }): Promise<string> {
  throw new Error('not implemented')
}
export function secretsInForce<T extends { created_at: string }>(_rows: readonly T[], _now: Date): T[] {
  throw new Error('not implemented')
}
