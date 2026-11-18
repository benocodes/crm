// [[UI467]] ([[UI458]]): the Connected accounts page.
export interface AccountsPageProps {
  api: unknown
  userId: string
  scopes: readonly string[]
  now?: () => Date
  navigate?: (url: string) => void
}
export function AccountsPage(_props: AccountsPageProps): never {
  throw new Error('not implemented')
}
