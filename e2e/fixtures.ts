import { test as base, expect } from '@playwright/test'
import * as fs   from 'fs'
import * as path from 'path'

export interface E2EContext {
  orgId:    string
  pmUserId: string
}

function loadContext(): E2EContext {
  const file = path.join(__dirname, '.auth', 'context.json')
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as E2EContext
}

// Extend base test with typed context fixture
const test = base.extend<{ ctx: E2EContext }>({
  ctx: async ({}, use) => {
    await use(loadContext())
  },
})

export { test, expect }
