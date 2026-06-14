import http from 'node:http'
import zlib from 'node:zlib'
import WebSocket, { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 8787)
const F1_BASE = 'https://livetiming.formula1.com'
const SIGNALR = `${F1_BASE}/signalrcore`
const FRAME = '\x1e'
const TOPICS = [
  'Heartbeat',
  'CarData.z',
  'Position.z',
  'TimingData',
  'TimingAppData',
  'DriverList',
  'SessionInfo',
  'SessionData',
  'TrackStatus',
  'WeatherData',
  'RaceControlMessages',
  'TeamRadio',
]

const feeds = {}
const positionHistory = []
let fallbackTrackPoints = []
let fallbackTrackLoading = false
let fallbackTrackPath
const sseClients = new Set()
let f1Socket
let connecting = false
let connected = false
let lastMessageAt
let lastError
let reconnectTimer

function corsHeaders(contentType = 'application/json; charset=utf-8') {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
    'content-type': contentType,
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, corsHeaders())
  res.end(JSON.stringify(body))
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge(target, patch) {
  if (patch === undefined) return target
  if (Array.isArray(target) && isObject(patch)) {
    const merged = [...target]
    for (const [key, value] of Object.entries(patch)) {
      const index = Number(key)
      if (Number.isInteger(index)) merged[index] = deepMerge(merged[index], value)
      else merged[key] = value
    }
    return merged
  }
  if (Array.isArray(patch)) return patch.map((item, index) => deepMerge(Array.isArray(target) ? target[index] : undefined, item))
  if (isObject(patch)) {
    const merged = isObject(target) ? { ...target } : {}
    for (const [key, value] of Object.entries(patch)) merged[key] = deepMerge(merged[key], value)
    return merged
  }
  return patch
}

function decodeCompressedFeed(value) {
  const encoded = Array.isArray(value) ? value[0] : value
  if (typeof encoded !== 'string') return value
  const buffer = Buffer.from(encoded, 'base64')
  for (const inflate of [zlib.inflateRawSync, zlib.inflateSync, zlib.gunzipSync]) {
    try {
      return JSON.parse(inflate(buffer).toString('utf8'))
    } catch {
      // Try the next compression wrapper.
    }
  }
  return value
}

function normalizeTopic(topic, payload) {
  if (topic === 'CarData.z') return ['CarData', decodeCompressedFeed(payload)]
  if (topic === 'Position.z') return ['Position', decodeCompressedFeed(payload)]
  return [topic, payload]
}

function applyFeed(topic, payload) {
  const [key, value] = normalizeTopic(topic, payload)
  feeds[key] = deepMerge(feeds[key], value)
  if (key === 'Position') collectPositions(value)
  if (key === 'SessionInfo') loadFallbackTrack(value)
  lastMessageAt = new Date().toISOString()
}

function extractPositions(value) {
  const entries = []
  const series = Array.isArray(value?.Position) ? value.Position : Array.isArray(value?.Entries) ? value.Entries : []
  for (const item of series) {
    const cars = item.Entries ?? item.Cars ?? {}
    for (const [number, position] of Object.entries(cars)) {
      const x = Number(position.X ?? position.x)
      const y = Number(position.Y ?? position.y)
      const z = Number(position.Z ?? position.z ?? 0)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      entries.push({
        date: item.Timestamp ?? item.Utc ?? new Date().toISOString(),
        driver_number: Number(number),
        x,
        y,
        z,
      })
    }
  }
  return entries
}

function collectPositions(value) {
  const entries = extractPositions(value)
  positionHistory.push(...entries)
  if (positionHistory.length > 5000) positionHistory.splice(0, positionHistory.length - 5000)
}

async function loadFallbackTrack(info) {
  if (fallbackTrackLoading || fallbackTrackPoints.length || !info?.Path) return
  fallbackTrackLoading = true
  try {
    const year = String(info.StartDate?.slice(0, 4) ?? new Date().getUTCFullYear())
    const index = await fetch(`${F1_BASE}/static/${year}/Index.json`).then((response) => response.text()).then((text) => JSON.parse(text.replace(/^\uFEFF/, '')))
    const meeting = index.Meetings?.find((item) => Number(item.Key) === Number(info.Meeting?.Key))
    const sessions = meeting?.Sessions?.filter((session) => session.Path && session.Path !== info.Path) ?? []
    const priority = { Qualifying: 0, Sprint: 1, Practice: 2 }
    const sourceSession = sessions.sort((a, b) => (priority[a.Type] ?? 9) - (priority[b.Type] ?? 9) || Number(b.Number ?? 0) - Number(a.Number ?? 0))[0]
    if (!sourceSession?.Path) return

    fallbackTrackPath = sourceSession.Path
    const stream = await fetch(`${F1_BASE}/static/${sourceSession.Path}Position.z.jsonStream`).then((response) => response.ok ? response.text() : '')
    const points = []
    for (const [index, line] of stream.replace(/^\uFEFF/, '').split('\n').entries()) {
      if (!line || index % 20 !== 0) continue
      const match = line.match(/^[^"]+"([^"]+)"/)
      if (!match) continue
      const decoded = decodeCompressedFeed(match[1])
      points.push(...extractPositions(decoded).filter((point) => point.x !== 0 || point.y !== 0))
    }
    fallbackTrackPoints = points.slice(-3500)
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error)
  } finally {
    fallbackTrackLoading = false
  }
}

function parseLapTime(value) {
  if (!value || typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const parts = trimmed.split(':')
  if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1])
  const numeric = Number(trimmed)
  return Number.isFinite(numeric) ? numeric : null
}

function numberValue(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
}

function utcFromLocal(value, offsetValue = '00:00:00') {
  if (!value) return undefined
  const sign = offsetValue.startsWith('-') ? -1 : 1
  const clean = offsetValue.replace(/^[+-]/, '')
  const [hours = 0, minutes = 0] = clean.split(':').map(Number)
  const offsetMs = sign * ((hours * 60) + minutes) * 60_000
  const localMs = Date.parse(`${value}Z`)
  return new Date(localMs - offsetMs).toISOString()
}

function toSession(info) {
  if (!info) return undefined
  return {
    session_key: Number(info.Key ?? 0),
    meeting_key: Number(info.Meeting?.Key ?? 0),
    session_name: info.Name ?? 'Race',
    session_type: info.Type ?? 'Race',
    date_start: utcFromLocal(info.StartDate, info.GmtOffset) ?? new Date().toISOString(),
    date_end: utcFromLocal(info.EndDate, info.GmtOffset) ?? new Date().toISOString(),
    circuit_short_name: info.Meeting?.Circuit?.ShortName ?? '--',
    country_name: info.Meeting?.Country?.Name ?? '--',
    location: info.Meeting?.Location ?? info.Meeting?.Name ?? '--',
    year: Number(info.StartDate?.slice(0, 4) ?? new Date().getUTCFullYear()),
  }
}

function sectorSegments(line, index) {
  const sector = line?.Sectors?.[index]
  const segments = sector?.Segments ?? []
  return Object.keys(segments)
    .sort((a, b) => Number(a) - Number(b))
    .map((key) => Number(segments[key]?.Status ?? 0))
}

function latestCarData(driverNumber) {
  const entries = feeds.CarData?.Entries ?? feeds.CarData?.CarData ?? []
  const latest = Array.isArray(entries) ? entries.at(-1) : undefined
  const car = latest?.Cars?.[driverNumber] ?? latest?.Entries?.[driverNumber]
  const channels = car?.Channels ?? car
  if (!channels) return undefined
  return {
    date: latest.Utc ?? latest.Timestamp ?? new Date().toISOString(),
    driver_number: Number(driverNumber),
    rpm: Number(channels['0'] ?? channels.RPM ?? 0),
    speed: Number(channels['2'] ?? channels.Speed ?? 0),
    n_gear: Number(channels['3'] ?? channels.nGear ?? 0),
    throttle: Number(channels['4'] ?? channels.Throttle ?? 0),
    brake: Number(channels['5'] ?? channels.Brake ?? 0),
    drs: Number(channels['45'] ?? channels.DRS ?? 0),
  }
}

function latestLocation(driverNumber) {
  for (let index = positionHistory.length - 1; index >= 0; index -= 1) {
    if (positionHistory[index].driver_number === Number(driverNumber)) return positionHistory[index]
  }
  return undefined
}

function trackTelemetry() {
  const source = positionHistory.length ? positionHistory : fallbackTrackPoints
  const latest = []
  const seen = new Set()
  for (let index = positionHistory.length - 1; index >= 0; index -= 1) {
    const point = positionHistory[index]
    if (seen.has(point.driver_number)) continue
    seen.add(point.driver_number)
    latest.push(point)
  }
  const stride = Math.max(1, Math.ceil(source.length / 900))
  return {
    cloud: source.filter((_, index) => index % stride === 0),
    segments: [],
    latest,
    sourceCount: source.length,
    sampledCount: Math.ceil(source.length / stride),
    driverNumber: fallbackTrackPath ? 0 : undefined,
    from: source[0]?.date,
    to: source.at(-1)?.date,
  }
}

function buildRows() {
  const timingLines = feeds.TimingData?.Lines ?? {}
  const appLines = feeds.TimingAppData?.Lines ?? {}
  const driverList = feeds.DriverList ?? {}

  return Object.values(driverList)
    .filter((driver) => driver?.RacingNumber)
    .map((driver) => {
      const number = String(driver.RacingNumber)
      const line = timingLines[number] ?? {}
      const appLine = appLines[number] ?? {}
      const stint = Array.isArray(appLine.Stints) ? appLine.Stints.at(-1) : undefined
      const speed = numberValue(line.Speeds?.ST?.Value ?? line.Speeds?.FL?.Value ?? line.Speeds?.I2?.Value ?? line.Speeds?.I1?.Value)
      const car = latestCarData(number) ?? {
        date: lastMessageAt ?? new Date().toISOString(),
        driver_number: Number(number),
        speed: speed ?? 0,
        throttle: 0,
        brake: 0,
        rpm: 0,
        n_gear: 0,
        drs: 0,
      }
      const position = Number(line.Position ?? driver.Line ?? appLine.Line ?? 99)
      const lastLapSeconds = parseLapTime(line.LastLapTime?.Value)
      const bestLapSeconds = parseLapTime(line.BestLapTime?.Value)
      return {
        driver: {
          driver_number: Number(number),
          broadcast_name: driver.BroadcastName ?? driver.FullName ?? number,
          full_name: driver.FullName ?? driver.BroadcastName ?? number,
          name_acronym: driver.Tla ?? number,
          team_name: driver.TeamName ?? '--',
          team_colour: driver.TeamColour ?? '6b7280',
        },
        car,
        location: latestLocation(number),
        position,
        bestLap: bestLapSeconds ? {
          driver_number: Number(number),
          lap_number: Number(line.NumberOfLaps ?? stint?.LapNumber ?? 0),
          lap_duration: bestLapSeconds,
          duration_sector_1: null,
          duration_sector_2: null,
          duration_sector_3: null,
          segments_sector_1: [],
          segments_sector_2: [],
          segments_sector_3: [],
          st_speed: speed ?? null,
          date_start: null,
        } : undefined,
        lastLap: lastLapSeconds ? {
          driver_number: Number(number),
          lap_number: Number(line.NumberOfLaps ?? stint?.LapNumber ?? 0),
          lap_duration: lastLapSeconds,
          duration_sector_1: parseLapTime(line.Sectors?.[0]?.Value),
          duration_sector_2: parseLapTime(line.Sectors?.[1]?.Value),
          duration_sector_3: parseLapTime(line.Sectors?.[2]?.Value),
          segments_sector_1: sectorSegments(line, 0),
          segments_sector_2: sectorSegments(line, 1),
          segments_sector_3: sectorSegments(line, 2),
          st_speed: speed ?? null,
          date_start: null,
        } : undefined,
        stint: stint ? {
          driver_number: Number(number),
          stint_number: Number(appLine.Stints?.length ?? 1),
          compound: stint.Compound ?? '',
          tyre_age_at_start: Number(stint.StartLaps ?? 0),
          lap_start: Number(stint.StartLaps ?? 0),
          lap_end: null,
        } : undefined,
        gap: position === 1 ? '领先' : line.GapToLeader ?? '--',
        interval: line.IntervalToPositionAhead?.Value ?? '--',
        sectors: [0, 1, 2].flatMap((index) => sectorSegments(line, index)).slice(0, 12),
      }
    })
    .filter((row) => Number.isFinite(row.position))
    .sort((a, b) => a.position - b.position)
}

function buildRaceControl() {
  const messages = feeds.RaceControlMessages?.Messages ?? []
  return messages.slice(-12).reverse().map((message) => ({
    date: message.Utc ?? new Date().toISOString(),
    driver_number: message.RacingNumber ? Number(message.RacingNumber) : null,
    lap_number: message.Lap ? Number(message.Lap) : null,
    category: message.Category ?? 'Other',
    flag: message.Flag ?? null,
    scope: message.Scope ?? null,
    sector: message.Sector ? Number(message.Sector) : null,
    message: message.Message ?? '',
  }))
}

function buildTeamRadio(session) {
  const captures = feeds.TeamRadio?.Captures ?? []
  return captures.slice(-8).reverse().map((capture) => ({
    date: capture.Utc ?? new Date().toISOString(),
    driver_number: Number(capture.RacingNumber),
    recording_url: capture.Path?.startsWith('http')
      ? capture.Path
      : `${F1_BASE}/static/${session?.Path ?? ''}${capture.Path ?? ''}`,
  }))
}

function buildWeather() {
  const weather = feeds.WeatherData
  if (!weather) return undefined
  return {
    date: lastMessageAt ?? new Date().toISOString(),
    air_temperature: Number(weather.AirTemp ?? 0),
    track_temperature: Number(weather.TrackTemp ?? 0),
    humidity: Number(weather.Humidity ?? 0),
    pressure: Number(weather.Pressure ?? 0),
    wind_speed: Number(weather.WindSpeed ?? 0),
    wind_direction: Number(weather.WindDirection ?? 0),
    rainfall: Number(weather.Rainfall ?? 0),
  }
}

function buildSnapshot() {
  const session = toSession(feeds.SessionInfo)
  const rows = buildRows()
  const track = trackTelemetry()
  return {
    mode: connected && rows.length ? 'live' : 'restricted',
    targetSession: session,
    dataSession: session,
    rows,
    locations: track.latest,
    track,
    raceControl: buildRaceControl(),
    teamRadio: buildTeamRadio(feeds.SessionInfo),
    weather: buildWeather(),
    updatedAt: lastMessageAt ?? new Date().toISOString(),
    error: connected ? undefined : (lastError ?? '等待 F1 Live Timing 连接'),
    sourceLabel: 'F1 官方 Live Timing 代理',
    connection: {
      connected,
      lastMessageAt,
      lastError,
      feeds: Object.keys(feeds),
    },
  }
}

function broadcast() {
  const payload = `data: ${JSON.stringify(buildSnapshot())}\n\n`
  for (const client of sseClients) client.write(payload)
}

async function connectF1() {
  if (connecting || connected) return
  connecting = true
  clearTimeout(reconnectTimer)

  try {
    const response = await fetch(`${SIGNALR}/negotiate?negotiateVersion=1`, { method: 'POST' })
    const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie')].filter(Boolean)
    const cookie = cookies.map((value) => value.split(';')[0]).join('; ')
    const negotiated = await response.json()
    const token = negotiated.connectionToken ?? negotiated.connectionId
    if (!token) throw new Error('F1 negotiate did not return a connection token')

    f1Socket = new WebSocket(`${SIGNALR.replace('https://', 'wss://')}?id=${encodeURIComponent(token)}`, {
      headers: {
        Cookie: cookie,
        Origin: 'https://www.formula1.com',
        'User-Agent': 'Mozilla/5.0',
      },
    })

    f1Socket.on('open', () => {
      connected = true
      connecting = false
      lastError = undefined
      f1Socket.send(JSON.stringify({ protocol: 'json', version: 1 }) + FRAME)
      setTimeout(() => {
        if (f1Socket?.readyState === WebSocket.OPEN) {
          f1Socket.send(JSON.stringify({ type: 1, target: 'Subscribe', invocationId: '0', arguments: [TOPICS] }) + FRAME)
        }
      }, 250)
    })

    f1Socket.on('message', (data) => {
      for (const frame of data.toString().split(FRAME).filter(Boolean)) {
        let message
        try {
          message = JSON.parse(frame)
        } catch {
          continue
        }
        if (message.type === 3 && message.result) {
          for (const [topic, payload] of Object.entries(message.result)) applyFeed(topic, payload)
        }
        if (message.type === 1 && message.arguments) {
          const [topic, payload] = message.arguments
          applyFeed(topic, payload)
        }
      }
      broadcast()
    })

    f1Socket.on('error', (error) => {
      lastError = error.message
    })

    f1Socket.on('close', () => {
      connected = false
      connecting = false
      reconnectTimer = setTimeout(connectF1, 3000)
      broadcast()
    })
  } catch (error) {
    connected = false
    connecting = false
    lastError = error instanceof Error ? error.message : String(error)
    reconnectTimer = setTimeout(connectF1, 5000)
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  if (url.pathname === '/health') {
    connectF1()
    writeJson(res, 200, { ok: true, connected, connecting, lastMessageAt, lastError, feeds: Object.keys(feeds) })
    return
  }
  if (url.pathname === '/api/live') {
    connectF1()
    writeJson(res, 200, buildSnapshot())
    return
  }
  if (url.pathname === '/api/events') {
    connectF1()
    res.writeHead(200, {
      ...corsHeaders('text/event-stream; charset=utf-8'),
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    sseClients.add(res)
    res.write(`data: ${JSON.stringify(buildSnapshot())}\n\n`)
    const keepAlive = setInterval(() => res.write(': keepalive\n\n'), 15000)
    req.on('close', () => {
      clearInterval(keepAlive)
      sseClients.delete(res)
    })
    return
  }

  writeJson(res, 404, { error: 'Not found' })
})

const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (socket) => {
  connectF1()
  socket.send(JSON.stringify(buildSnapshot()))
  const interval = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(buildSnapshot()))
  }, 1000)
  socket.on('close', () => clearInterval(interval))
})

server.listen(PORT, () => {
  console.log(`F1 live proxy listening on ${PORT}`)
  connectF1()
})
