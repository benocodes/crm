// The mount file of the React gallery ([[UI445]] D9): the one place that imports `react-dom`. `?theme=light|dark` forces a theme through
// `data-theme`; without it the page follows the emulated `prefers-color-scheme`.
import { createRoot } from 'react-dom/client'
import { Gallery } from './gallery'

const theme = new URLSearchParams(location.search).get('theme')
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
createRoot(document.getElementById('root')!).render(<Gallery />)
