// The mount file of the lists page ([[UI458]] cycle 1, P5). `?theme=light|dark` forces a theme; `?view=` picks `lists` or a `dialog-*` state.
import { createRoot } from 'react-dom/client'
import { ListsPage } from './lists'

const params = new URLSearchParams(location.search)
const theme = params.get('theme')
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
createRoot(document.getElementById('root')!).render(<ListsPage view={params.get('view') ?? 'lists'} />)
