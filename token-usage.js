/**
 * Host 侧的 Token 用量聚合。
 *
 * 数据来自 DSH 自己的会话日志：每次模型调用都会在 `assistant/message` 事件里
 * 记下 `data.usage`（inputTokens / cacheReadTokens / outputTokens / totalTokens）
 * 与 `data.message.source`（provider / model）。这里把这些事件汇总成
 * 「本日 / 本周 / 本月」三个周期，以及每个周期内各模型的用量。
 *
 * 关键点是去重：DSH 的「种子会话」（isSeeded）会把父会话的整段历史复制进子会话，
 * 父子两份日志里同一批事件各出现一次，直接相加会翻倍。日志里 `session/end-seed`
 * 事件标出了继承与自有的分界，据此可以只认领「自有事件」；但当父会话已被删除时，
 * 继承来的那段历史就没人认领了，这时必须由子会话代为计入，否则用量会凭空少一截。
 */

/** 三个统计周期的键，顺序即界面上的展示顺序。 */
export const TOKEN_PERIODS = ['day', 'week', 'month'];

/** 聚合结果的默认缓存时长：会话日志重放不便宜，短时间内重复请求直接复用缓存。 */
const DEFAULT_TTL_MS = 60_000;

/** 超过这个天数的会话不再读取，避免历史会话把每次刷新拖慢。 */
const MAX_SESSION_AGE_DAYS = 120;

/** 每个周期回溯的天数：本日=0、本周=6（周一到今天共 7 天）、本月=29。 */
const PERIOD_SPAN_DAYS = { day: 0, week: 6, month: 29 };

/**
 * 把毫秒时间戳换算成指定时区的日历日期。
 * @param {number} ms - 毫秒时间戳。
 * @param {string} timeZone - IANA 时区名，例如 Asia/Shanghai。
 * @returns {{ y: number, m: number, d: number }} - 该时区下的年月日。
 */
export function localDate(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)); // 取本地年月日各段
  const lookup = {}; // 段类型到取值的映射
  for (const part of parts) lookup[part.type] = part.value; // 逐段收集
  return { y: Number(lookup.year), m: Number(lookup.month), d: Number(lookup.day) }; // 返回年月日
}

/**
 * 把毫秒时间戳换算成指定时区的小时。
 * @param {number} ms - 毫秒时间戳。
 * @param {string} timeZone - IANA 时区名。
 * @returns {number} - 0 到 23 的小时数。
 */
export function localHour(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit' }).formatToParts(new Date(ms)); // 取本地小时
  const lookup = {}; // 段类型到取值的映射
  for (const part of parts) lookup[part.type] = part.value; // 逐段收集
  return Number(lookup.hour) % 24; // 返回小时数
}

/**
 * 求某个时区在给定瞬间相对 UTC 的偏移毫秒数。
 * @param {number} ms - 毫秒时间戳。
 * @param {string} timeZone - IANA 时区名。
 * @returns {number} - 偏移毫秒，东八区为 -8 小时。
 */
function zoneOffset(ms, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms)); // 取本地时间各段
  const lookup = {}; // 段类型到取值的映射
  for (const part of parts) lookup[part.type] = part.value; // 逐段收集
  const asUtc = Date.UTC(Number(lookup.year), Number(lookup.month) - 1, Number(lookup.day), Number(lookup.hour) % 24, Number(lookup.minute), Number(lookup.second)); // 把本地时间当作 UTC 拼出毫秒
  return asUtc - ms; // 与真实 UTC 的差值就是时区偏移
}

/**
 * 求指定时区里某个日历日期的零点时刻。
 * @param {{ y: number, m: number, d: number }} date - 日历日期。
 * @param {string} timeZone - IANA 时区名。
 * @returns {number} - 该日零点的毫秒时间戳。
 */
export function startOfLocalDate(date, timeZone) {
  const base = Date.UTC(date.y, date.m - 1, date.d); // 先把日历日期当成 UTC 零点，得到一个初值
  let guess = base; // 当前猜测的零点时刻
  for (let round = 0; round < 3; round += 1) { // 最多校正三轮，跨夏令时也能收敛
    const offset = zoneOffset(guess, timeZone); // 该猜测时刻下的时区偏移
    const next = base - offset; // 用偏移修正出新的零点
    if (next === guess) break; // 已经收敛，无需继续
    guess = next; // 继续用新猜测
  } // 结束校正
  return guess; // 返回本地零点
}

/**
 * 在日历日期上加减天数，避免夏令时导致固定 24 小时步长偏移。
 * @param {{ y: number, m: number, d: number }} date - 起始日期。
 * @param {number} days - 要加的天数，可为负。
 * @returns {{ y: number, m: number, d: number }} - 结果日期。
 */
export function addCalendarDays(date, days) {
  const shifted = new Date(Date.UTC(date.y, date.m - 1, date.d) + days * 86_400_000); // 按 UTC 做日历加减
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() }; // 转回年月日
}

/**
 * 计算三个周期的起点。
 * @param {number} now - 当前毫秒时间戳。
 * @param {string} timeZone - IANA 时区名。
 * @returns {Record<string, { start: number, startDate: { y: number, m: number, d: number } }>} - 各周期的起点。
 */
export function periodBounds(now, timeZone) {
  const today = localDate(now, timeZone); // 今天的日历日期
  const todayStart = startOfLocalDate(today, timeZone); // 今天零点的时刻
  // 星期几必须按「本地日历日期」算：本地零点的那个瞬间在东八区落在前一个 UTC 日，
  // 直接取 getUTCDay() 会把周一算成周日、周起点整整差一天。
  const weekday = new Date(Date.UTC(today.y, today.m - 1, today.d)).getUTCDay(); // 用日历日期本身求星期几
  const daysSinceMonday = (weekday + 6) % 7; // 距本周一过了几天
  const weekStartDate = addCalendarDays(today, -daysSinceMonday); // 本周一
  const monthStartDate = { y: today.y, m: today.m, d: 1 }; // 本月 1 号
  return { // 三个周期的起点
    day: { start: todayStart, startDate: today }, // 本日零点
    week: { start: startOfLocalDate(weekStartDate, timeZone), startDate: weekStartDate }, // 本周周一零点
    month: { start: startOfLocalDate(monthStartDate, timeZone), startDate: monthStartDate }, // 本月 1 号零点
  }; // 结束返回
}

/**
 * 造一个空的序列点位。
 * @param {string} key - 点的标识（小时序号或日期）。
 * @param {string} label - 界面上的标签。
 * @returns {object} - 空的点位。
 */
function emptyPoint(key, label) {
  return { key, label, input: 0, output: 0, cacheRead: 0, total: 0, calls: 0 }; // 各计数从零开始
}

/**
 * 造一个与所选周期匹配的时间序列：本日按小时，本周与本月按天。
 * 序列会补齐没有用量的时段，界面上才看得出空档。
 * @param {Array<object>} records - 扁平的用量记录。
 * @param {{ start: number, startDate: object }} bounds - 周期起点。
 * @param {{ period: string, timeZone: string, now: number }} options - 周期、时区与当前时刻。
 * @returns {{ unit: string, points: Array<object> }} - 序列单位与点位。
 */
function buildSeries(records, bounds, options) {
  const { period, timeZone, now } = options; // 解出周期、时区与当前时刻
  const points = []; // 序列点位
  const index = new Map(); // 点位键到点位对象的映射
  if (period === 'day') { // 本日按小时切：一天只有一根柱子看不出起伏
    for (let hour = 0; hour < 24; hour += 1) { // 铺满 24 个小时
      const point = emptyPoint(String(hour), `${hour}`); // 标签就是小时数
      points.push(point); // 依次加入
      index.set(point.key, point); // 登记索引
    } // 结束铺满
  } else { // 本周与本月按天切
    const today = localDate(now, timeZone); // 今天的日历日期
    let cursor = bounds.startDate; // 从周期起始日期开始
    for (let guard = 0; guard < 400; guard += 1) { // 最多铺 400 天，防御异常起点
      const key = `${cursor.y}-${String(cursor.m).padStart(2, '0')}-${String(cursor.d).padStart(2, '0')}`; // 日期键
      const point = emptyPoint(key, `${cursor.m}/${cursor.d}`); // 标签是月/日
      points.push(point); // 依次加入
      index.set(key, point); // 登记索引
      if (cursor.y === today.y && cursor.m === today.m && cursor.d === today.d) break; // 到今天为止
      cursor = addCalendarDays(cursor, 1); // 往后一天
    } // 结束铺日
  } // 结束切分方式
  for (const record of records) { // 逐条记录落到对应点位
    if (record.time < bounds.start) continue; // 周期起点之前的记录不计入
    const point = period === 'day' // 本日落到小时点位
      ? index.get(String(localHour(record.time, timeZone))) // 按小时找点位
      : index.get(`${localDate(record.time, timeZone).y}-${String(localDate(record.time, timeZone).m).padStart(2, '0')}-${String(localDate(record.time, timeZone).d).padStart(2, '0')}`); // 按日期找点位
    if (point === undefined) continue; // 找不到对应点位就跳过
    point.input += record.input; // 累加未缓存输入
    point.output += record.output; // 累加输出
    point.cacheRead += record.cacheRead; // 累加缓存读取
    point.total += record.total; // 累加总量
    point.calls += 1; // 累加调用次数
  } // 结束逐条落点
  return { unit: period === 'day' ? 'hour' : 'day', points }; // 返回序列
}

/**
 * 把若干条用量记录按模型与周期汇总。
 * @param {Array<object>} records - 扁平的用量记录。
 * @param {{ start: number, startDate: object }} bounds - 周期起点。
 * @param {{ period: string, timeZone: string, now: number }} options - 周期、时区与当前时刻。
 * @returns {object} - 该周期的汇总结果。
 */
function summarize(records, bounds, options) {
  const since = bounds.start; // 周期起点时刻
  const models = new Map(); // 模型键到计数的映射
  let input = 0; // 未缓存输入合计
  let output = 0; // 输出合计
  let cacheRead = 0; // 缓存读取合计
  let total = 0; // 总量合计
  let calls = 0; // 调用次数合计
  for (const record of records) { // 逐条记录累加
    if (record.time < since) continue; // 周期起点之前的记录不计入
    input += record.input; // 累加未缓存输入
    output += record.output; // 累加输出
    cacheRead += record.cacheRead; // 累加缓存读取
    total += record.total; // 累加总量
    calls += 1; // 累加调用次数
    const key = `${record.provider}::${record.model}`; // 模型键：提供方加模型名
    let bucket = models.get(key); // 该模型的累计桶
    if (bucket === undefined) { // 首次遇到这个模型
      bucket = { provider: record.provider, model: record.model, calls: 0, input: 0, output: 0, cacheRead: 0, total: 0 }; // 新建桶
      models.set(key, bucket); // 登记到映射里
    } // 结束首次判断
    bucket.calls += 1; // 累加该模型的调用次数
    bucket.input += record.input; // 累加该模型的未缓存输入
    bucket.output += record.output; // 累加该模型的输出
    bucket.cacheRead += record.cacheRead; // 累加该模型的缓存读取
    bucket.total += record.total; // 累加该模型的总量
  } // 结束逐条累加
  const modelList = [...models.values()].sort((a, b) => b.total - a.total); // 按总量降序
  for (const bucket of modelList) { // 补上占比
    bucket.share = total > 0 ? bucket.total / total : 0; // 该模型占本周期总量的比例
  } // 结束补占比
  const series = buildSeries(records, bounds, options); // 该周期自己的时间序列
  return { since, totals: { input, output, cacheRead, total, calls }, models: modelList, series }; // 返回该周期汇总
}

/**
 * 从一条会话日志里抽出带用量的模型调用。
 * @param {Array<object>} events - 会话事件列表。
 * @param {number} minSeq - 只认领 seq 大于该值的事件；传 -1 表示全认领。
 * @returns {Array<object>} - 抽出的用量记录。
 */
function extractUsage(events, minSeq) {
  const rows = []; // 抽出的用量记录
  for (const event of events) { // 逐个事件检查
    if (event === null || typeof event !== 'object') continue; // 跳过异常事件
    if (event.type !== 'assistant/message') continue; // 只有助手消息带用量
    const data = event.data; // 事件正文
    if (data === null || typeof data !== 'object') continue; // 跳过没有正文的
    const usage = data.usage; // 用量对象
    if (usage === null || typeof usage !== 'object') continue; // 没用量说明这步没真正调用模型
    const seq = typeof event.seq === 'number' ? event.seq : 0; // 事件序号
    if (seq <= minSeq) continue; // 超出认领范围
    const source = (data.message === null || typeof data.message !== 'object' ? {} : data.message.source) || {}; // 该步实际调用的供应商与模型
    rows.push({ // 记一条用量
      time: typeof event.time === 'number' ? event.time : 0, // 事件时间戳
      provider: typeof source.provider === 'string' ? source.provider : 'unknown', // 供应商标识
      model: typeof source.model === 'string' ? source.model : 'unknown', // 模型标识
      input: usage.inputTokens || 0, // 未命中缓存的输入 token
      output: usage.outputTokens || 0, // 输出 token
      cacheRead: usage.cacheReadTokens || 0, // 命中缓存读取的 token
      total: usage.totalTokens || 0, // 该次调用总量
    }); // 结束记录
  } // 结束逐事件检查
  return rows; // 返回用量记录
}

/**
 * 找到日志里继承与自有的分界序号。
 * @param {Array<object>} events - 会话事件列表。
 * @returns {number} - `session/end-seed` 事件的序号；没有则返回 -1 表示全部自有。
 */
function seedBoundary(events) {
  let boundary = -1; // 默认没有继承
  for (const event of events) { // 逐个事件检查
    if (event === null || typeof event !== 'object') continue; // 跳过异常事件
    if (event.type !== 'session/end-seed') continue; // 只认分界标记
    if (typeof event.seq === 'number' && event.seq > boundary) boundary = event.seq; // 取最大的一个作为分界
  } // 结束逐事件检查
  return boundary; // 返回分界序号
}

/**
 * 读取全部会话并汇总 Token 用量。
 * @param {object} sessionQuery - DSH 的会话查询服务。
 * @param {{ now?: number, timeZone?: string, ttlMs?: number, force?: boolean }} options - 可选项。
 * @returns {Promise<object>} - 聚合结果。
 */
export async function collectTokenUsage(sessionQuery, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now(); // 当前时刻
  const timeZone = typeof options.timeZone === 'string' && options.timeZone.length > 0 ? options.timeZone : 'Asia/Shanghai'; // 统计时区
  const ttlMs = typeof options.ttlMs === 'number' ? options.ttlMs : DEFAULT_TTL_MS; // 缓存时长
  const force = options.force === true; // 是否跳过缓存
  const state = collectTokenUsage.state; // 模块级缓存，跨请求复用
  if (!force && state.cache !== null && now - state.cachedAt < ttlMs) { // 命中新鲜缓存
    return state.cache; // 直接返回缓存结果
  } // 结束缓存判断
  const listed = await sessionQuery.listSessions(); // 列出全部逻辑会话，最新的在前
  const records = Array.isArray(listed) ? listed : []; // 归一成数组
  const listedIds = new Set(); // 已登记的会话 id 集合
  for (const record of records) { // 逐条登记
    const id = record?.header?.id; // 会话 id
    if (typeof id === 'string' && id.length > 0) listedIds.add(id); // 登记 id
  } // 结束登记
  const oldestAllowed = now - MAX_SESSION_AGE_DAYS * 86_400_000; // 允许读取的最老会话时间
  const rows = []; // 全部用量记录
  let scanned = 0; // 实际读取的会话数
  let skipped = 0; // 跳过的会话数
  let failed = 0; // 读取失败的会话数
  for (const record of records) { // 逐个会话处理
    const header = record?.header; // 会话头
    const id = header?.id; // 会话 id
    if (typeof id !== 'string' || id.length === 0) { // 没有可用 id
      skipped += 1; // 计入跳过
      continue; // 继续下一个
    } // 结束 id 检查
    const createdAt = typeof header.createdAt === 'number' ? header.createdAt : 0; // 创建时间
    if (createdAt > 0 && createdAt < oldestAllowed) { // 太老的会话不读
      skipped += 1; // 计入跳过
      continue; // 继续下一个
    } // 结束时效检查
    let events = null; // 读到的会话事件
    let inheritedCount = 0; // 会话声明的继承事件条数
    try { // 读取会话日志
      const snapshot = await sessionQuery.readSession(id); // 重放整份日志
      events = Array.isArray(snapshot?.events) ? snapshot.events : []; // 归一成事件数组
      inheritedCount = typeof snapshot?.inheritedEventCount === 'number' ? snapshot.inheritedEventCount : 0; // 继承条数
    } catch (error) { // 读取失败
      failed += 1; // 计入失败
      continue; // 继续下一个会话
    } // 结束读取
    scanned += 1; // 计入已扫描
    const boundary = seedBoundary(events); // 继承与自有的分界
    const parentId = typeof header.parentSession === 'string' ? header.parentSession : ''; // 父会话 id
    const parentPresent = parentId.length > 0 && listedIds.has(parentId); // 父会话是否还在
    const parentReadable = parentPresent && !state.unreadable.has(parentId); // 父会话是否读得动
    // 父会话还在就只认自有事件；父会话没了就由子会话把继承的一段也认领，否则这段用量会凭空消失。
    // 分界优先用日志里的 session/end-seed 标记；标记缺失时退回会话声明的继承条数。
    let minSeq = -1; // 默认整份日志都认领
    if (parentPresent && parentReadable) { // 只有父会话还在时才要剔除继承段
      minSeq = boundary >= 0 ? boundary : (inheritedCount > 0 ? inheritedCount - 1 : -1); // 取分界序号
    } // 结束剔除判断
    for (const row of extractUsage(events, minSeq)) rows.push(row); // 抽出并汇总用量
    if (parentPresent && !parentReadable) state.unreadable.add(id); // 记下这个会话自己也读不动，供后续判断
  } // 结束逐会话处理
  const bounds = periodBounds(now, timeZone); // 三个周期的起点
  const periods = {}; // 各周期汇总
  for (const period of TOKEN_PERIODS) periods[period] = summarize(rows, bounds[period], { period, timeZone, now }); // 逐周期汇总，各自带上匹配的时间序列
  const daily = new Map(); // 日期到当日合计的映射
  for (const row of rows) { // 逐条记录归到日期
    const day = localDate(row.time, timeZone); // 该条记录的本地日期
    const key = `${day.y}-${String(day.m).padStart(2, '0')}-${String(day.d).padStart(2, '0')}`; // 日期键
    let bucket = daily.get(key); // 当天的合计桶
    if (bucket === undefined) { // 首次见到这天
      bucket = { day: key, input: 0, output: 0, cacheRead: 0, total: 0, calls: 0 }; // 新建桶
      daily.set(key, bucket); // 登记
    } // 结束首次判断
    bucket.input += row.input; // 累加当天未缓存输入
    bucket.output += row.output; // 累加当天输出
    bucket.cacheRead += row.cacheRead; // 累加当天缓存读取
    bucket.total += row.total; // 累加当天总量
    bucket.calls += 1; // 累加当天调用次数
  } // 结束按日归并
  const dailyList = [...daily.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-30); // 按日期升序，只保留最近 30 天给界面画趋势
  const result = { // 组装返回结果
    fetchedAt: now, // 抓取时间
    timeZone, // 统计时区
    sessions: { listed: records.length, scanned, skipped, failed }, // 会话统计
    periods, // 三个周期的汇总
    daily: dailyList, // 近 N 天的每日趋势
    spanDays: PERIOD_SPAN_DAYS, // 周期跨度说明，供界面标注
  }; // 结束组装
  state.cache = result; // 写入缓存
  state.cachedAt = now; // 记录缓存时间
  state.unreadable = new Set(); // 重置读不动的会话集合
  return result; // 返回结果
}

/** 模块级缓存：跨请求复用聚合结果，避免每次都重放会话日志。 */
collectTokenUsage.state = { cache: null, cachedAt: 0, unreadable: new Set() };

/**
 * 清空聚合缓存，供调试或强制刷新使用。
 * @returns {void}
 */
export function resetTokenUsageCache() {
  collectTokenUsage.state.cache = null; // 丢掉缓存结果
  collectTokenUsage.state.cachedAt = 0; // 把缓存时间归零
}
