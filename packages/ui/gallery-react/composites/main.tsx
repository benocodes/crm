// The mount file of the composites page ([[UI443]] cycle 1, P4): the settings-layout composites in every state, served under `APP_CSP`.
// `?theme=light|dark` forces a theme as on the components page; `?view=parts|shell|shell-bare` picks what renders (a shell owns the page's
// landmarks, so each shell state is a view of its own).
import { createRoot } from 'react-dom/client'
import { Composites } from './composites'

const params = new URLSearchParams(location.search)
const theme = params.get('theme')
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
createRoot(document.getElementById('root')!).render(<Composites view={params.get('view') ?? 'parts'} />)
