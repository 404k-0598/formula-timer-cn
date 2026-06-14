import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  Activity,
  BarChart3,
  CloudSun,
  Flag,
  Gauge,
  Map as MapIcon,
  Mic2,
  Radio,
  RefreshCw,
  Satellite,
  Settings2,
  Timer,
} from 'lucide-react'
import './App.css'

const API = 'https://api.openf1.org/v1'
const CURRENT_YEAR = new Date().getUTCFullYear()
const REFRESH_MS = 30000
const API_STEP_MS = 1000
const TRACK_SAMPLE_MS = 120000
const TRACK_CACHE_VERSION = 'track-v4'

type Session = {
  session_key: number
  meeting_key: number
  session_name: string
  session_type: string
  date_start: string
  date_end: string
  circuit_short_name: string
  country_name: string
  location: string
  year: number
}

type Driver = {
  driver_number: number
  broadcast_name: string
  full_name: string
  name_acronym: string
  team_name: string
  team_colour: string
}

type CarData = {
  date: string
  driver_number: number
  speed: number
  throttle: number
  brake: number
  rpm: number
  n_gear: number
  drs: number
}

type LocationData = {
  date: string
  driver_number: number
  x: number
  y: number
  z: number
}

type PositionData = {
  date: string
  driver_number: number
  position: number
}

type LapData = {
  driver_number: number
  lap_number: number
  lap_duration: number | null
  duration_sector_1: number | null
  duration_sector_2: number | null
  duration_sector_3: number | null
  segments_sector_1: Array<number | null>
  segments_sector_2: Array<number | null>
  segments_sector_3: Array<number | null>
  st_speed: number | null
  date_start: string | null
}

type StintData = {
  driver_number: number
  stint_number: number
  compound: string
  tyre_age_at_start: number
  lap_start: number
  lap_end: number | null
}

type RaceControl = {
  date: string
  driver_number: number | null
  lap_number: number | null
  category: string
  flag: string | null
  scope: string | null
  sector: number | null
  message: string
}

type TeamRadio = {
  date: string
  driver_number: number
  recording_url: string
}

type Weather = {
  date: string
  air_temperature: number
  track_temperature: number
  humidity: number
  pressure: number
  wind_speed: number
  wind_direction: number
  rainfall: number
}

type Row = {
  driver: Driver
  car?: CarData
  location?: LocationData
  position: number
  bestLap?: LapData
  lastLap?: LapData
  stint?: StintData
  gap: string
  interval: string
  sectors: Array<number | null>
}

type TrackTelemetry = {
  cloud: LocationData[]
  segments: LocationData[][]
  latest: LocationData[]
  sourceCount: number
  sampledCount: number
  driverNumber?: number
  from?: string
  to?: string
}

type DashboardState = {
  mode: 'loading' | 'live' | 'waiting' | 'replay' | 'error'
  targetSession?: Session
  dataSession?: Session
  nextSession?: Session
  rows: Row[]
  locations: LocationData[]
  track: TrackTelemetry
  raceControl: RaceControl[]
  teamRadio: TeamRadio[]
  weather?: Weather
  updatedAt?: string
  error?: string
}

const initialState: DashboardState = {
  mode: 'loading',
  rows: [],
  locations: [],
  track: {
    cloud: [],
    segments: [],
    latest: [],
    sourceCount: 0,
    sampledCount: 0,
  },
  raceControl: [],
  teamRadio: [],
}

function endpoint(path: string, params: Record<string, string | number | undefined>) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => {
      const encoded = encodeURIComponent(String(value))
      return key.endsWith('>=') || key.endsWith('<=') ? `${key}${encoded}` : `${key}=${encoded}`
    })
    .join('&')
  return `${API}/${path}?${query}`
}

async function fetchJson<T>(path: string, params: Record<string, string | number | undefined>, attempt = 0): Promise<T> {
  const response = await fetch(endpoint(path, params))
  if (response.status === 429 && attempt < 2) {
    await wait(2500 * (attempt + 1))
    return fetchJson<T>(path, params, attempt + 1)
  }
  if (!response.ok) throw new Error(`${path} ${response.status}`)
  const payload = await response.json()
  if (payload?.detail) return [] as T
  return payload as T
}

async function fetchArray<T>(path: string, params: Record<string, string | number | undefined>) {
  try {
    return await fetchJson<T[]>(path, params)
  } catch {
    return []
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function byLatestDate<T extends { date: string; driver_number: number }>(items: T[]) {
  const latest = new Map<number, T>()
  for (const item of items) {
    const current = latest.get(item.driver_number)
    if (!current || item.date > current.date) latest.set(item.driver_number, item)
  }
  return latest
}

function latestByDriver<T extends { driver_number: number }>(items: T[], score: (item: T) => number) {
  const latest = new Map<number, T>()
  for (const item of items) {
    const current = latest.get(item.driver_number)
    if (!current || score(item) >= score(current)) latest.set(item.driver_number, item)
  }
  return latest
}

function formatTime(value?: string) {
  if (!value) return '--'
  return new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
}

function formatDelta(ms?: number | null) {
  if (!ms || !Number.isFinite(ms)) return '--'
  const minutes = Math.floor(ms / 60)
  const seconds = ms - minutes * 60
  return `${minutes}:${seconds.toFixed(3).padStart(6, '0')}`
}

function sessionName(session?: Session) {
  if (!session) return '等待会话'
  const countryMap: Record<string, string> = {
    Spain: '西班牙',
    Canada: '加拿大',
    Monaco: '摩纳哥',
    Italy: '意大利',
    Singapore: '新加坡',
    Japan: '日本',
    China: '中国',
    Australia: '澳大利亚',
    Austria: '奥地利',
    Belgium: '比利时',
    Hungary: '匈牙利',
    Netherlands: '荷兰',
    Mexico: '墨西哥',
    Brazil: '巴西',
    Qatar: '卡塔尔',
  }
  const typeMap: Record<string, string> = {
    Race: '正赛',
    Qualifying: '排位赛',
    Practice: '练习赛',
    Sprint: '冲刺赛',
    'Sprint Qualifying': '冲刺排位',
  }
  return `${countryMap[session.country_name] ?? session.country_name} ${typeMap[session.session_name] ?? session.session_name}`
}

function shortSessionName(session?: Session) {
  if (!session) return '--'
  return sessionName(session).split(' ').at(-1) ?? session.session_name
}

function sessionTitle(session?: Session) {
  if (!session) return '等待数据'
  return `${session.location} ${shortSessionName(session)}`
}

function statusLabel(mode: DashboardState['mode']) {
  if (mode === 'live') return '实时'
  if (mode === 'waiting') return '等待开赛'
  if (mode === 'replay') return '最近真实数据'
  if (mode === 'error') return '数据错误'
  return '载入中'
}

function compoundShort(compound?: string) {
  if (!compound) return '--'
  const map: Record<string, string> = {
    SOFT: 'S',
    MEDIUM: 'M',
    HARD: 'H',
    INTERMEDIATE: 'I',
    WET: 'W',
  }
  return map[compound] ?? compound.slice(0, 1)
}

function compoundLabel(compound?: string) {
  if (!compound) return '--'
  const map: Record<string, string> = {
    SOFT: '软胎',
    MEDIUM: '中性胎',
    HARD: '硬胎',
    INTERMEDIATE: '半雨胎',
    WET: '雨胎',
  }
  return map[compound] ?? compound
}

function flagLabel(value?: string | null) {
  if (!value) return '--'
  const map: Record<string, string> = {
    CLEAR: '清除',
    GREEN: '绿旗',
    YELLOW: '黄旗',
    RED: '红旗',
    BLUE: '蓝旗',
    CHEQUERED: '方格旗',
    BLACK: '黑旗',
    SAFETY_CAR: '安全车',
    VSC: '虚拟安全车',
    Other: '其他',
    FLAG: '旗语',
    CAR_EVENT: '赛车事件',
    DRIVERS: '车手',
  }
  return map[value] ?? value
}

function segmentClass(code: number | null) {
  if (code === 2051) return 'purple'
  if (code === 2049) return 'green'
  if (code === 2048) return 'yellow'
  return 'neutral'
}

function latestWindow(session: Session, mode: 'live' | 'replay') {
  const start = new Date(session.date_start)
  const end = new Date(session.date_end)
  if (mode === 'live') {
    const now = new Date()
    const to = new Date(Math.min(now.getTime(), end.getTime()))
    const from = new Date(Math.max(start.getTime(), to.getTime() - 15000))
    return { from: toOpenF1Date(from), to: toOpenF1Date(to) }
  }

  const midpoint = new Date(start.getTime() + Math.min(15 * 60_000, Math.max(0, end.getTime() - start.getTime()) / 2))
  return {
    from: toOpenF1Date(new Date(midpoint.getTime() - 4000)),
    to: toOpenF1Date(new Date(midpoint.getTime() + 4000)),
  }
}

function trackWindow(session: Session, mode: 'live' | 'replay') {
  const start = new Date(session.date_start)
  const end = new Date(session.date_end)
  const now = new Date()
  const from = start
  const targetTo = mode === 'live' ? new Date(Math.min(now.getTime(), end.getTime())) : end
  const to = new Date(Math.min(targetTo.getTime(), start.getTime() + TRACK_SAMPLE_MS))
  return { from: toOpenF1Date(from), to: toOpenF1Date(to), complete: to.getTime() - from.getTime() >= TRACK_SAMPLE_MS * 0.85 }
}

function toOpenF1Date(date: Date) {
  return date.toISOString().slice(0, 19)
}

function distance(a: LocationData, b: LocationData) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function spatialSample(points: LocationData[], maxPoints = 900) {
  const grid = new Map<string, LocationData>()
  for (const point of points) {
    const key = `${Math.round(point.x / 95)}:${Math.round(point.y / 95)}`
    if (!grid.has(key)) grid.set(key, point)
  }

  const sampled = Array.from(grid.values())
  if (sampled.length <= maxPoints) return sampled
  const stride = Math.ceil(sampled.length / maxPoints)
  return sampled.filter((_, index) => index % stride === 0).slice(0, maxPoints)
}

function simplifyPath(points: LocationData[], minStep = 70, maxPoints = 340) {
  const simplified: LocationData[] = []
  for (const point of points) {
    const previous = simplified.at(-1)
    if (!previous || distance(previous, point) >= minStep) simplified.push(point)
  }

  const source = simplified.length >= 3 ? simplified : points
  if (source.length <= maxPoints) return source
  const stride = Math.ceil(source.length / maxPoints)
  return source.filter((_, index) => index % stride === 0)
}

function buildTrackSegments(points: LocationData[]) {
  const byDriver = new Map<number, LocationData[]>()
  for (const point of points) {
    const bucket = byDriver.get(point.driver_number) ?? []
    bucket.push(point)
    byDriver.set(point.driver_number, bucket)
  }

  let selectedDriver: number | undefined
  let selectedPoints: LocationData[] = []
  let bestScore = Number.NEGATIVE_INFINITY

  for (const [driverNumber, driverPoints] of byDriver) {
    const sorted = [...driverPoints].sort((a, b) => a.date.localeCompare(b.date))
    const xs = sorted.map((point) => point.x)
    const ys = sorted.map((point) => point.y)
    const area = (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
    const score = sorted.length + area / 15000
    if (score > bestScore) {
      bestScore = score
      selectedDriver = driverNumber
      selectedPoints = sorted
    }
  }

  const segments: LocationData[][] = []
  let segment: LocationData[] = []
  for (const point of selectedPoints) {
    const previous = segment.at(-1)
    if (previous && distance(previous, point) > 2300) {
      if (segment.length >= 3) segments.push(simplifyPath(segment))
      segment = []
    }
    segment.push(point)
  }
  if (segment.length >= 3) segments.push(simplifyPath(segment))

  return { segments, selectedDriver }
}

function buildTrackTelemetry(points: LocationData[], from?: string, to?: string): TrackTelemetry {
  const clean = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  const cloud = spatialSample(clean)
  const { segments, selectedDriver } = buildTrackSegments(clean)
  return {
    cloud,
    segments,
    latest: Array.from(byLatestDate(clean).values()),
    sourceCount: clean.length,
    sampledCount: cloud.length + segments.reduce((sum, segment) => sum + segment.length, 0),
    driverNumber: selectedDriver,
    from,
    to,
  }
}

function trackCacheKey(session: Session) {
  return `${TRACK_CACHE_VERSION}:${session.session_key}`
}

function readCachedTrack(session: Session) {
  try {
    const value = window.sessionStorage.getItem(trackCacheKey(session))
    if (!value) return undefined
    return JSON.parse(value) as TrackTelemetry
  } catch {
    return undefined
  }
}

function writeCachedTrack(session: Session, track: TrackTelemetry) {
  try {
    window.sessionStorage.setItem(trackCacheKey(session), JSON.stringify(track))
  } catch {
    // Storage can be unavailable in private browsing; the map still works without cache.
  }
}

async function loadTrackTelemetry(session: Session, mode: 'live' | 'replay') {
  const cached = readCachedTrack(session)
  if (cached?.sourceCount) return cached

  const window = trackWindow(session, mode)
  const points = await fetchArray<LocationData>('location', { session_key: session.session_key, 'date>=': window.from, 'date<=': window.to })
  const track = buildTrackTelemetry(points, window.from, window.to)
  if (window.complete && track.sourceCount) writeCachedTrack(session, track)
  return track
}

function chooseSessions(sessions: Session[], now = new Date()) {
  const sorted = [...sessions].sort((a, b) => new Date(a.date_start).getTime() - new Date(b.date_start).getTime())
  const active = sorted.find((session) => {
    const start = new Date(session.date_start).getTime()
    const end = new Date(session.date_end).getTime()
    return now.getTime() >= start && now.getTime() <= end
  })
  const next = sorted.find((session) => new Date(session.date_start).getTime() > now.getTime())
  const latestPast = [...sorted].reverse().find((session) => new Date(session.date_end).getTime() < now.getTime())
  return { active, next, latestPast }
}

async function loadDashboard(): Promise<DashboardState> {
  const sessions = await fetchJson<Session[]>('sessions', { year: CURRENT_YEAR })
  const { active, next, latestPast } = chooseSessions(sessions)
  const dataSession = active ?? latestPast
  if (!dataSession) {
    return {
      ...initialState,
      mode: 'waiting',
      nextSession: next,
      targetSession: next,
      updatedAt: new Date().toISOString(),
    }
  }

  const mode: DashboardState['mode'] = active ? 'live' : next ? 'waiting' : 'replay'
  const dataMode = active ? 'live' : 'replay'
  const window = latestWindow(dataSession, dataMode)

  const drivers = await fetchJson<Driver[]>('drivers', { session_key: dataSession.session_key })
  const carData = await fetchArray<CarData>('car_data', { session_key: dataSession.session_key, 'date>=': window.from, 'date<=': window.to })
  await wait(API_STEP_MS)
  const track = await loadTrackTelemetry(dataSession, dataMode)
  await wait(API_STEP_MS)
  const locations = dataMode === 'live'
    ? await fetchArray<LocationData>('location', { session_key: dataSession.session_key, 'date>=': window.from, 'date<=': window.to })
    : track.latest
  await wait(API_STEP_MS)
  const positions = await fetchArray<PositionData>('position', { session_key: dataSession.session_key })
  await wait(API_STEP_MS)
  const laps = await fetchArray<LapData>('laps', { session_key: dataSession.session_key })
  await wait(API_STEP_MS)
  const stints = await fetchArray<StintData>('stints', { session_key: dataSession.session_key })
  await wait(API_STEP_MS)
  const raceControl = await fetchArray<RaceControl>('race_control', { session_key: dataSession.session_key })
  await wait(API_STEP_MS)
  const teamRadio = await fetchArray<TeamRadio>('team_radio', { session_key: dataSession.session_key })
  await wait(API_STEP_MS)
  const weather = await fetchArray<Weather>('weather', { session_key: dataSession.session_key })

  const carByDriver = byLatestDate(carData)
  const locationByDriver = byLatestDate(locations)
  const positionByDriver = byLatestDate(positions)
  const latestLap = latestByDriver(laps.filter((lap) => lap.lap_number), (lap) => lap.lap_number)
  const bestLap = latestByDriver(
    laps.filter((lap) => lap.lap_duration && Number.isFinite(lap.lap_duration)),
    (lap) => lap.lap_duration ? -lap.lap_duration : Number.NEGATIVE_INFINITY,
  )
  const latestStint = latestByDriver(stints, (stint) => stint.stint_number ?? stint.lap_start)

  const rows = drivers
    .map((driver) => {
      const lastLap = latestLap.get(driver.driver_number)
      const position = positionByDriver.get(driver.driver_number)?.position ?? 99
      return {
        driver,
        car: carByDriver.get(driver.driver_number),
        location: locationByDriver.get(driver.driver_number),
        position,
        bestLap: bestLap.get(driver.driver_number),
        lastLap,
        stint: latestStint.get(driver.driver_number),
        gap: position === 1 ? '领先' : '--',
        interval: '--',
        sectors: [
          ...(lastLap?.segments_sector_1 ?? []),
          ...(lastLap?.segments_sector_2 ?? []),
          ...(lastLap?.segments_sector_3 ?? []),
        ].slice(0, 12),
      }
    })
    .filter((row) => row.car || row.position < 99 || row.lastLap)
    .sort((a, b) => a.position - b.position)

  return {
    mode,
    targetSession: active ?? next ?? dataSession,
    dataSession,
    nextSession: next,
    rows,
    locations,
    track,
    raceControl: raceControl.slice(-8).reverse(),
    teamRadio: teamRadio.slice(-8).reverse(),
    weather: weather.at(-1),
    updatedAt: new Date().toISOString(),
  }
}

function useDashboard() {
  const [state, setState] = useState<DashboardState>(initialState)

  const refresh = useCallback(async () => {
    try {
      setState((current) => ({ ...current, mode: current.mode === 'loading' ? 'loading' : current.mode }))
      const next = await loadDashboard()
      setState(next)
    } catch (error) {
      setState((current) => ({
        ...current,
        mode: 'error',
        error: error instanceof Error ? error.message : '未知错误',
        updatedAt: new Date().toISOString(),
      }))
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = window.setInterval(refresh, REFRESH_MS)
    return () => window.clearInterval(id)
  }, [refresh])

  return { state, refresh }
}

function useNow() {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(id)
  }, [])

  return now
}

function App() {
  const { state, refresh } = useDashboard()
  const now = useNow()
  const countdown = useMemo(() => {
    const target = state.nextSession ?? state.targetSession
    if (!target) return ''
    const ms = new Date(target.date_start).getTime() - now
    if (ms <= 0) return '会话进行中或已结束'
    const hours = Math.floor(ms / 3_600_000)
    const minutes = Math.floor((ms % 3_600_000) / 60_000)
    return `${hours}小时 ${minutes}分钟`
  }, [now, state.nextSession, state.targetSession])

  const fastest = state.rows.find((row) => row.bestLap?.lap_duration)

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">FT</div>
          <div>
            <h1>方程式实时计时</h1>
            <span>OpenF1 实时遥测中文看板</span>
          </div>
        </div>
        <div className="session-pill">
          <Satellite size={16} />
          <strong>{sessionName(state.targetSession ?? state.dataSession)}</strong>
          <span>{statusLabel(state.mode)}</span>
        </div>
        <button className="refresh-button" type="button" onClick={refresh}>
          <RefreshCw size={16} />
          <span>刷新</span>
        </button>
      </header>

      <section className="status-grid">
        <StatusCard label="数据状态" value={statusLabel(state.mode)} detail={state.error ?? 'OpenF1 公共 API'} accent="red" />
        <StatusCard label="目标会话" value={shortSessionName(state.targetSession)} detail={countdown || '实时轮询中'} accent="amber" />
        <StatusCard label="数据会话" value={shortSessionName(state.dataSession)} detail={state.dataSession?.circuit_short_name ?? '--'} accent="blue" />
        <StatusCard label="最后更新" value={formatTime(state.updatedAt)} detail={`刷新间隔 ${REFRESH_MS / 1000}s`} accent="green" />
      </section>

      <section className="workspace">
        <section className="main-panel timing-panel">
          <div className="panel-head">
            <div>
              <span>实时计时</span>
              <h2>{sessionTitle(state.dataSession)}</h2>
            </div>
            <div className="panel-actions">
              <span><Activity size={14} /> {state.rows.length} 位车手</span>
              <span><Gauge size={14} /> {fastest?.driver.name_acronym ?? '--'} 最快</span>
            </div>
          </div>
          <TimingTable rows={state.rows} />
        </section>

        <aside className="side-column">
          <TrackMap rows={state.rows} track={state.track} />
          <WeatherPanel weather={state.weather} />
          <RaceControlPanel messages={state.raceControl} />
          <TeamRadioPanel radios={state.teamRadio} rows={state.rows} />
        </aside>
      </section>

      <section className="analysis-row">
        <LapChart rows={state.rows} />
        <TyrePanel rows={state.rows} />
      </section>
    </main>
  )
}

function StatusCard({ label, value, detail, accent }: { label: string; value: string; detail: string; accent: string }) {
  return (
    <article className={`status-card accent-${accent}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  )
}

function TimingTable({ rows }: { rows: Row[] }) {
  return (
    <div className="timing-table">
      <div className="table-head">
        <span>排名</span>
        <span>车手</span>
        <span>尾翼</span>
        <span>遥测</span>
        <span>速度</span>
        <span>最佳/上一圈</span>
        <span>差距</span>
        <span>微分段</span>
        <span>轮胎</span>
      </div>
      {rows.length === 0 ? (
        <div className="empty-state">
          <Timer size={22} />
          <strong>当前会话还没有遥测数据</strong>
          <span>如果正赛尚未开始，这里会先显示最近真实会话；会话开始后自动切到实时数据。</span>
        </div>
      ) : (
        rows.map((row) => <TimingRow row={row} key={row.driver.driver_number} />)
      )}
    </div>
  )
}

function TimingRow({ row }: { row: Row }) {
  const color = `#${row.driver.team_colour || '6b7280'}`
  const car = row.car
  const drs = car && car.drs >= 8
  const rpm = Math.min(100, ((car?.rpm ?? 0) / 13000) * 100)

  return (
    <article className="timing-row" style={{ '--team': color, '--rpm': `${rpm}%` } as CSSProperties}>
      <div className="pos-cell">
        <strong>{row.position < 99 ? row.position : '--'}</strong>
      </div>
      <div className="driver-cell">
        <strong>{row.driver.name_acronym}</strong>
        <span>{row.driver.driver_number} · {row.driver.team_name}</span>
      </div>
      <div className={drs ? 'drs-cell open' : 'drs-cell'}>
        <span>尾翼</span>
        <strong>{drs ? '开' : '关'}</strong>
      </div>
      <div className="telemetry-cell">
        <div className="rpm-ring">
          <strong>{car?.n_gear ?? '-'}</strong>
        </div>
        <span>{car?.rpm ? Math.round(car.rpm) : '--'} 转/分</span>
        <div className="pedals">
          <i className="throttle" style={{ width: `${car?.throttle ?? 0}%` }}></i>
          <i className="brake" style={{ width: `${car?.brake ?? 0}%` }}></i>
        </div>
      </div>
      <div className="speed-cell">
        <strong>{car?.speed ? Math.round(car.speed) : '--'}</strong>
        <span>公里/时</span>
      </div>
      <div className="lap-cell">
        <strong>{formatDelta(row.bestLap?.lap_duration)}</strong>
        <span>上一圈 {formatDelta(row.lastLap?.lap_duration)}</span>
      </div>
      <div className="gap-cell">
        <strong>{row.gap}</strong>
        <span>{row.interval}</span>
      </div>
      <div className="sector-strip">
        {(row.sectors.length ? row.sectors : Array.from({ length: 12 }, () => null)).map((sector, index) => (
          <i className={segmentClass(sector)} key={`${row.driver.driver_number}-${index}`}></i>
        ))}
      </div>
      <div className={`tyre tyre-${compoundShort(row.stint?.compound).toLowerCase()}`}>
        <strong>{compoundShort(row.stint?.compound)}</strong>
        <span>{row.stint ? Math.max(0, (row.lastLap?.lap_number ?? row.stint.lap_start) - row.stint.lap_start + row.stint.tyre_age_at_start) : '--'}</span>
      </div>
    </article>
  )
}

function TrackMap({ rows, track }: { rows: Row[]; track: TrackTelemetry }) {
  const livePoints = rows.filter((row) => row.location).map((row) => row.location as LocationData)
  const mapPoints = [...track.cloud, ...track.segments.flat(), ...livePoints]
  const xs = mapPoints.map((point) => point.x)
  const ys = mapPoints.map((point) => point.y)
  const minX = Math.min(...xs, -1000)
  const maxX = Math.max(...xs, 1000)
  const minY = Math.min(...ys, -1000)
  const maxY = Math.max(...ys, 1000)

  function project(location: LocationData) {
    const x = ((location.x - minX) / Math.max(1, maxX - minX)) * 86 + 7
    const y = ((location.y - minY) / Math.max(1, maxY - minY)) * 76 + 12
    return { x, y }
  }

  function pathData(segment: LocationData[]) {
    return segment
      .map((point, index) => {
        const pos = project(point)
        return `${index === 0 ? 'M' : 'L'}${pos.x.toFixed(2)} ${pos.y.toFixed(2)}`
      })
      .join(' ')
  }

  const sampleWindow = track.from && track.to ? `${formatTime(track.from)}-${formatTime(track.to)}` : '等待坐标'

  return (
    <section className="side-panel map-panel">
      <div className="panel-head compact">
        <span><MapIcon size={15} /> 完整赛道坐标</span>
        <small>{track.sourceCount || livePoints.length} 个原始点</small>
      </div>
      <svg viewBox="0 0 100 100" role="img" aria-label="赛道地图">
        <path className="map-grid" d="M8 18 H92 M8 38 H92 M8 58 H92 M8 78 H92 M20 8 V92 M40 8 V92 M60 8 V92 M80 8 V92" />
        {track.cloud.map((point, index) => {
          const pos = project(point)
          return <circle className="track-cloud" cx={pos.x} cy={pos.y} r="0.18" key={`${point.driver_number}-${point.date}-${index}`} />
        })}
        {track.segments.map((segment, index) => (
          <path className="track-ribbon" d={pathData(segment)} key={`segment-${index}`} />
        ))}
        {rows.filter((row) => row.location).map((row) => {
          const pos = project(row.location as LocationData)
          return (
            <g className="car-marker" key={row.driver.driver_number} transform={`translate(${pos.x} ${pos.y})`}>
              <circle r="2.7" fill={`#${row.driver.team_colour || 'e5e7eb'}`} />
              <text x="3.8" y="2.8">{row.driver.name_acronym}</text>
            </g>
          )
        })}
      </svg>
      <div className="map-stats">
        <span>采样窗 {sampleWindow}</span>
        <span>轨迹车号 {track.driverNumber ?? '--'}</span>
        <span>渲染点 {track.sampledCount || livePoints.length}</span>
      </div>
    </section>
  )
}

function WeatherPanel({ weather }: { weather?: Weather }) {
  return (
    <section className="side-panel weather-panel">
      <div className="panel-head compact">
        <span><CloudSun size={15} /> 天气</span>
        <small>{formatTime(weather?.date)}</small>
      </div>
      <div className="weather-grid">
        <Metric label="气温" value={weather ? `${weather.air_temperature.toFixed(1)}℃` : '--'} />
        <Metric label="赛道温度" value={weather ? `${weather.track_temperature.toFixed(1)}℃` : '--'} />
        <Metric label="湿度" value={weather ? `${weather.humidity.toFixed(0)}%` : '--'} />
        <Metric label="风速" value={weather ? `${weather.wind_speed.toFixed(1)} 米/秒` : '--'} />
      </div>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function RaceControlPanel({ messages }: { messages: RaceControl[] }) {
  return (
    <section className="side-panel race-control">
      <div className="panel-head compact">
        <span><Flag size={15} /> 赛会通知</span>
        <small>{messages.length}</small>
      </div>
      <div className="message-list">
        {messages.map((message) => (
          <article key={`${message.date}-${message.message}`}>
            <span>{formatTime(message.date)}</span>
            <strong>{flagLabel(message.flag ?? message.category)}</strong>
            <p>{message.message}</p>
          </article>
        ))}
      </div>
    </section>
  )
}

function TeamRadioPanel({ radios, rows }: { radios: TeamRadio[]; rows: Row[] }) {
  const nameByNumber = new Map(rows.map((row) => [row.driver.driver_number, row.driver.name_acronym]))
  return (
    <section className="side-panel team-radio">
      <div className="panel-head compact">
        <span><Mic2 size={15} /> 车队无线电</span>
        <small>{radios.length}</small>
      </div>
      <div className="radio-list">
        {radios.map((radio) => (
          <a href={radio.recording_url} target="_blank" rel="noreferrer" key={`${radio.date}-${radio.driver_number}`}>
            <Radio size={14} />
            <strong>{nameByNumber.get(radio.driver_number) ?? radio.driver_number}</strong>
            <span>{formatTime(radio.date)}</span>
          </a>
        ))}
      </div>
    </section>
  )
}

function LapChart({ rows }: { rows: Row[] }) {
  const visible = rows.slice(0, 10)
  const max = Math.max(...visible.map((row) => row.bestLap?.lap_duration ?? 0), 1)
  return (
    <section className="analysis-panel">
      <div className="panel-head compact">
        <span><BarChart3 size={15} /> 最快圈速</span>
        <small>前 10</small>
      </div>
      <div className="lap-bars">
        {visible.map((row) => {
          const value = row.bestLap?.lap_duration ?? 0
          return (
            <div key={row.driver.driver_number}>
              <span>{row.driver.name_acronym}</span>
              <i style={{ width: value ? `${Math.max(18, 100 - (value / max) * 72)}%` : '8%' }}></i>
              <strong>{formatDelta(value)}</strong>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function TyrePanel({ rows }: { rows: Row[] }) {
  return (
    <section className="analysis-panel">
      <div className="panel-head compact">
        <span><Settings2 size={15} /> 轮胎策略</span>
        <small>真实换胎段</small>
      </div>
      <div className="tyre-grid">
        {rows.slice(0, 12).map((row) => (
          <div key={row.driver.driver_number} style={{ '--team': `#${row.driver.team_colour || '6b7280'}` } as CSSProperties}>
            <strong>{row.driver.name_acronym}</strong>
            <span>{compoundLabel(row.stint?.compound)}</span>
            <small>起始胎龄 {row.stint?.tyre_age_at_start ?? '--'}</small>
          </div>
        ))}
      </div>
    </section>
  )
}

export default App
