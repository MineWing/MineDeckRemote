import { useMemo, useRef } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { json } from '@codemirror/lang-json'
import { xml } from '@codemirror/lang-xml'
import { yaml } from '@codemirror/lang-yaml'
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import type { Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags } from '@lezer/highlight'
const editorTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--sidebar)', color: 'var(--foreground)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: '"Fira Code Variable", "Fira Code", monospace', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '14px 0', caretColor: 'var(--primary)' },
  '.cm-line': { padding: '0 18px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--primary)' },
  '.cm-gutters': { backgroundColor: 'var(--background)', color: 'var(--muted-foreground)', border: 'none', borderRight: '1px solid var(--border)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 10px', minWidth: '44px' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--foreground), transparent 96%)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--primary), transparent 88%)', color: 'var(--primary)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'color-mix(in srgb, var(--primary), transparent 75%)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--muted-foreground)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--chart-3), transparent 70%)', outline: '1px solid var(--chart-3)' },
  '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--card-foreground)' },
}, { dark: true })

const editorHighlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.comment, color: 'var(--muted-foreground)', fontStyle: 'italic' },
  { tag: [tags.propertyName, tags.attributeName, tags.tagName], color: 'var(--text-chart-5)' },
  { tag: [tags.string, tags.attributeValue], color: 'var(--text-chart-2)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--text-chart-3)' },
  { tag: [tags.keyword, tags.modifier, tags.typeName], color: 'var(--text-chart-4)' },
  { tag: [tags.operator, tags.punctuation, tags.bracket], color: 'var(--text-chart-1)' },
  { tag: [tags.variableName, tags.name], color: 'var(--foreground)' },
  { tag: tags.invalid, color: 'var(--destructive)', textDecoration: 'underline' },
]))

interface EditorLanguage { label: string; extension?: Extension }

const editorLanguages: Record<string, EditorLanguage> = {
  yml: { label: 'YAML', extension: yaml() },
  yaml: { label: 'YAML', extension: yaml() },
  json: { label: 'JSON', extension: json() },
  mcmeta: { label: 'JSON', extension: json() },
  xml: { label: 'XML', extension: xml() },
  properties: { label: 'Properties', extension: StreamLanguage.define(properties) },
  conf: { label: 'Config', extension: StreamLanguage.define(properties) },
  cfg: { label: 'Config', extension: StreamLanguage.define(properties) },
  ini: { label: 'INI', extension: StreamLanguage.define(properties) },
  toml: { label: 'TOML', extension: StreamLanguage.define(toml) },
  sh: { label: 'Shell', extension: StreamLanguage.define(shell) },
  command: { label: 'Shell', extension: StreamLanguage.define(shell) },
}

export const languageFor = (name: string): EditorLanguage => editorLanguages[name.split('.').pop()?.toLowerCase() ?? ''] ?? { label: 'Plain text' }

export default function FileEditor({ file, content, onChange, onSave, onCursor }: { file: string; content: string; onChange: (content: string) => void; onSave: () => boolean; onCursor: (cursor: {line:number;column:number}) => void }) {
  const save = useRef(onSave)
  save.current = onSave
  const language = languageFor(file)
  const extensions = useMemo(() => [editorTheme, editorHighlighting, keymap.of([{key:'Mod-s', preventDefault:true, run:()=>save.current()}]), ...(language.extension ? [language.extension] : [])], [language.extension])
  return <CodeMirror aria-label={`Editing ${file}`} value={content} height="100%" theme="none" extensions={extensions}
    basicSetup={{lineNumbers:true, foldGutter:true, highlightActiveLine:true, highlightActiveLineGutter:true, bracketMatching:true, closeBrackets:true, autocompletion:false, tabSize:2}}
    indentWithTab onChange={onChange} onUpdate={(update)=>{const position=update.state.selection.main.head;const line=update.state.doc.lineAt(position);onCursor({line:line.number,column:position-line.from+1})}} />
}
