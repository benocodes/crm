// The React gallery skeleton ([[UI445]] P1): page code, no component yet. Native elements styled only with token classes, so the
// stack (React, Tailwind, the theme, the CSP) is proven before any shadcn component exists. [[UI448]] renders the components here.
const focus = 'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-2 focus-visible:outline-ring'

export function Gallery() {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-6">
      <h1 className="text-2xl font-semibold">Vibase UI gallery</h1>
      <p className="text-muted-foreground">React, Tailwind and the neutral theme under the pages' CSP.</p>
      <section
        data-gallery-state="buttons"
        className="flex flex-wrap gap-3 rounded-lg border bg-card p-4 text-card-foreground"
      >
        <button type="button" className={`rounded-md bg-primary px-4 py-2 text-primary-foreground ${focus}`}>
          Primary
        </button>
        <button type="button" className={`rounded-md bg-destructive px-4 py-2 text-destructive-foreground ${focus}`}>
          Destructive
        </button>
      </section>
      <section
        data-gallery-state="field"
        className="flex flex-col gap-2 rounded-lg border bg-card p-4 text-card-foreground"
      >
        <label htmlFor="gallery-email" className="text-sm font-medium">
          Email
        </label>
        <input
          id="gallery-email"
          type="email"
          autoComplete="email"
          className={`rounded-md border border-input bg-background px-3 py-2 ${focus}`}
        />
        <p className="text-sm text-destructive">Enter your email address.</p>
      </section>
    </div>
  )
}
