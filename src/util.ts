/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { commands, Document, TextEdit, Uri, workspace } from 'coc.nvim'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { SnippetEditWithSource, UltiSnippetOption } from './types'

export interface CodeInfo {
  readonly hash: string
  readonly code: string
}

export interface LastSnippet {
  filepath: string
  lnum: number
}

export const pythonCodes: Map<string, CodeInfo> = new Map()

const caseInsensitive = os.platform() == 'win32' || os.platform() == 'darwin'
const additionalFiletypes: Map<number, string[]> = new Map()
var lastSnippet: LastSnippet = undefined

export function setLastSnippet(filepath: string, lnum: number): void {
  lastSnippet = { filepath, lnum }
}

export function getLastSnippet(): LastSnippet | undefined {
  return lastSnippet
}

export async function insertSnippetEdit(edit: SnippetEditWithSource) {
  let ultisnips = edit.source == 'ultisnips' || edit.source == 'snipmate'
  let option: UltiSnippetOption
  if (ultisnips) {
    let formatOptions = edit.formatOptions ?? {}
    option = {
      regex: edit.regex,
      actions: edit.actions,
      context: edit.context,
      noExpand: formatOptions.noExpand,
      trimTrailingWhitespace: formatOptions.trimTrailingWhitespace,
      removeWhiteSpace: formatOptions.removeWhiteSpace
    }
  }
  setLastSnippet(edit.location, edit.lnum)
  await commands.executeCommand('editor.action.insertSnippet', TextEdit.replace(edit.range, edit.newText), option)
}

export function addFiletypes(bufnr: number, filetypes: string[]): void {
  let curr = additionalFiletypes.get(bufnr) ?? []
  filetypes.forEach(filetype => {
    if (filetype && !curr.includes(filetype)) curr.push(filetype)
  })
  additionalFiletypes.set(bufnr, curr)
}

export function getAdditionalFiletype(bufnr: number): string[] {
  return additionalFiletypes.get(bufnr) ?? []
}

export function clearAdditionalFiletype(bufnr: number): void {
  additionalFiletypes.delete(bufnr)
}

export function getAllAdditionalFiletype(): string[] {
  let filetypes: string[] = []
  workspace.documents.forEach(doc => {
    let arr = getAdditionalFiletype(doc.bufnr)
    if (arr.length) filetypes.push(...arr)
  })
  return filetypes
}

export function getSnippetFiletype(doc: { bufnr: number, filetype: string }): string {
  let filetypes = getAdditionalFiletype(doc.bufnr)
  return [doc.filetype, ...filetypes].join('.')
}

export function createMD5(input: string): string {
  return crypto.createHash('md5').update(input).digest('hex');
}

export const documentation = `# A valid snippet should starts with:
#
#		snippet trigger_word [ "description" [ options ] ]
#
# and end with:
#
#		endsnippet
#
# Snippet options:
#
#		b - Beginning of line.
#		i - In-word expansion.
#		w - Word boundary.
#		r - Regular expression
#		e - Custom context snippet
#		A - Snippet will be triggered automatically, when condition matches.
#
# Basic example:
#
#		snippet emitter "emitter properties" b
#		private readonly $\{1} = new Emitter<$2>()
#		public readonly $\{1/^_(.*)/$1/}: Event<$2> = this.$1.event
#		endsnippet
#
# Online reference: https://github.com/SirVer/ultisnips/blob/master/doc/UltiSnips.txt
`


export async function statAsync(filepath: string): Promise<fs.Stats> {
  try {
    return await promisify(fs.stat)(filepath)
  } catch (e) {
    return null
  }
}

export async function readdirAsync(filepath: string): Promise<string[]> {
  try {
    return await promisify(fs.readdir)(filepath)
  } catch (e) {
    return null
  }
}

export function headTail(line: string): [string, string] | null {
  line = line.trim()
  let ms = line.match(/^(\S+)\s+(.*)/)
  if (!ms) return [line, '']
  return [ms[1], ms[2]]
}

export function trimQuote(str: string): string {
  if (/^(["']).*\1$/.test(str)) return str.slice(1, -1)
  return str
}

export function distinct<T>(array: T[], keyFn?: (t: T) => string): T[] {
  if (!keyFn) {
    return array.filter((element, position) => {
      return array.indexOf(element) === position
    })
  }
  const seen: { [key: string]: boolean } = Object.create(null)
  return array.filter(elem => {
    const key = keyFn(elem)
    if (seen[key]) {
      return false
    }

    seen[key] = true

    return true
  })
}

const stringStartRe = /\\A/
const conditionRe = /\(\?\(\w+\).+\|/
const commentRe = /\(\?#.*?\)/
const namedCaptureRe = /\(\?P<\w+>.*?\)/
const namedReferenceRe = /\(\?P=(\w+)\)/
const regex = new RegExp(`${commentRe.source}|${stringStartRe.source}|${namedCaptureRe.source}|${namedReferenceRe.source}`, 'g')

/**
 * Convert python regex to javascript regex,
 * throw error when unsupported pattern found
 *
 * @public
 * @param {string} str
 * @returns {string}
 */
export function convertRegex(str: string): string {
  if (str.indexOf('\\z') !== -1) {
    throw new Error('pattern \\z not supported')
  }
  if (str.indexOf('(?s)') !== -1) {
    throw new Error('pattern (?s) not supported')
  }
  if (str.indexOf('(?x)') !== -1) {
    throw new Error('pattern (?x) not supported')
  }
  if (str.indexOf('\n') !== -1) {
    throw new Error('multiple line pattern not supported')
  }
  if (conditionRe.test(str)) {
    throw new Error('(?id/name)yes-pattern|no-pattern not supported')
  }
  return str.replace(regex, (match, p1) => {
    if (match.startsWith('(?#')) return ''
    if (match == '\\A') return '^'
    if (match.startsWith('(?P<')) return '(?' + match.slice(3)
    if (match.startsWith('(?P=')) return `\\k<${p1}>`
    return ''
  })
}

export function getRegexText(prefix: string): string {
  if (prefix.startsWith('^')) prefix = prefix.slice(1)
  if (prefix.endsWith('$')) prefix = prefix.slice(0, -1)
  // keep word inside ()?
  let content = prefix.replace(/\((\w+)\)\?/g, '$1').replace(/\(.*\)\??/g, '')
  content = content.replace(/\\/g, '')
  return content
}

export function getTriggerText(text: string, regex: boolean): string {
  if (!text || /\w/.test(text[0]) || text.length <= 2) return text ?? ''
  if (text[0] == text[text.length - 1] && (regex || text.includes(' ') || text[0] == '/')) return text.slice(1, -1)
  return text
}

export function markdownBlock(code: string, filetype: string): string {
  filetype = filetype == 'javascriptreact' ? 'javascript' : filetype
  filetype = filetype == 'typescriptreact' ? 'typescript' : filetype
  return '``` ' + filetype + '\n' + code + '\n```'
}

export async function waitDocument(doc: Document, changedtick: number): Promise<boolean> {
  if (doc.changedtick >= changedtick) return Promise.resolve(doc.changedtick === changedtick)
  return new Promise(resolve => {
    let timeout = setTimeout(() => {
      disposable.dispose()
      resolve(doc.changedtick == changedtick)
    }, 200)
    let disposable = doc.onDocumentChange(() => {
      clearTimeout(timeout)
      disposable.dispose()
      resolve(doc.changedtick == changedtick)
    })
  })
}

export function sameFile(fullpath: string | null, other: string | null): boolean {
  if (!fullpath || !other) return false
  if (caseInsensitive) return fullpath.toLowerCase() === other.toLowerCase()
  return fullpath === other
}

export function characterIndex(content: string, byteIndex: number): number {
  let buf = Buffer.from(content, 'utf8')
  return buf.slice(0, byteIndex).toString('utf8').length
}

export function languageIdFromComments(lines: string[]): string | undefined {
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    let ms = lines[i].match(/^\s*\/\/\sPlace\syour\s(\w+)\sworkspace/)
    if (ms) return ms[1]
  }
  return undefined
}


export function omit<T>(obj: T, properties: string[]): T {
  let o = {}
  for (let key of Object.keys(obj)) {
    if (!properties.includes(key)) {
      o[key] = obj[key]
    }
  }
  return o as T
}

export function normalizeFilePath(filepath: string) {
  return Uri.file(path.resolve(path.normalize(filepath))).fsPath
}

/**
 * Remove state of an unloaded extension so a reloaded extension can be loaded
 * again.
 */
export function clearExtensionState<T extends { extensionId?: string }>(
  definitions: Map<string, Array<{ filepath: string }>>,
  loadedFiles: Set<string>,
  loadedSnippets: T[],
  extensionId: string
): T[] {
  let items = definitions.get(extensionId) ?? []
  for (let item of items) {
    loadedFiles.delete(item.filepath)
  }
  definitions.delete(extensionId)
  return loadedSnippets.filter(item => item.extensionId !== extensionId)
}

/**
 * Remove state under a removed workspace folder so a re-added folder can be
 * loaded again.
 */
export function clearFolderState<T extends { filepath: string }>(
  loadedFiles: Set<string>,
  loadedRoots: Set<string>,
  loadedSnippets: T[],
  fsPath: string
): T[] {
  let prefix = fsPath + path.sep
  for (let file of loadedFiles) {
    if (file.startsWith(prefix)) {
      loadedFiles.delete(file)
    }
  }
  for (let root of loadedRoots) {
    if (root.startsWith(prefix)) {
      loadedRoots.delete(root)
    }
  }
  return loadedSnippets.filter(o => !o.filepath.startsWith(prefix))
}

export function filetypeFromBasename(basename: string): string {
  if (basename == 'typescript_react') return 'typescriptreact'
  if (basename == 'javascript_react') return 'javascriptreact'
  if (basename.includes('_')) return basename.split('_', 2)[0]
  return basename.split('-', 2)[0]
}
