// The focus ring every focusable component carries: a 2px outline plus a ring, both on `:focus-visible`. shadcn's own classes pair a ring with
// `outline-none`, which loses the indicator where a ring does not render (forced colours, [[UI445]] cycle 1's gallery); this keeps the outline.
export const focusRing =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:ring-2 focus-visible:ring-ring'
