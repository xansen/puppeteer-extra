import Debug from 'debug'
const debug = Debug('playwright-extra:puppeteer-compat')

import type * as pw from 'playwright-core'

export type PlaywrightObject = pw.Page | pw.Frame | pw.Browser

export interface PuppeteerBrowserShim {
  isCompatShim?: boolean
  isPlaywright?: boolean
  pages?: pw.BrowserContext['pages']
  userAgent: () => Promise<'string'>
}

export interface PuppeteerPageShim {
  isCompatShim?: boolean
  isPlaywright?: boolean
  browser?: () => pw.Browser
  evaluateOnNewDocument?: pw.Page['addInitScript']
  _client: () => pw.CDPSession
}

export const isPlaywrightPage = (obj: unknown): obj is pw.Page => {
  return 'unroute' in (obj as pw.Page)
}
export const isPlaywrightFrame = (obj: unknown): obj is pw.Frame => {
  return ['parentFrame', 'frameLocator'].every(x => x in (obj as pw.Frame))
}
export const isPlaywrightBrowser = (obj: unknown): obj is pw.Browser => {
  return 'newContext' in (obj as pw.Browser)
}
export const isPuppeteerCompat = (obj?: unknown): obj is PlaywrightObject => {
  return !!obj && typeof obj === 'object' && !!(obj as any).isCompatShim
}


/** Augment a Playwright object with compatibility with certain Puppeteer methods */
export function addPuppeteerCompat<
  Input extends pw.Page | pw.Frame | pw.Browser | null
>(object: Input): Input {
  if (!object || typeof object !== 'object') {
    return object
  }
  if (isPuppeteerCompat(object)) {
    return object
  }
  if (isPlaywrightPage(object) || isPlaywrightFrame(object)) {
    const shim = createPageShim(object)
    return shim as Input
  }
  if (isPlaywrightBrowser(object)) {
    const shim = createBrowserShim(object)
    return shim as Input
  }
  debug('Received unknown object:', Reflect.ownKeys(object))
  return object
}

// Only chromium browsers support CDP
const dummyCDPClient = {
  send: async (...args: any[]) => {
    debug('dummy CDP client called', 'send', args)
  },
  on: (...args: any[]) => {
    debug('dummy CDP client called', 'on', args)
  }
} as pw.CDPSession

export async function getPageCDPSession(page: pw.Page | pw.Frame) {
  debug('getPageCDPSession: use new')
  const context = isPlaywrightFrame(page)
    ? page.page().context()
    : page.context()
  try {
    const session = await context.newCDPSession(page)
    return session
  } catch (err: any) {
    debug('getPageCDPSession: error while creating session:', err.message)
    debug(
      'getPageCDPSession: Unable create CDP session (most likely a different browser than chromium) - returning a dummy'
    )
  }
  return dummyCDPClient
}

export async function getBrowserCDPSession(browser: pw.Browser) {
  debug('getBrowserCDPSession: use new')
  try {
    const session = await browser.newBrowserCDPSession()
    return session
  } catch (err: any) {
    debug('getBrowserCDPSession: error while creating session:', err.message)
    debug(
      'getBrowserCDPSession: Unable create CDP session (most likely a different browser than chromium) - returning a dummy'
    )
  }
  return dummyCDPClient
}

export function createPageShim(page: pw.Page | pw.Frame) {
  const objId = Math.random().toString(36).substring(2, 7)
  const shim = new Proxy(page, {
    get(target, prop) {
      if (prop === 'isCompatShim' || prop === 'isPlaywright') {
        return true
      }
      debug('page - get', objId, prop)
      if (prop === '_client') {
        return () => ({
          send: async (method: string, params: any) => {
            const session = await getPageCDPSession(page)
            return await session.send(method as any, params)
          },
          on: (event: string, listener: any) => {
            getPageCDPSession(page).then(session => {
              session.on(event as any, listener)
            })
          }
        })
      }
      if (prop === 'setBypassCSP') {
        return async (enabled: boolean) => {
          const session = await getPageCDPSession(page)
          return await session.send('Page.setBypassCSP', {
            enabled
          })
        }
      }
      if (prop === 'setUserAgent') {
        return async (userAgent: string, userAgentMetadata?: any) => {
          const session = await getPageCDPSession(page)
          return await session.send('Emulation.setUserAgentOverride', {
            userAgent,
            userAgentMetadata
          })
        }
      }
      if (prop === 'browser') {
        if (isPlaywrightPage(page)) {
          return () => {
            let browser = page.context().browser()
            if (!browser) {
              debug(
                'page.browser() - not available, most likely due to launchPersistentContext'
              )
              // Use a page shim as quick drop-in (so browser.userAgent() still works)
              browser = page as any
            }
            return addPuppeteerCompat(browser)
          }
        }
      }
      if (prop === 'evaluateOnNewDocument') {
        if (isPlaywrightPage(page)) {
          return async function (pageFunction: any | string, ...args: any[]) {
            return await page.addInitScript(pageFunction, args[0])
          }
        }
      }
      // Only relevant when page is being used a pseudo stand-in for the browser object (launchPersistentContext)
      if (prop === 'userAgent') {
        return async (enabled: boolean) => {
          const session = await getPageCDPSession(page)
          const data = await session.send('Browser.getVersion')
          return data.userAgent
        }
      }
      return Reflect.get(target, prop)
    }
  })
  return shim
}

export function createBrowserShim(browser: pw.Browser) {
  const objId = Math.random().toString(36).substring(2, 7)
  const shim = new Proxy(browser, {
    get(target, prop) {
      if (prop === 'isCompatShim' || prop === 'isPlaywright') {
        return true
      }
      debug('browser - get', objId, prop)
      if (prop === 'pages') {
        return () =>
          browser
            .contexts()
            .flatMap(c => c.pages().map(page => addPuppeteerCompat(page)))
      }
      if (prop === 'userAgent') {
        return async () => {
          const session = await getBrowserCDPSession(browser)
          const data = await session.send('Browser.getVersion')
          return data.userAgent
        }
      }
      return Reflect.get(target, prop)
    }
  })
  return shim
}
