// shadcn's `cn()` ([[UI445]] D4): class names merged so a later Tailwind utility wins over an earlier one.
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
