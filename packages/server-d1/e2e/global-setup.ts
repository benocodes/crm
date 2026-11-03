import { clerkSetup } from '@clerk/testing/playwright'

// Fetches Clerk's testing token (bot-protection bypass) for the development instance whose keys playwright.config.ts loaded from `.env.dev`.
export default async function globalSetup(): Promise<void> {
  await clerkSetup({ publishableKey: process.env.CLERK_PUBLISHABLE_KEY })
}
