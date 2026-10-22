-- wt-osc.lua: Watch Together's on-screen controller for mpv (plan §4.4, messages in §5.3).
--
-- Written from scratch for this project; nothing is taken from mpv's osc.lua.
--
-- Invariant: this script never changes pause or position. Play/pause and seeks become `wt-intent`
-- messages to the app, which allows or rejects them. Tracks, volume, fullscreen and subtitle
-- display are per-viewer and handled locally.
--
-- core -> OSC (script-message-to wt_osc <kind> <json>):
--   init {v, client, theme, perms, strings, watchdogS, persistentStrip}   answered with wt-ready
--   theme {mode, colors, peers}   colours arrive as ASS literals '&HBBGGRR&' (converted in TS)
--   perms {isHost, canPlayPause, canSeek}
--   ranges {dur, done, loading, groupDone?}   merged spans in seconds
--   peers [{id, name, color, pos, state}]
--   status {text, level?}   toast {text, ms?}   ended {ended}   hb {}
--   resync {shown}   a viewer behind the host: the bar shows a Resync to live button
-- OSC -> core (script-message-to <client> ...):
--   wt-ready {v}   wt-intent {t, pos?, delta?, seq}   t = resync: Shift+R or that button (never on the host)

local mp = require 'mp'
local utils = require 'mp.utils'
local assdraw = require 'mp.assdraw'

local PROTOCOL = 1
local BAR_H = 56
local PAD = 14
local TRACK_H = 6
local TRACK_H_HOVER = 10
local HIDE_AFTER = 2.0
local FRAME = 1 / 30
local SEEK_SMALL = 5
local SEEK_LARGE = 60

-- ---- state ----------------------------------------------------------------------------------

local S = {
  client = nil,
  watchdog = 0,
  last_hb = mp.get_time(),
  persistent_strip = false,
  seq = 0,
  perms = { isHost = false, canPlayPause = true, canSeek = true },
  strings = {
    ended = 'Ended',
    muted = 'Muted',
    volume = 'Volume',
    subDelay = 'Subtitle delay',
    subsHidden = 'Subtitles hidden',
    subsShown = 'Subtitles shown',
    noTracks = 'No tracks',
    locked = 'The host controls this',
    resync = 'Resync to live',
  },
  colors = {
    surface = '&H231D1B&',
    surface2 = '&H322825&',
    text = '&HF0EAE8&',
    muted = '&HAEA19A&',
    accent = '&HFF8C6C&',
    border = '&H3D332F&',
    ['tl-missing'] = '&H382E2A&',
    ['tl-downloading'] = '&H1E9AD9&',
    ['tl-downloaded'] = '&HFF8C6C&',
    ['tl-buffered'] = '&H994F3D&',
    playhead = '&HFFFFFF&',
    danger = '&H4D48E5&',
    ok = '&H6CA430&',
  },
  ranges = { dur = 0, done = {}, loading = {}, groupDone = nil },
  peers = {},
  status = { text = '', level = 'info' },
  toast = nil, -- {text, till}
  ended = false,
  resync_shown = false,

  -- mpv state
  w = 0,
  h = 0,
  scale = 1,
  pos = nil,
  dur = nil,
  paused = true,
  cache = {},
  volume = 100,
  mute = false,
  fullscreen = false,
  sub_visible = true,

  -- pointer & layout
  mouse = { x = -1, y = -1, hover = false },
  last_move = -math.huge,
  drag = nil, -- {pos}
  pressed = nil,
  layout = nil,
}

local overlay = mp.create_osd_overlay('ass-events')
local last_data = nil
local last_render = 0
local render_timer = nil

-- Test hook: headless mpv (--vo=null) reports 0x0 OSD dimensions; this lets tests run the drawing code.
local test_dims = mp.get_opt('wt_osc-test-dims')

-- ---- helpers --------------------------------------------------------------------------------

local function clamp(v, lo, hi)
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end

local function fmt_time(t)
  if t == nil or t < 0 then return '--:--' end
  t = math.floor(t + 0.5)
  local h = math.floor(t / 3600)
  local m = math.floor(t / 60) % 60
  local s = t % 60
  if h > 0 then return string.format('%d:%02d:%02d', h, m, s) end
  return string.format('%d:%02d', m, s)
end

local function ass_escape(str)
  str = tostring(str or '')
  str = str:gsub('\\', '\\\226\129\160')
  str = str:gsub('{', '\\{')
  str = str:gsub('}', '\\}')
  str = str:gsub('\n', '\\N')
  return str
end

local function color(name)
  return S.colors[name] or '&HFFFFFF&'
end

local function valid_color(c)
  return type(c) == 'string' and c:match('^&H%x%x%x%x%x%x&$') ~= nil
end

local function duration()
  if S.ranges.dur and S.ranges.dur > 0 then return S.ranges.dur end
  return S.dur or 0
end

local function send(name, tbl)
  if not S.client then return end
  mp.commandv('script-message-to', S.client, name, utils.format_json(tbl))
end

local function intent(t, extra)
  S.seq = S.seq + 1
  local msg = { t = t, seq = S.seq }
  if extra then
    for k, v in pairs(extra) do msg[k] = v end
  end
  send('wt-intent', msg)
end

local request_render -- forward

local function toast(text, seconds)
  S.toast = { text = text, till = mp.get_time() + (seconds or 2) }
  request_render()
  mp.add_timeout((seconds or 2) + 0.05, request_render)
end

local function poke()
  S.last_move = mp.get_time()
  request_render()
  mp.add_timeout(HIDE_AFTER + 0.05, request_render)
end

-- ---- layout & hit testing -------------------------------------------------------------------

local function bar_height()
  return BAR_H * S.scale
end

local function compute_layout()
  local s = S.scale
  local w, h = S.w, S.h
  local bh = bar_height()
  local y0 = h - bh
  local pad = PAD * s
  local L = { y0 = y0, bh = bh, s = s }
  L.track = { x0 = pad, x1 = w - pad, cy = y0 + 13 * s }
  local row = y0 + 36 * s
  L.row = row
  local icon = 22 * s
  L.play = { x0 = pad - 4 * s, x1 = pad + icon, y0 = row - icon / 2 - 4 * s, y1 = row + icon / 2 + 4 * s }
  L.time_x = L.play.x1 + 10 * s
  local x = w - pad
  local function right_button(width)
    local b = { x0 = x - width, x1 = x, y0 = row - 14 * s, y1 = row + 14 * s }
    x = x - width - 10 * s
    return b
  end
  L.fullscreen = right_button(26 * s)
  L.volume = right_button(64 * s)
  L.sub = right_button(44 * s)
  L.audio = right_button(44 * s)
  -- only where it leaves the time text its room
  if S.resync_shown and not S.perms.isHost and w >= 600 * s then L.resync = right_button(112 * s) end
  return L
end

local function inside(b, x, y)
  return b and x >= b.x0 and x <= b.x1 and y >= b.y0 and y <= b.y1
end

local function visible()
  if S.w <= 0 then return false end
  if S.drag or S.paused then return true end
  if S.mouse.hover and S.mouse.y >= S.h - bar_height() then return true end
  return mp.get_time() - S.last_move < HIDE_AFTER
end

local function hit(x, y)
  local L = S.layout
  if not L or not visible() or y < L.y0 then return nil end
  if math.abs(y - L.track.cy) <= 9 * L.s and x >= L.track.x0 and x <= L.track.x1 then return 'timeline' end
  if inside(L.play, x, y) then return 'play' end
  if inside(L.audio, x, y) then return 'audio' end
  if inside(L.sub, x, y) then return 'sub' end
  if inside(L.volume, x, y) then return 'volume' end
  if inside(L.fullscreen, x, y) then return 'fullscreen' end
  if inside(L.resync, x, y) then return 'resync' end
  return 'bar'
end

local function pos_at(x)
  local L = S.layout
  local dur = duration()
  if not L or dur <= 0 then return nil end
  return clamp((x - L.track.x0) / (L.track.x1 - L.track.x0), 0, 1) * dur
end

-- ---- drawing --------------------------------------------------------------------------------

local function style(ass, col, alpha)
  ass:append(string.format('{\\an7\\bord0\\shad0\\1c%s\\1a&H%02X&}', col, alpha or 0))
end

local function rect(ass, x0, y0, x1, y1, col, alpha)
  if x1 - x0 < 0.5 or y1 - y0 < 0.5 then return end
  ass:new_event()
  ass:pos(0, 0)
  style(ass, col, alpha)
  ass:draw_start()
  ass:rect_cw(x0, y0, x1, y1)
  ass:draw_stop()
end

local function poly(ass, pts, col, alpha)
  ass:new_event()
  ass:pos(0, 0)
  style(ass, col, alpha)
  ass:draw_start()
  ass:move_to(pts[1][1], pts[1][2])
  for i = 2, #pts do ass:line_to(pts[i][1], pts[i][2]) end
  ass:draw_stop()
end

local function text(ass, x, y, an, size, col, str, alpha)
  ass:new_event()
  ass:pos(x, y)
  ass:append(string.format('{\\an%d\\fs%d\\bord0\\shad0\\1c%s\\1a&H%02X&\\fnsans-serif}', an,
    math.floor(size + 0.5), col, alpha or 0))
  ass:append(ass_escape(str))
end

local function lock_glyph(ass, cx, cy, s, col)
  local bw, bh = 9 * s, 7 * s
  rect(ass, cx - bw / 2, cy - bh / 2 + 2 * s, cx + bw / 2, cy + bh / 2 + 2 * s, col)
  local t = 1.6 * s
  local sw = 6 * s
  rect(ass, cx - sw / 2, cy - bh / 2 - 3 * s, cx - sw / 2 + t, cy - bh / 2 + 2 * s, col)
  rect(ass, cx + sw / 2 - t, cy - bh / 2 - 3 * s, cx + sw / 2, cy - bh / 2 + 2 * s, col)
  rect(ass, cx - sw / 2, cy - bh / 2 - 3 * s, cx + sw / 2, cy - bh / 2 - 3 * s + t, col)
end

local function spans(ass, list, dur, x0, x1, y0, y1, col, alpha)
  if type(list) ~= 'table' or dur <= 0 then return end
  local k = (x1 - x0) / dur
  for _, span in ipairs(list) do
    local a, b = tonumber(span[1]), tonumber(span[2])
    if a and b and b > a then
      rect(ass, x0 + clamp(a, 0, dur) * k, y0, x0 + clamp(b, 0, dur) * k, y1, col, alpha)
    end
  end
end

-- Two span lists (sorted and merged by the bridge) cover the same seconds.
local function same_spans(a, b)
  if #a ~= #b then return false end
  for i = 1, #a do
    local x, y = a[i], b[i]
    if type(x) ~= 'table' or type(y) ~= 'table' then return false end
    if tonumber(x[1]) ~= tonumber(y[1]) or tonumber(x[2]) ~= tonumber(y[2]) then return false end
  end
  return true
end

local function cache_spans()
  local out = {}
  for _, r in ipairs(S.cache) do
    if type(r) == 'table' and r.start and r['end'] then out[#out + 1] = { r.start, r['end'] } end
  end
  return out
end

local function draw_timeline(ass, L, hovered)
  local s = L.s
  local tr = L.track
  local th = (hovered or S.drag) and TRACK_H_HOVER * s or TRACK_H * s
  local y0, y1 = tr.cy - th / 2, tr.cy + th / 2
  local dur = duration()
  local locked = not S.perms.canSeek
  local a = locked and 0x80 or 0
  rect(ass, tr.x0, y0, tr.x1, y1, color('tl-missing'), a)
  spans(ass, S.ranges.loading, dur, tr.x0, tr.x1, y0, y1, color('tl-downloading'), a)
  spans(ass, S.ranges.done, dur, tr.x0, tr.x1, y0, y1, color('tl-downloaded'), a)
  -- mpv's own demuxer cache: a strip along the top edge
  spans(ass, cache_spans(), dur, tr.x0, tr.x1, y0, y0 + 2 * s, color('tl-buffered'), a)
  -- host only: what every viewer already has, along the bottom edge (nil when done shows the same spans)
  if S.ranges.groupDone then spans(ass, S.ranges.groupDone, dur, tr.x0, tr.x1, y1 + s, y1 + 3 * s, color('ok'), a) end

  if dur > 0 then
    local k = (tr.x1 - tr.x0) / dur
    local pos = S.pos or 0
    -- played strip along the bottom edge of the track
    rect(ass, tr.x0, y1 - 2 * s, tr.x0 + clamp(pos, 0, dur) * k, y1, color('playhead'), 0x60)

    for _, p in ipairs(S.peers) do
      local pp = tonumber(p.pos)
      if pp then
        local px = tr.x0 + clamp(pp, 0, dur) * k
        local col = valid_color(p.color) and p.color or color('accent')
        poly(ass, { { px - 5 * s, y0 - 9 * s }, { px + 5 * s, y0 - 9 * s }, { px, y0 - 2 * s } }, col, 0)
      end
    end

    local shown = S.drag and S.drag.pos or pos
    local hx = tr.x0 + clamp(shown, 0, dur) * k
    rect(ass, hx - s, y0 - 3 * s, hx + s, y1 + 3 * s, color('playhead'), a)
    if hovered or S.drag then
      local mx = S.drag and hx or clamp(S.mouse.x, tr.x0, tr.x1)
      local t = S.drag and S.drag.pos or pos_at(mx)
      text(ass, clamp(mx, tr.x0 + 24 * s, tr.x1 - 24 * s), y0 - 12 * s, 2, 15 * s, color('text'), fmt_time(t))
    end
  end
  if locked then lock_glyph(ass, tr.x1 - 6 * s, tr.cy - 16 * s, s, color('muted')) end
end

local function draw_play(ass, L)
  local s = L.s
  local b = L.play
  local cx, cy = (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2
  local locked = not S.perms.canPlayPause
  local a = locked and 0x80 or 0
  local col = color('text')
  if S.paused then
    poly(ass, { { cx - 7 * s, cy - 9 * s }, { cx + 9 * s, cy }, { cx - 7 * s, cy + 9 * s } }, col, a)
  else
    rect(ass, cx - 8 * s, cy - 9 * s, cx - 3 * s, cy + 9 * s, col, a)
    rect(ass, cx + 3 * s, cy - 9 * s, cx + 8 * s, cy + 9 * s, col, a)
  end
  if locked then lock_glyph(ass, b.x1 - 2 * s, b.y0 + 6 * s, s * 0.8, color('muted')) end
end

local function draw_button(ass, b, label, hovered, s)
  rect(ass, b.x0, b.y0, b.x1, b.y1, hovered and color('surface2') or color('surface'), hovered and 0x10 or 0x60)
  text(ass, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, 5, 13 * s, color('text'), label)
end

local function draw_volume(ass, b, hovered, s)
  rect(ass, b.x0, b.y0, b.x1, b.y1, hovered and color('surface2') or color('surface'), hovered and 0x10 or 0x60)
  local cx, cy = b.x0 + 12 * s, (b.y0 + b.y1) / 2
  local col = S.mute and color('muted') or color('text')
  rect(ass, cx - 6 * s, cy - 3 * s, cx - 2 * s, cy + 3 * s, col)
  poly(ass, { { cx - 2 * s, cy - 3 * s }, { cx + 4 * s, cy - 8 * s }, { cx + 4 * s, cy + 8 * s }, { cx - 2 * s, cy + 3 * s } },
    col)
  local label = S.mute and 'off' or string.format('%d%%', math.floor(S.volume + 0.5))
  text(ass, b.x1 - 6 * s, cy, 6, 13 * s, col, label)
end

local function draw_fullscreen(ass, b, hovered, s)
  local col = hovered and color('accent') or color('text')
  local cx, cy = (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2
  local r, t, l = 8 * s, 2 * s, 6 * s
  for _, sx in ipairs({ -1, 1 }) do
    for _, sy in ipairs({ -1, 1 }) do
      local x, y = cx + sx * r, cy + sy * r
      rect(ass, math.min(x, x - sx * l), y - (sy > 0 and t or 0), math.max(x, x - sx * l), y + (sy > 0 and 0 or t), col)
      rect(ass, x - (sx > 0 and t or 0), math.min(y, y - sy * l), x + (sx > 0 and 0 or t), math.max(y, y - sy * l), col)
    end
  end
end

local function draw_bar(ass, L)
  local s = L.s
  local mx, my = S.mouse.x, S.mouse.y
  local over = S.mouse.hover and hit(mx, my) or nil
  rect(ass, 0, L.y0, S.w, S.h, color('surface'), 0x30)
  draw_timeline(ass, L, over == 'timeline')
  draw_play(ass, L)
  local dur = duration()
  local shown = S.drag and S.drag.pos or S.pos
  text(ass, L.time_x, L.row, 4, 15 * s, color('text'), fmt_time(shown) .. ' / ' .. fmt_time(dur > 0 and dur or nil))
  draw_button(ass, L.audio, 'Audio', over == 'audio', s)
  draw_button(ass, L.sub, S.sub_visible and 'Subs' or 'Subs off', over == 'sub', s)
  draw_volume(ass, L.volume, over == 'volume', s)
  draw_fullscreen(ass, L.fullscreen, over == 'fullscreen', s)
  if L.resync then draw_button(ass, L.resync, S.strings.resync, over == 'resync', s) end
end

local function draw_strip(ass)
  local s = S.scale
  local dur = duration()
  local y0, y1 = S.h - 2 * s, S.h
  rect(ass, 0, y0, S.w, y1, color('tl-missing'), 0x40)
  spans(ass, S.ranges.loading, dur, 0, S.w, y0, y1, color('tl-downloading'), 0x20)
  spans(ass, S.ranges.done, dur, 0, S.w, y0, y1, color('tl-downloaded'), 0x20)
  if dur > 0 and S.pos then rect(ass, 0, y0, clamp(S.pos / dur, 0, 1) * S.w, y0 + s, color('playhead'), 0x40) end
end

local function draw_messages(ass, bar_shown)
  local s = S.scale
  local base = bar_shown and (S.h - bar_height() - 8 * s) or (S.h - 12 * s)
  if S.status.text ~= '' then
    local col = S.status.level == 'error' and color('danger')
      or S.status.level == 'warn' and color('tl-downloading')
      or color('text')
    ass:new_event()
    ass:pos(PAD * s, base)
    ass:append(string.format('{\\an1\\fs%d\\bord%g\\3c%s\\shad0\\1c%s\\fnsans-serif}', math.floor(16 * s), 2 * s, color('surface'),
      col))
    ass:append(ass_escape(S.status.text))
  end
  if S.ended then
    ass:new_event()
    ass:pos(S.w / 2, S.h / 2)
    ass:append(string.format('{\\an5\\fs%d\\bord%g\\3c%s\\shad0\\1c%s\\fnsans-serif}', math.floor(28 * s), 3 * s, color('surface'),
      color('text')))
    ass:append(ass_escape(S.strings.ended))
  end
  if S.toast and mp.get_time() < S.toast.till then
    ass:new_event()
    ass:pos(S.w / 2, 40 * s)
    ass:append(string.format('{\\an8\\fs%d\\bord%g\\3c%s\\3a&H20&\\shad0\\1c%s\\fnsans-serif}', math.floor(18 * s), 6 * s,
      color('surface'), color('text')))
    ass:append(ass_escape(S.toast.text))
  elseif S.toast then
    S.toast = nil
  end
end

local function render()
  render_timer = nil
  last_render = mp.get_time()
  if S.w <= 0 or S.h <= 0 then
    if last_data ~= '' then
      overlay.data = ''
      overlay:update()
      last_data = ''
    end
    return
  end
  S.layout = compute_layout()
  local ass = assdraw.ass_new()
  local shown = visible()
  if shown then
    draw_bar(ass, S.layout)
  elseif S.persistent_strip then
    draw_strip(ass)
  end
  draw_messages(ass, shown)
  if ass.text == last_data then return end
  last_data = ass.text
  overlay.res_x = S.w
  overlay.res_y = S.h
  overlay.data = ass.text
  overlay:update()
  -- tests read back what was drawn (there is no window under --vo=null)
  if test_dims then mp.set_property_native('user-data/wt_osc/overlay', ass.text) end
end

request_render = function()
  if render_timer then return end
  local wait = math.max(0, last_render + FRAME - mp.get_time())
  render_timer = mp.add_timeout(wait, render)
end

-- ---- actions --------------------------------------------------------------------------------

local function select_track(kind)
  -- select.lua (loaded with --load-select=yes) shows a menu; cycle when it is not there.
  local ok = mp.commandv('script-binding', kind == 'audio' and 'select/select-aid' or 'select/select-sid')
  if not ok then
    mp.commandv('cycle', kind == 'audio' and 'audio' or 'sub')
  end
end

local function change_volume(delta)
  mp.commandv('add', 'volume', delta)
  toast(string.format('%s %d%%', S.strings.volume, math.floor(mp.get_property_number('volume', 0) + 0.5)), 1)
end

local function toggle_mute()
  mp.commandv('cycle', 'mute')
  if mp.get_property_bool('mute') then toast(S.strings.muted, 1) else change_volume(0) end
end

local function seek_rel(delta)
  poke()
  intent('seek-rel', { delta = delta })
end

local function on_mouse_button(e)
  -- mouse-pos notifications are asynchronous; read the position the button event belongs to
  local m = mp.get_property_native('mouse-pos')
  if type(m) == 'table' and m.x then S.mouse = { x = m.x, y = m.y, hover = m.hover ~= false } end
  local x, y = S.mouse.x, S.mouse.y
  if e.event == 'down' then
    local what = hit(x, y)
    S.pressed = what
    if what == 'timeline' then
      local p = pos_at(x)
      if p then S.drag = { pos = p } end
      request_render()
    elseif what == nil then
      mp.commandv('begin-vo-dragging')
    end
  elseif e.event == 'up' then
    local what = hit(x, y)
    if S.drag then
      local p = pos_at(x) or S.drag.pos
      S.drag = nil
      intent('seek', { pos = p })
      request_render()
    elseif what ~= nil and what == S.pressed then
      if what == 'play' then
        intent('toggle')
      elseif what == 'audio' then
        select_track('audio')
      elseif what == 'sub' then
        select_track('sub')
      elseif what == 'volume' then
        toggle_mute()
      elseif what == 'fullscreen' then
        mp.commandv('cycle', 'fullscreen')
      elseif what == 'resync' then
        intent('resync')
      end
    end
    S.pressed = nil
  end
end

-- ---- bindings -------------------------------------------------------------------------------

local function bind(key, name, fn, opts)
  mp.add_forced_key_binding(key, 'wt-' .. name, fn, opts)
end

bind('SPACE', 'toggle', function() poke(); intent('toggle') end)
bind('p', 'toggle-p', function() poke(); intent('toggle') end)
bind('LEFT', 'back', function() seek_rel(-SEEK_SMALL) end, { repeatable = true })
bind('RIGHT', 'forward', function() seek_rel(SEEK_SMALL) end, { repeatable = true })
bind('DOWN', 'back-large', function() seek_rel(-SEEK_LARGE) end, { repeatable = true })
bind('UP', 'forward-large', function() seek_rel(SEEK_LARGE) end, { repeatable = true })
bind('f', 'fullscreen', function() mp.commandv('cycle', 'fullscreen') end)
bind('ESC', 'leave-fullscreen', function() mp.commandv('set', 'fullscreen', 'no') end)
bind('MBTN_LEFT_DBL', 'dbl', function()
  if hit(S.mouse.x, S.mouse.y) == nil then mp.commandv('cycle', 'fullscreen') end
end)
bind('m', 'mute', toggle_mute)
bind('9', 'vol-down', function() change_volume(-2) end, { repeatable = true })
bind('0', 'vol-up', function() change_volume(2) end, { repeatable = true })
bind('WHEEL_UP', 'wheel-up', function() change_volume(5) end)
bind('WHEEL_DOWN', 'wheel-down', function() change_volume(-5) end)
bind('a', 'audio', function() select_track('audio') end)
bind('s', 'subs', function() select_track('sub') end)
bind('v', 'sub-visibility', function()
  mp.commandv('cycle', 'sub-visibility')
  toast(mp.get_property_bool('sub-visibility') and S.strings.subsShown or S.strings.subsHidden, 1)
end)
bind('z', 'sub-delay-down', function()
  mp.commandv('add', 'sub-delay', -0.1)
  toast(string.format('%s %d ms', S.strings.subDelay, math.floor(mp.get_property_number('sub-delay', 0) * 1000 + 0.5)), 1)
end, { repeatable = true })
bind('x', 'sub-delay-up', function()
  mp.commandv('add', 'sub-delay', 0.1)
  toast(string.format('%s %d ms', S.strings.subDelay, math.floor(mp.get_property_number('sub-delay', 0) * 1000 + 0.5)), 1)
end, { repeatable = true })
bind('I', 'stats', function() mp.commandv('script-binding', 'stats/display-stats-toggle') end)
bind('r', 'show-app', function() intent('show-app') end)
-- Shift+R (mpv's own R moves subtitles); core answers in the status line or a toast
bind('R', 'resync', function()
  if not S.perms.isHost then
    poke()
    intent('resync')
  end
end)
bind('CLOSE_WIN', 'close', function() intent('close') end)
bind('MBTN_LEFT', 'mouse', on_mouse_button, { complex = true })

-- defaults.lua only installs bindings from an idle callback; the app may send init (and expect our
-- keys to work once we answer) before that runs. Unbound, CLOSE_WIN would quit mpv outright.
local function flush_bindings()
  if mp.flush_keybindings then mp.flush_keybindings() end
end
flush_bindings()

-- ---- mpv properties -------------------------------------------------------------------------

local function update_dims()
  local d = mp.get_property_native('osd-dimensions') or {}
  local w, h = d.w or 0, d.h or 0
  if (w <= 0 or h <= 0) and test_dims then
    local tw, th = test_dims:match('^(%d+)x(%d+)$')
    w, h = tonumber(tw) or 0, tonumber(th) or 0
  end
  S.w, S.h = w, h
  S.scale = mp.get_property_number('display-hidpi-scale', 1) or 1
  request_render()
end

mp.observe_property('osd-dimensions', 'native', update_dims)
mp.observe_property('display-hidpi-scale', 'native', update_dims)
mp.observe_property('time-pos', 'number', function(_, v)
  S.pos = v
  request_render()
end)
mp.observe_property('duration', 'number', function(_, v)
  S.dur = v
  request_render()
end)
mp.observe_property('pause', 'bool', function(_, v)
  S.paused = v ~= false
  request_render()
  mp.add_timeout(HIDE_AFTER + 0.05, request_render)
end)
mp.observe_property('demuxer-cache-state', 'native', function(_, v)
  S.cache = (type(v) == 'table' and v['seekable-ranges']) or {}
  request_render()
end)
mp.observe_property('volume', 'number', function(_, v)
  S.volume = v or 100
  request_render()
end)
mp.observe_property('mute', 'bool', function(_, v)
  S.mute = v == true
  request_render()
end)
mp.observe_property('fullscreen', 'bool', function(_, v)
  S.fullscreen = v == true
  request_render()
end)
mp.observe_property('sub-visibility', 'bool', function(_, v)
  S.sub_visible = v ~= false
  request_render()
end)
mp.observe_property('mouse-pos', 'native', function(_, m)
  if type(m) ~= 'table' then return end
  local moved = m.x ~= S.mouse.x or m.y ~= S.mouse.y
  S.mouse = { x = m.x or -1, y = m.y or -1, hover = m.hover ~= false }
  if S.drag then
    local p = pos_at(S.mouse.x)
    if p then S.drag.pos = p end
  end
  if moved then poke() else request_render() end
end)

-- ---- messages from the app ------------------------------------------------------------------

local function parse(json)
  local v = utils.parse_json(json or '')
  if v == nil then mp.msg.warn('ignoring malformed message: ' .. tostring(json)) end
  return v
end

local function apply_theme(t)
  if type(t) ~= 'table' then return end
  if type(t.colors) == 'table' then
    for k, v in pairs(t.colors) do
      if valid_color(v) then S.colors[k] = v end
    end
  end
  request_render()
end

local function apply_perms(p)
  if type(p) ~= 'table' then return end
  S.perms = { isHost = p.isHost == true, canPlayPause = p.canPlayPause ~= false, canSeek = p.canSeek ~= false }
  request_render()
end

mp.register_script_message('init', function(json)
  local m = parse(json)
  if type(m) ~= 'table' or type(m.client) ~= 'string' then return end
  if m.v ~= PROTOCOL then mp.msg.warn('protocol ' .. tostring(m.v) .. ', expected ' .. PROTOCOL) end
  S.client = m.client
  S.watchdog = tonumber(m.watchdogS) or 0
  S.persistent_strip = m.persistentStrip == true
  S.last_hb = mp.get_time()
  if type(m.strings) == 'table' then
    for k, v in pairs(m.strings) do
      if type(v) == 'string' then S.strings[k] = v end
    end
  end
  apply_theme(m.theme)
  apply_perms(m.perms)
  flush_bindings()
  send('wt-ready', { v = PROTOCOL })
end)

mp.register_script_message('theme', function(json) apply_theme(parse(json)) end)
mp.register_script_message('perms', function(json) apply_perms(parse(json)) end)

mp.register_script_message('ranges', function(json)
  local r = parse(json)
  if type(r) ~= 'table' then return end
  local done = type(r.done) == 'table' and r.done or {}
  local group = type(r.groupDone) == 'table' and r.groupDone or nil
  -- the host's bar draws groupDone as done: a strip of the same spans under it would only repeat it
  if group and same_spans(group, done) then group = nil end
  S.ranges = {
    dur = tonumber(r.dur) or 0,
    done = done,
    loading = type(r.loading) == 'table' and r.loading or {},
    groupDone = group,
  }
  request_render()
end)

mp.register_script_message('peers', function(json)
  local p = parse(json)
  if type(p) ~= 'table' then return end
  S.peers = p
  request_render()
end)

mp.register_script_message('status', function(json)
  local st = parse(json)
  if type(st) ~= 'table' then return end
  S.status = { text = type(st.text) == 'string' and st.text or '', level = st.level or 'info' }
  request_render()
end)

mp.register_script_message('toast', function(json)
  local t = parse(json)
  if type(t) ~= 'table' or type(t.text) ~= 'string' then return end
  toast(t.text, (tonumber(t.ms) or 2000) / 1000)
end)

mp.register_script_message('ended', function(json)
  local e = parse(json)
  S.ended = type(e) == 'table' and e.ended == true
  request_render()
end)

mp.register_script_message('resync', function(json)
  local m = parse(json)
  S.resync_shown = type(m) == 'table' and m.shown == true
  request_render()
end)

mp.register_script_message('hb', function()
  S.last_hb = mp.get_time()
end)

-- A named pipe or socket server outlives the app; without heartbeats the player would be orphaned.
mp.add_periodic_timer(1, function()
  if S.client and S.watchdog > 0 and mp.get_time() - S.last_hb > S.watchdog then
    mp.msg.warn('no heartbeat for ' .. S.watchdog .. ' s; quitting')
    mp.command('quit')
  end
end)

update_dims()
