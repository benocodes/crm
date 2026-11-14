// The mount file of the test-only gallery ([[UI254]] D7): the one place that imports `preact` itself. `?theme=light|dark` forces a theme
// through `data-theme`; without it the page follows the emulated `prefers-color-scheme`.
import { render } from 'preact'
import { Gallery } from './gallery'

const theme = new URLSearchParams(location.search).get('theme')
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
render(<Gallery />, document.getElementById('root')!)
