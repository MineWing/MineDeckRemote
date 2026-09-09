import assert from 'node:assert/strict'
import test from 'node:test'
import { copyText } from '../src/lib/clipboard.ts'
import { mergeLogHistory } from '../src/lib/log-history.ts'

test('clipboard reports denial and insecure-context absence for selectable fallback', async () => {
  assert.equal(await copyText('hello', undefined), false)
  assert.equal(await copyText('hello', {writeText: async () => { throw new Error('NotAllowedError') }}), false)
  let copied = ''
  assert.equal(await copyText('hello', {writeText: async (value) => { copied = value }}), true)
  assert.equal(copied, 'hello')
})

test('history snapshots reconcile older retained output with newer live lines', () => {
  const current = {epoch:'host-a',entries:[{sequence:3,line:'repeat'},{sequence:4,line:'repeat'}]}
  const merged = mergeLogHistory(current, {epoch:'host-a',entries:[{sequence:1,line:'first'},{sequence:2,line:'repeat'},{sequence:3,line:'repeat'}]})
  assert.deepEqual(merged.entries.map((entry) => entry.sequence), [1,2,3,4])
  assert.equal(merged.entries.filter((entry) => entry.line === 'repeat').length, 3)
  assert.deepEqual(mergeLogHistory(merged, {epoch:'host-b',entries:[{sequence:1,line:'new host'}]}).entries, [{sequence:1,line:'new host'}])
})

test('a full console buffer advances with every new sequence', () => {
  const full = {epoch:'host-a',entries:Array.from({length:800},(_,index)=>({sequence:index+1,line:'repeat'}))}
  const next = mergeLogHistory(full, {epoch:'host-a',entries:[{sequence:801,line:'repeat'}]})
  assert.equal(next.entries.length,800)
  assert.equal(next.entries[0]?.sequence,2)
  assert.equal(next.entries.at(-1)?.sequence,801)
})

test('semantic text remains readable on every bundled dark theme', async () => {
  const {readFile} = await import('node:fs/promises')
  const css = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
  const luminance = (color: string): number => {
    let rgb: number[]
    if (color.startsWith('#')) {
      const hex = color.slice(1).length === 3 ? [...color.slice(1)].map(c=>c+c).join('') : color.slice(1)
      rgb = [0,2,4].map(i=>parseInt(hex.slice(i,i+2),16)/255)
    } else if (color.startsWith('hsl')) {
      const [h,s,l] = color.match(/[\d.]+/g)!.map(Number) as [number,number,number]
      const saturation=s/100, light=l/100, a=saturation*Math.min(light,1-light)
      rgb=[0,8,4].map(n=>{const k=(n+h/30)%12;return light-a*Math.max(-1,Math.min(k-3,9-k,1))})
    } else if (color.startsWith('oklch')) {
      const [l,c,h] = color.match(/[\d.]+/g)!.map(Number) as [number,number,number]
      const a=c*Math.cos(h*Math.PI/180),b=c*Math.sin(h*Math.PI/180)
      const ll=(l+.3963377774*a+.2158037573*b)**3,mm=(l-.1055613458*a-.0638541728*b)**3,ss=(l-.0894841775*a-1.291485548*b)**3
      return .2126*(4.0767416621*ll-3.3077115913*mm+.2309699292*ss)+.7152*(-1.2684380046*ll+2.6097574011*mm-.3413193965*ss)+.0722*(-.0041960863*ll-.7034186147*mm+1.707614701*ss)
    } else throw new Error(`Unhandled color ${color}`)
    return rgb.map(c=>c<=.04045 ? c/12.92 : ((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i]!,0)
  }
  const contrast = (a:string,b:string) => {const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05)}
  for (const theme of ['dracula','tiesen','portfolio','2077','nlan','discord','terminal']) {
    const tokens: Record<string,string>={}
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]+)\}/g)) {
      const selector=rule[1]!.trim().replace(/\/\*[\s\S]*?\*\//g,'').trim()
      if (![':root','.dark',`.dark[data-theme="${theme}"]`,'.dark[data-theme]'].includes(selector)) continue
      for (const declaration of rule[2]!.matchAll(/--([\w-]+):\s*([^;]+);/g)) tokens[declaration[1]!]=declaration[2]!.trim()
    }
    for (const foreground of ['foreground','muted-foreground','text-chart-1','text-chart-2','text-chart-3','text-chart-4','text-chart-5','destructive']) {
      for (const background of ['card','background','popover','sidebar']) assert.ok(contrast(tokens[foreground]!,tokens[background]!) >= 4.5, `${theme} ${foreground}/${background}`)
    }
    for (const background of ['primary','destructive','secondary','accent']) assert.ok(contrast(tokens[`${background}-foreground`]!,tokens[background]!) >= 4.5, `${theme} ${background} button`)
  }
})
