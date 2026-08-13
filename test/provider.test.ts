import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { Disposable, Position, window, workspace } from 'coc.nvim'
import { LanguageProvider } from '../src/languages'
import { MassCodeProvider } from '../src/massCodeProvider'
import { ProviderManager } from '../src/provider'
import { SnipmateProvider } from '../src/snipmateProvider'
import { TextmateProvider } from '../src/textmateProvider'
import { Snippet, TriggerKind } from '../src/types'
import { UltiSnippetsProvider } from '../src/ultisnipsProvider'
import { clearExtensionState, clearFolderState, pythonCodes } from '../src/util'
import { openBuffer, waitFor, waitProviderInit } from './helper'

function makeSnippet(prefix: string, priority: number, body: string): Snippet {
  return {
    filepath: '/tmp/all.snippets',
    lnum: 1,
    body,
    prefix,
    description: body,
    triggerKind: TriggerKind.SpaceBefore,
    filetype: 'all',
    priority
  }
}

describe('ultisnips snippet dedup', () => {
  before(async () => {
    await waitProviderInit()
  })

  it('keeps the higher priority snippet for a duplicated prefix', () => {
    const channel = { appendLine: () => {} } as any
    const config = { extends: {}, excludes: [], trace: false, directories: [] } as any
    const context = { subscriptions: [], asAbsolutePath: () => '' } as any
    const provider = new UltiSnippetsProvider(channel, config, context)
    ;(provider as any).snippetFiles = [
      { filepath: '/plugin/all.snippets', filetype: 'all', clearsnippets: null, snippets: [makeSnippet('foo', 10, 'low-priority-body')] },
      { filepath: '/user/all.snippets', filetype: 'all', clearsnippets: null, snippets: [makeSnippet('foo', 50, 'high-priority-body')] }
    ]
    const res = provider.getSnippets('javascript')
    assert.equal(res.length, 1)
    assert.equal(res[0].body, 'high-priority-body')
    assert.equal(res[0].priority, 50)
  })

  it('keeps the first snippet when priorities are equal', () => {
    const channel = { appendLine: () => {} } as any
    const config = { extends: {}, excludes: [], trace: false, directories: [] } as any
    const context = { subscriptions: [], asAbsolutePath: () => '' } as any
    const provider = new UltiSnippetsProvider(channel, config, context)
    ;(provider as any).snippetFiles = [
      { filepath: '/a/all.snippets', filetype: 'all', clearsnippets: null, snippets: [makeSnippet('bar', 20, 'first-body')] },
      { filepath: '/b/all.snippets', filetype: 'all', clearsnippets: null, snippets: [makeSnippet('bar', 20, 'second-body')] }
    ]
    const res = provider.getSnippets('javascript')
    assert.equal(res.length, 1)
    assert.equal(res[0].body, 'first-body')
  })
})

describe('textmate workspace-folder listener', () => {
  before(async () => {
    await waitProviderInit()
  })

  it('clears state of an unloaded extension so it can be reloaded', () => {
    const definitions: Map<string, Array<{ filepath: string }>> = new Map()
    definitions.set('ext1', [{ filepath: '/ext/js.json' }])
    const loadedFiles = new Set(['/ext/js.json', '/ws/.vscode/a.code-snippets'])
    const loadedSnippets = [
      { filepath: '/ext/js.json', extensionId: 'ext1' },
      { filepath: '/ws/.vscode/a.code-snippets' }
    ]
    const res = clearExtensionState(definitions, loadedFiles, loadedSnippets, 'ext1')
    assert.equal(definitions.has('ext1'), false)
    assert.equal(loadedFiles.has('/ext/js.json'), false)
    assert.equal(loadedFiles.has('/ws/.vscode/a.code-snippets'), true)
    assert.deepEqual(res, [{ filepath: '/ws/.vscode/a.code-snippets' }])
  })

  it('clears state of a removed workspace folder so it can be re-added', () => {
    const loadedFiles = new Set(['/ws/.vscode/a.code-snippets', '/other/b.code-snippets'])
    const loadedRoots = new Set(['/ws/.vscode', '/keep/.vscode'])
    const loadedSnippets = [
      { filepath: '/ws/.vscode/a.code-snippets' },
      { filepath: '/other/b.code-snippets' }
    ]
    const res = clearFolderState(loadedFiles, loadedRoots, loadedSnippets, '/ws')
    assert.equal(loadedRoots.has('/ws/.vscode'), false)
    assert.equal(loadedRoots.has('/keep/.vscode'), true)
    assert.equal(loadedFiles.has('/ws/.vscode/a.code-snippets'), false)
    assert.equal(loadedFiles.has('/other/b.code-snippets'), true)
    assert.deepEqual(res, [{ filepath: '/other/b.code-snippets' }])
  })
})

describe('massCode createSnippet', () => {
  let originalRequest: typeof http.request
  let requestBodies: string[]

  before(async () => {
    await waitProviderInit()
    originalRequest = http.request
    requestBodies = []
    http.request = ((_options: http.RequestOptions, callback?: (res: any) => void) => {
      const res = new EventEmitter() as any
      res.statusCode = 200
      process.nextTick(() => {
        callback?.(res)
        res.emit('data', Buffer.from('{}'))
        res.emit('end')
      })
      return {
        write: (body: string) => {
          requestBodies.push(body)
        },
        on: () => {},
        end: () => {}
      } as any
    }) as any
  })

  after(() => {
    http.request = originalRequest
  })

  it('creates a snippet when the command is invoked without text', async () => {
    const channel = { appendLine: () => {} } as any
    const config = { host: 'localhost', port: 3033, extends: {}, excludes: [], trace: false } as any
    const provider = new MassCodeProvider(channel, config)
    ;(provider as any).init = async () => {}
    const originalRequestInput = window.requestInput
    window.requestInput = async () => 'mass-test' as any
    try {
      await provider.createSnippet()
      assert.ok(requestBodies.length > 0)
      const payload = JSON.parse(requestBodies[0])
      assert.equal(payload.name, 'mass-test')
      assert.equal(payload.content[0].value, '')
      assert.equal(payload.id, '0')
    } finally {
      window.requestInput = originalRequestInput
    }
  })
})

describe('provider manager priority filter', () => {
  before(async () => {
    await waitProviderInit()
  })

  it('keeps numeric and massCode matches so expand is not empty', async () => {
    const subscriptions: Disposable[] = []
    const manager = new ProviderManager({ appendLine: () => {} } as any, subscriptions, {} as any)
    const fakeProvider = (priority: number | undefined) => ({
      getTriggerSnippets: async () => [{ prefix: 'foo', priority }],
    }) as any
    manager.regist(fakeProvider(-1), 'textmate')
    manager.regist(fakeProvider(undefined), 'massCode')
    const originalGetDocument = workspace.getDocument
    workspace.getDocument = (() => ({})) as any
    try {
      const edits = await manager.getTriggerSnippets(1, false, Position.create(0, 3))
      const sources = edits.map(e => e.source)
      assert.ok(sources.includes('massCode'), `massCode dropped: ${JSON.stringify(sources)}`)
    } finally {
      workspace.getDocument = originalGetDocument
    }
  })
})

describe('provider disposal', () => {
  before(async () => {
    await waitProviderInit()
  })

  it('removes registered providers when subscriptions are disposed', () => {
    const subscriptions: Disposable[] = []
    const manager = new ProviderManager({ appendLine: () => {} } as any, subscriptions, {} as any)
    manager.regist({ getSnippets: () => [] } as any, 'fake')
    assert.equal(manager.hasProvider, true)
    for (let disposable of subscriptions) {
      disposable.dispose()
    }
    assert.equal(manager.hasProvider, false)
  })
})

describe('ultisnips python fallback and retry', () => {
  before(async () => {
    await waitProviderInit()
  })

  it('skips python global code when python is unsupported', async () => {
    const channel = { appendLine: () => {} } as any
    const config = { extends: {}, excludes: [], trace: false, directories: [] } as any
    const context = { subscriptions: [], asAbsolutePath: () => '' } as any
    const provider = new UltiSnippetsProvider(channel, config, context)
    ;(provider as any).pythonSupport = false
    ;(provider as any).parser = {
      parseUltisnipsFile: async () => ({ snippets: [], pythonCode: 'x = 1', extendFiletypes: [] })
    }
    let executed = false
    ;(provider as any).executePyCodesForFile = async () => {
      executed = true
    }
    await provider.loadSnippetsFromFile({ filepath: '/tmp/py.snippets', directory: '/tmp', filetype: 'all' })
    assert.equal(executed, false)
    assert.equal(pythonCodes.has('/tmp/py.snippets'), false)
  })

  it('retries a filetype after a loading failure', async () => {
    const channel = { appendLine: () => {} } as any
    const config = { extends: {}, excludes: [], trace: false, directories: [] } as any
    const context = { subscriptions: [], asAbsolutePath: () => '' } as any
    const provider = new UltiSnippetsProvider(channel, config, context)
    ;(provider as any).fileItems = [{ filepath: '/tmp/all.snippets', directory: '/tmp', filetype: 'all' }]
    let calls = 0
    ;(provider as any).loadSnippetsFromFile = async () => {
      calls += 1
      if (calls == 1) throw new Error('boom')
    }
    await provider.loadSnippetsByFiletype('javascript')
    assert.equal((provider as any).loadedLanguageIds.has('all'), false)
    await provider.loadSnippetsByFiletype('javascript')
    assert.equal((provider as any).loadedLanguageIds.has('all'), true)
    assert.equal(calls, 2)
  })

  it('retries a snipmate filetype after a loading failure', async () => {
    const channel = { appendLine: () => {} } as any
    const config = { extends: {}, excludes: [], trace: false, author: '' } as any
    const provider = new SnipmateProvider(channel, config, [])
    ;(provider as any).fileItems = [{ filepath: '/tmp/a.snippets', directory: '/tmp', filetype: 'javascript' }]
    let calls = 0
    ;(provider as any).loadSnippetsFromFile = async () => {
      calls += 1
      if (calls == 1) throw new Error('boom')
    }
    await provider.loadSnippetsByFiletype('javascript')
    assert.equal((provider as any).loadedLanguageIds.has('javascript'), false)
    await provider.loadSnippetsByFiletype('javascript')
    assert.equal((provider as any).loadedLanguageIds.has('javascript'), true)
    assert.equal(calls, 2)
  })
})

describe('textmate provider lifecycle', () => {
  before(async () => {
    await waitProviderInit()
  })

  it('registers the workspace-folder listener with subscriptions', async () => {
    const subscriptions: Disposable[] = []
    const channel = { appendLine: () => {} } as any
    const config = { loadFromExtensions: false, snippetsRoots: [], projectSnippets: true, extends: {}, excludes: [], trace: false } as any
    const provider = new TextmateProvider(channel, config, subscriptions)
    await provider.init()
    assert.ok(subscriptions.length > 0)
    for (let disposable of subscriptions) {
      disposable.dispose()
    }
  })
})

describe('massCode create failure and timeout', () => {
  before(async () => {
    await waitProviderInit()
  })

  it('does not keep a snippet when the create request fails', async () => {
    const channel = { appendLine: () => {} } as any
    const config = { host: 'localhost', port: 3033, extends: {}, excludes: [], trace: false } as any
    const provider = new MassCodeProvider(channel, config)
    ;(provider as any).init = async () => {}
    const originalRequestInput = window.requestInput
    const originalRequest = http.request
    window.requestInput = async () => 'fail-test' as any
    http.request = ((_options: http.RequestOptions, callback?: (res: any) => void) => {
      const res = new EventEmitter() as any
      res.statusCode = 500
      process.nextTick(() => {
        callback?.(res)
        res.emit('end')
      })
      return { write: () => {}, on: () => {}, end: () => {} } as any
    }) as any
    try {
      await assert.rejects(provider.createSnippet())
      assert.equal(provider.getSnippets('javascript').some(s => s.prefix == 'fail-test'), false)
    } finally {
      http.request = originalRequest
      window.requestInput = originalRequestInput
    }
  })

  it('rejects when the massCode request times out', async () => {
    const channel = { appendLine: () => {} } as any
    const config = { host: 'localhost', port: 3033, extends: {}, excludes: [], trace: false } as any
    const provider = new MassCodeProvider(channel, config)
    ;(provider as any).baseHttpConfig = { host: 'localhost', port: 3033, method: 'GET', timeout: 20 }
    const originalRequest = http.request
    http.request = ((_options: http.RequestOptions) => {
      const req = new EventEmitter() as any
      req.write = () => {}
      req.end = () => {}
      req.destroy = (err?: Error) => {
        req.emit('error', err ?? new Error('destroyed'))
      }
      return req
    }) as any
    try {
      await assert.rejects(provider.init(), /timed out/)
    } finally {
      http.request = originalRequest
    }
  })
})

describe('snippets language diagnostics', () => {
  let provider: LanguageProvider

  before(async () => {
    await waitProviderInit()
  })

  after(() => {
    for (let disposable of provider?.disposables ?? []) {
      disposable.dispose()
    }
  })

  it('debounces validation on text changes', async () => {
    let doc = await openBuffer('debounce.snippets')
    await workspace.nvim.command('setf snippets')
    provider = new LanguageProvider({ appendLine: () => {} } as any, 'error')
    let calls = 0
    ;(provider as any).validate = async () => {
      calls += 1
    }
    await workspace.nvim.call('setline', [1, 'snippet a'])
    await workspace.nvim.call('setline', [1, 'snippet ab'])
    await workspace.nvim.call('setline', [1, 'snippet abc'])
    await waitFor(() => calls == 1)
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.equal(calls, 1)
  })
})
