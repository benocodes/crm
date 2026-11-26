// Writes public/og.png, the 1200x630 social preview card: the logo, centered, in the docs' dark colours.
// Run it when the logo changes: pnpm -C packages/docs og:generate
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const WIDTH = 1200
const HEIGHT = 630
const LOGO_WIDTH = 760
const BACKGROUND = '#080708' // --vibase-black
const FOREGROUND = '#e6e8e6' // --vibase-white

const logoSvg = readFileSync(fileURLToPath(new URL('../src/assets/logo.svg', import.meta.url)), 'utf8').replaceAll(
  'fill="black"',
  `fill="${FOREGROUND}"`,
)
const logo = await sharp(Buffer.from(logoSvg), { density: 300 }).resize({ width: LOGO_WIDTH }).png().toBuffer()
const { height } = await sharp(logo).metadata()

await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 4, background: BACKGROUND } })
  .composite([
    { input: logo, left: Math.round((WIDTH - LOGO_WIDTH) / 2), top: Math.round((HEIGHT - (height ?? 0)) / 2) },
  ])
  .png({ compressionLevel: 9 })
  .toFile(fileURLToPath(new URL('../public/og.png', import.meta.url)))
console.log('wrote public/og.png')
