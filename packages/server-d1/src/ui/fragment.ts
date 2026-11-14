// The one-time token of an invitation or reset link rides the URL fragment ([[CORE245]] P3, [[UI246]] D6): a browser never sends it and no server log sees it. A page reads it once and removes the
// fragment from the address bar before it renders, so the token is not left in history, a screenshot or a shared address.
export function takeFragmentToken(): string | null {
  const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('token')
  if (location.hash !== '') history.replaceState(history.state, '', location.pathname + location.search)
  return token === null || token === '' ? null : token
}
