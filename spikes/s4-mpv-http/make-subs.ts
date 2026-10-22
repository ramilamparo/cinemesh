// Writes data/subs.srt and data/subs.ass: one cue every 10 s, 4 s long, text 'SRT n' / 'ASS n'.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [dir = 'data', durArg = '600'] = process.argv.slice(2)
const dur = Number(durArg)

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const srtTime = (s: number) => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)},000`
const assTime = (s: number) => `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}.00`

const srt: string[] = []
const ass: string[] = [
  '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: 854', 'PlayResY: 480', '',
  '[V4+ Styles]',
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
  'Style: Default,DejaVu Sans,48,&H0000FFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,3,0,8,10,10,20,1',
  '', '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
]
for (let i = 0, t = 1; t + 4 <= dur; i++, t += 10) {
  srt.push(String(i + 1), `${srtTime(t)} --> ${srtTime(t + 4)}`, `SRT ${i + 1}`, '')
  ass.push(`Dialogue: 0,${assTime(t)},${assTime(t + 4)},Default,,0,0,0,,ASS ${i + 1}`)
}
writeFileSync(join(dir, 'subs.srt'), srt.join('\n'))
writeFileSync(join(dir, 'subs.ass'), ass.join('\n') + '\n')
