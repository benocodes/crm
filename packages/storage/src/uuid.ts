// UUIDv7 minted by the application (spec D9): 48-bit millisecond time, a 12-bit counter that makes ids
// strictly increasing within a process even inside one millisecond or under a clock that steps back, then
// random bits. Web Crypto only, so it runs in workerd and Node alike.

let lastMs = -1
let counter = 0

const hex = (n: number, width: number): string => n.toString(16).padStart(width, '0')

export function uuidv7(now: Date = new Date()): string {
  let ms = Math.max(now.getTime(), lastMs)
  if (ms === lastMs) {
    counter += 1
    if (counter > 0xfff) {
      ms += 1
      counter = randomCounterStart()
    }
  } else {
    counter = randomCounterStart()
  }
  lastMs = ms
  const rand = crypto.getRandomValues(new Uint8Array(8))
  rand[0] = (rand[0]! & 0x3f) | 0x80 // variant 10xx
  const tail = [...rand].map((b) => hex(b, 2)).join('')
  const time = hex(ms, 12)
  return `${time.slice(0, 8)}-${time.slice(8)}-7${hex(counter, 3)}-${tail.slice(0, 4)}-${tail.slice(4)}`
}

// Start below the top of the range so a burst within one millisecond has headroom before it must advance the clock.
const randomCounterStart = (): number => crypto.getRandomValues(new Uint16Array(1))[0]! & 0x3ff
