/**
 * OpenCode Go 额度「烧得太快 / 用得偏慢」的节奏分析。
 *
 * 额度端点只给三个窗口（5 小时滚动 / 每周 / 每月）的百分比和重置时间，所以这里把
 * 「本机 DSH 会话日志里的 token 用量」和「服务端的百分比读数」按时间对齐：
 * 用相邻两次读数之间的百分比差 ÷ 同一时间段内的 token 用量，估出这套额度大致按什么
 * 价格折算成百分比（tokenPerPoint），再顺着它推算：
 *
 * - 按现在的速度还能撑多久（etaMs），能不能撑到重置（onTrack）；
 * - 如果整段窗口都按当前速度烧，用完时大概还剩多少本来能用的额度（leftoverPercent）；
 * - 反过来，一直保持这个速度到重置只会用掉多少（projectedPercent），余量还能换成
 *   多少 token 用来干活（headroomTokens）。
 *
 * 只用「默认套餐」（Go / Go Plus / Go Teams 三档取第一个有额度的）作为参考额度，
 * 也就是剩余用量面板查询的口径；供应商/模型筛选是为了让推算只看同一片开销。
 */
import { collectUsageRows, localDate } from './token-usage.js'; // 复用会话日志重放与本地日期换算
import { DEFAULT_PLANS, readSnapshots, readUsage } from './monitor.js'; // 三档套餐、模型快照与额度缓存读取

/** 三个窗口的展示顺序与参数，与剩余用量面板保持一致。 */
export const ANALYSIS_WINDOWS = [
  { key: 'rolling', nominalMs: 5 * 3_600_000 }, // 5 小时滚动窗口按名义 5 小时算周期进度
  { key: 'weekly', nominalMs: 7 * 86_400_000 }, // 每周窗口名义 7 天
  { key: 'monthly', nominalMs: 30 * 86_400_000 }, // 每月窗口名义 30 天
]; // 结束窗口定义

const HOUR_MS = 3_600_000; // 一小时的毫秒数
const DAY_MS = 86_400_000; // 一天的毫秒数
const MIN_RATE_POINTS = 0.5; // 百分比差太小时估算误差会被放大，不据此更新换算价
const MAX_CALIBRATION_AGE_MS = 30 * DAY_MS; // 换算价最多沿用这么久，过期就只报原始数据
const PACE_OVER = 1.25; // 实际速度超过「刚好用完」的速度 25% 判为过快
const PACE_UNDER = 0.75; // 低于「刚好用完」的速度 25% 判为过少
const WEIGHTED_OVER = 1.25; // 跨窗口平均速度超速同样算「整窗偏快」
const WEIGHTED_UNDER = 0.75; // 跨窗口平均速度低于四分之三同样算「整窗偏少」
const STATE_PRIORITY = { lowtokens: 0, over: 1, under: 2, onTrack: 3, noQuota: 4, idle: 5, unknown: 6, empty: 7 }; // 多窗口汇总时的严重程度，数字越小越要紧

function clamp(value, min, max) { // 把数字夹到区间内
  return Math.min(max, Math.max(min, value)); // 先取下界再取上界
} // 结束夹取

function finiteOrNull(value) { // 只接受有限数字
  return typeof value === 'number' && Number.isFinite(value) ? value : null; // 其他一律当作没有
} // 结束数字校验

function pad2(value) { // 补足两位
  return String(value).padStart(2, '0'); // 返回补零后的文本
} // 结束补零

/**
 * 把毫秒换算成可读文案。
 * @param {number} ms - 时长毫秒。
 * @returns {string} - 例如「2 天 3 小时」。
 */
export function formatDuration(ms) { // 时长格式化
  const minutes = Math.max(0, Math.round(ms / 60_000)); // 统一到分钟
  if (minutes < 60) return `${minutes} 分钟`; // 不足一小时只报分钟
  const hours = Math.floor(minutes / 60); // 整小时数
  if (hours < 48) return `${hours} 小时${minutes % 60 > 0 ? ` ${minutes % 60} 分钟` : ''}`; // 两天内按小时报
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`; // 超过两天按天报
} // 结束时长格式化

/**
 * 把毫秒时间戳格式化成指定时区的「月-日 时:分」。
 * @param {number} ms - 毫秒时间戳。
 * @param {string} timeZone - IANA 时区名。
 * @returns {string} - 可读时间。
 */
export function formatClock(ms, timeZone) { // 时刻格式化
  try { // 依赖 Intl，失败时退回 ISO
    const parts = new Intl.DateTimeFormat('zh-CN', { timeZone, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms)); // 取月日时分各段
    const lookup = {}; // 段类型到取值的映射
    for (const part of parts) lookup[part.type] = part.value; // 逐段收集
    return `${lookup.month}-${lookup.day} ${lookup.hour}:${lookup.minute}`; // 拼成月-日 时:分
  } catch (error) { // 非法时区等异常
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' '); // 退回 UTC 文本
  } // 结束异常
} // 结束时刻格式化

function dayKey(ms, timeZone) { // 生成指定时区的日期键
  const date = localDate(ms, timeZone); // 换算本地年月日
  return `${date.y}-${pad2(date.m)}-${pad2(date.d)}`; // 拼成 YYYY-MM-DD
} // 结束日期键

/**
 * 读取最近一次成功检查里的模型目录。
 * @param {string|undefined} dir - 快照目录。
 * @returns {Promise<Array<{ id: string, name: string }>>} - 模型列表，读不到时为空。
 */
async function latestModels(dir) { // 读取最近的模型快照
  const snapshots = await readSnapshots(dir, 1).catch(() => []); // 快照读失败当作没有
  const models = snapshots[0]?.models; // 最近一份快照的模型
  return Array.isArray(models) ? models : []; // 只接受数组
} // 结束模型目录读取

/**
 * 取默认套餐的参考额度，用于把百分比折算成 token。
 * @param {Array} models - 最近快照里的模型。
 * @returns {number|null} - 第一个能读到的正额度。
 */
function planQuota(models) { // 取默认套餐的额度
  for (const model of models) { // 逐模型找第一个有额度的
    for (const plan of DEFAULT_PLANS) { // 依次尝试三档
      const value = model?.quotas?.[plan.key]; // 该档额度
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value; // 找到正数就用它
    } // 结束套餐循环
  } // 结束模型循环
  return null; // 没有额度数据
} // 结束额度读取

/**
 * 把显示名或 id 归一成同一个匹配键。
 * @param {string} value - 显示名或 id。
 * @returns {string} - 小写、只保留字母数字的键。
 */
function modelKey(value) { // 模型名归一
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ''); // 只保留字母数字
} // 结束归一

/**
 * 标出每个模型是否属于 opencode 这条线路。
 * @param {Array<object>} list - 供应商下的模型汇总。
 * @param {Array} models - 最近快照里的模型。
 * @returns {Array<object>} - 追加了 opencode 标记的模型汇总。
 */
export function classifyModels(list, models) { // 判定模型归属
  const catalog = new Set(); // 快照模型的键集合
  for (const model of models) { // 逐个登记
    if (typeof model?.id === 'string') catalog.add(modelKey(model.id)); // id 键
    if (typeof model?.name === 'string') catalog.add(modelKey(model.name)); // 显示名键
  } // 结束登记
  return list.map((item) => { // 逐项追加归属
    const provider = String(item.provider ?? '').toLowerCase(); // 供应商标识小写
    const providerIsOpencode = provider.includes('opencode'); // 供应商名里带 opencode 也算这条线路
    const inCatalog = catalog.has(modelKey(item.model)); // 该模型出现在 OpenCode Go 目录里
    return { ...item, opencode: providerIsOpencode || inCatalog }; // 两者之一成立即归为 opencode
  }); // 结束追加
} // 结束归属判定

/**
 * 把相邻两次读数按时间对齐成「百分比差 ↔ token 用量」样本。
 * @param {Array<{ at: number, windows: object }>} history - 时间升序的读数历史。
 * @param {Array<{ vendor?: string, time: number, total: number }>} rows - 筛选后的用量记录。
 * @param {string} vendor - 当前筛选的供应商。
 * @returns {{ samples: object, sinceLast: number, sinceCalls: number, lastAt: number|null }} - 每个窗口的样本与最后一次读数之后的用量。
 */
function buildSamples(history, rows, vendor) { // 相邻读数对齐
  const samples = { rolling: [], weekly: [], monthly: [] }; // 三个窗口的样本
  let lastAt = null; // 最后一次读数的时间
  for (let index = 1; index < history.length; index += 1) { // 逐对相邻读数
    const prev = history[index - 1]; // 较早的读数
    const next = history[index]; // 较新的读数
    if (typeof prev?.at !== 'number' || typeof next?.at !== 'number' || next.at <= prev.at) continue; // 时间异常就跳过
    const gapMs = next.at - prev.at; // 两次读数间隔
    let total = 0; // 区间内的 token 用量
    let calls = 0; // 区间内的调用次数
    for (const row of rows) { // 扫描用量记录
      if (row.vendor !== vendor) continue; // 只看当前供应商
      if (row.time < prev.at || row.time >= next.at) continue; // 只算落在区间里的
      total += row.total; // 累加 token
      calls += 1; // 累加调用次数
    } // 结束扫描
    for (const window of ANALYSIS_WINDOWS) { // 逐窗口造样本
      const before = prev.windows?.[window.key]; // 旧读数
      const after = next.windows?.[window.key]; // 新读数
      const beforePct = finiteOrNull(before?.percent); // 旧百分比
      const afterPct = finiteOrNull(after?.percent); // 新百分比
      if (beforePct === null || afterPct === null) continue; // 缺读数
      if ((before?.resetsAt ?? null) !== (after?.resetsAt ?? null)) continue; // 跨了重置，两段不能相减
      if (afterPct < beforePct) continue; // 百分比回落说明窗口重置过
      samples[window.key].push({ at: next.at, dp: afterPct - beforePct, total, calls, gapMs, resetsAt: after?.resetsAt ?? null }); // 存样本
    } // 结束窗口循环
  } // 结束相邻循环
  if (history.length > 0) lastAt = history[history.length - 1]?.at ?? null; // 最后一次读数的时间
  let sinceLast = 0; // 最后一次读数之后的用量
  let sinceCalls = 0; // 最后一次读数之后的调用次数
  for (const row of rows) { // 逐条扫用量
    if (row.vendor !== vendor) continue; // 只看当前供应商
    if (lastAt !== null && row.time < lastAt) continue; // 早于最后一次读数的部分已经算进样本
    sinceLast += row.total; // 累加 token
    sinceCalls += 1; // 累加调用次数
  } // 结束扫描
  return { samples, sinceLast, sinceCalls, lastAt }; // 返回样本与后续用量
} // 结束样本构建

/**
 * 按时间衰减加权汇总某个窗口的历史样本。
 * @param {Array<object>} list - 该窗口的样本。
 * @param {number} now - 当前时刻。
 * @returns {number|null} - 每 1% 额度折算的 token 数。
 */
function estimateWindowRate(list, now) { // 单窗口换算价
  let weighted = 0; // 加权 token
  let points = 0; // 加权百分比
  for (const item of list) { // 逐样本累加
    if (item.dp < MIN_RATE_POINTS) continue; // 百分比差太小，误差大
    const weight = Math.pow(0.5, Math.max(0, (now - item.at) / DAY_MS) / 7); // 半衰期一周
    weighted += item.total * weight; // 加权 token
    points += item.dp * weight; // 加权百分比
  } // 结束累加
  return points > 0 ? weighted / points : null; // 没有有效样本时返回空
} // 结束单窗口换算价

/**
 * 取当前速度：优先用「最后一次读数之后」的用量，没有就用最近一次百分比的折算值。
 * @param {object} prepared - buildSamples 的结果。
 * @param {Array<object>} rows - 筛选后的用量记录。
 * @param {number} now - 当前时刻。
 * @param {number|null} tokenPerPoint - 每 1% 额度折算的 token 数。
 * @param {number} activityWindowMs - 近窗时长。
 * @returns {{ recent: number|null, fallback: number|null, callsPerHour: number|null, basis: string }} - 速度信息。
 */
export function currentSpeed(prepared, rows, now, tokenPerPoint, activityWindowMs) { // 当前速度
  let recent = null; // 近窗速度（读数之后每小时的量）
  if (prepared.sinceLast > 0 && prepared.lastAt !== null) { // 读数之后有新用量
    const spanMs = Math.max(now - prepared.lastAt, 1); // 真实经过的时长
    recent = prepared.sinceLast / (spanMs / HOUR_MS); // 折算成每小时
  } // 结束近窗判断
  let fallback = null; // 折算速度（最近一次百分比变化）
  if (recent === null && tokenPerPoint !== null) { // 没有新用量时才退回折算
    for (const key of ['rolling', 'weekly', 'monthly']) { // 从细到粗找样本
      const last = prepared.samples[key].filter((item) => item.dp > 0).slice(-1)[0]; // 最近一次有变化的样本
      if (last === undefined) continue; // 没有就换下一个窗口
      fallback = last.dp / 100 * tokenPerPoint / (last.gapMs / HOUR_MS); // 按该样本折算成每小时
      break; // 找到即用
    } // 结束窗口查找
  } // 结束折算判断
  let windowTotal = 0; // 近窗 token
  let windowCalls = 0; // 近窗调用
  for (const row of rows) { // 统计近窗
    if (row.time < now - activityWindowMs) continue; // 只看近窗
    windowTotal += row.total; // 累加 token
    windowCalls += 1; // 累加调用
  } // 结束近窗统计
  const windowRate = windowCalls > 0 ? windowTotal / (activityWindowMs / HOUR_MS) : null; // 近窗折算成每小时
  const callsPerHour = prepared.sinceLast > 0 && prepared.lastAt !== null ? prepared.sinceCalls / Math.max((now - prepared.lastAt) / HOUR_MS, 1 / 60) : null; // 读数之后的调用速度
  return { recent, fallback, windowRate, callsPerHour, basis: recent !== null ? 'since-last' : fallback !== null ? 'last-delta' : 'activity' }; // 返回速度信息
} // 结束当前速度

/**
 * 预估某个窗口的额度能不能撑到重置。
 * @param {object} input - 窗口读数与推算参数。
 * @returns {object} - 预估结果。
 */
export function forecastWindow(input) { // 单窗口预估
  const { key, percent, shownPercent, resetsAt, now, tokenPerPoint, ratePerHour } = input; // 解出参数
  const nominalMs = ANALYSIS_WINDOWS.find((item) => item.key === key)?.nominalMs ?? null; // 该窗口名义周期
  const used = finiteOrNull(percent); // 服务端原始已用百分比
  const shown = finiteOrNull(shownPercent); // 界面展示的百分比（与服务端同口径）
  const percentLeft = used === null ? null : Math.max(0, 100 - used); // 剩余百分比
  const resetsMs = typeof resetsAt === 'string' ? Date.parse(resetsAt) : Number.NaN; // 重置时刻
  const resetOk = Number.isFinite(resetsMs); // 重置时间是否可用
  const periodStart = resetOk && nominalMs !== null ? resetsMs - nominalMs : null; // 估算的周期起点
  const timeLeftMs = resetOk ? Math.max(0, resetsMs - now) : null; // 距重置还剩多久
  const elapsedMs = periodStart === null ? null : clamp(now - periodStart, 0, nominalMs); // 周期内已经过了多久
  const elapsedFraction = elapsedMs !== null && nominalMs ? elapsedMs / nominalMs : null; // 周期进度
  const timeLeftFraction = elapsedFraction === null ? null : 1 - elapsedFraction; // 剩余周期比例
  const base = { key, percent: used, shownPercent: shown, resetsAt: resetsAt ?? null, resetOk, periodStart, timeLeftMs, elapsedMs, elapsedFraction, timeLeftFraction }; // 共用字段
  if (used === null) return { ...base, state: 'noQuota', message: '服务端没有返回这个窗口的读数。' }; // 缺读数
  if (percentLeft <= 0) return { ...base, state: 'empty', message: '额度已经用完，等重置后才能继续。' }; // 已经耗尽
  const meas = tokenPerPoint !== null && ratePerHour !== null && ratePerHour > 0; // 能否推算
  let state = 'idle'; // 默认没有新进展
  let message = '两次读数之间还没有新的 Token 消耗，先按保持现状处理。'; // 默认提示
  let etaMs = null; // 按当前速度撑多久
  let availablePercentPerHour = null; // 撑到重置刚好用完的每小时百分比
  let leftoverPercent = null; // 提前用完时会浪费掉的额度
  let actualPercentPerHour = null; // 周期内平均每小时用了多少百分点
  let currentPercentPerHour = null; // 当前速度折算成每小时的百分比
  if (meas && timeLeftMs !== null && elapsedMs !== null && elapsedMs > 0 && timeLeftMs > 0) { // 有足够信息才算速度
    actualPercentPerHour = used / (elapsedMs / HOUR_MS); // 周期内平均每小时消耗
    availablePercentPerHour = percentLeft / (timeLeftMs / HOUR_MS); // 剩余百分比摊到剩余时间
    currentPercentPerHour = ratePerHour / tokenPerPoint; // 当前速度先折算成每小时消耗的百分比
    etaMs = currentPercentPerHour > 0 ? percentLeft / currentPercentPerHour * HOUR_MS : Number.POSITIVE_INFINITY; // 按当前速度还能撑多久
    const pace = availablePercentPerHour > 0 ? currentPercentPerHour / availablePercentPerHour : Number.POSITIVE_INFINITY; // 当前速度相对「刚好用完」的速度
    const weight = clamp(timeLeftMs / nominalMs, 0.1, 1); // 离重置越远越代表整窗平均
    const weighted = currentPercentPerHour * weight + actualPercentPerHour * (1 - weight); // 跨窗口的平均速度
    const weightedPace = availablePercentPerHour > 0 ? weighted / availablePercentPerHour : Number.POSITIVE_INFINITY; // 加权后的倍数
    if (etaMs < timeLeftMs && pace >= PACE_OVER) { // 撑不到重置
      state = 'over'; // 判定过快
      leftoverPercent = Math.max(0, percentLeft - percentLeft * (timeLeftMs / etaMs)); // 提前用完时会浪费掉的额度
      message = '按当前速度会在重置前用完，剩下的额度会浪费掉。'; // 说明浪费
    } else if (pace < PACE_UNDER) { // 远低于可用速度
      state = 'under'; // 判定过少
      const projectedUnder = used + currentPercentPerHour * (timeLeftMs / HOUR_MS); // 一直按当前速度到重置会用掉
      message = `照当前速度到重置只会用掉约 ${Math.round(clamp(projectedUnder, 0, 1000))}%，剩下的额度会作废。`; // 说明浪费
    } else if (weightedPace >= WEIGHTED_OVER) { // 整窗节奏偏快
      state = 'over'; // 整窗偏快
      message = '整窗节奏偏快，照这个速度会在重置前用完；当前瞬时速度还撑得住，注意别加大。'; // 提醒
    } else if (weightedPace <= WEIGHTED_UNDER) { // 整窗节奏偏少
      state = 'under'; // 整窗偏少
      const projectedFew = used + actualPercentPerHour * (timeLeftMs / HOUR_MS); // 整窗平均下的预计用量
      message = `整窗节奏偏少，到重置大概只用掉 ${Math.round(clamp(projectedFew, 0, 1000))}%，可以适当多用一些。`; // 提醒
    } else { // 节奏正常
      state = 'onTrack'; // 与用时基本同步
      message = '节奏正常，速度和剩余时间基本对得上。'; // 正常提示
    } // 结束判断
  } else if (meas && timeLeftMs === 0) { // 已经到重置点
    message = '窗口马上重置，当前读数随时会清零。'; // 提示刷新
  } // 结束时间判断
  const projectedPercent = meas && elapsedMs !== null && elapsedMs > 0 && timeLeftMs !== null ? used + currentPercentPerHour * (timeLeftMs / HOUR_MS) : null; // 一直按当前速度到重置会用掉多少
  const headroomTokens = tokenPerPoint === null ? null : percentLeft / 100 * tokenPerPoint; // 剩下的额度折算成 token
  return { ...base, state, message, etaMs, availablePercentPerHour, actualPercentPerHour, currentPercentPerHour: meas ? currentPercentPerHour : null, projectedPercent: projectedPercent === null ? null : clamp(projectedPercent, 0, 1000), headroomTokens, leftoverPercent }; // 返回完整预估
} // 结束单窗口预估

/**
 * 做一次完整的节奏分析。
 * @param {object} sessionQuery - DSH 的会话查询服务。
 * @param {{ dir?: string, timeZone?: string, vendor?: string, model?: string, force?: boolean, now?: number }} options - 可选项。
 * @returns {Promise<object>} - 分析结果。
 */
export async function analyzeQuota(sessionQuery, options = {}) { // 分析入口
  const now = typeof options.now === 'number' ? options.now : Date.now(); // 当前时刻
  const timeZone = typeof options.timeZone === 'string' && options.timeZone.length > 0 ? options.timeZone : 'Asia/Shanghai'; // 统计时区
  const dir = typeof options.dir === 'string' && options.dir.length > 0 ? options.dir : undefined; // 快照目录，缺省用 monitor 的默认目录
  const vendor = typeof options.vendor === 'string' ? options.vendor.trim() : ''; // 供应商筛选
  const model = typeof options.model === 'string' ? options.model.trim() : ''; // 模型筛选
  const store = await readUsage(dir); // 读取额度缓存（含读数历史）
  const history = Array.isArray(store?.history) ? store.history : []; // 历史读数，时间升序
  const current = store?.windows ? { windows: store.windows, fetchedAt: store.fetchedAt ?? null, source: store.source ?? null } : null; // 当前读数
  const models = await latestModels(dir); // 最近快照里的模型
  const quota = planQuota(models); // 默认套餐的参考额度
  const scan = await collectUsageRows(sessionQuery, { now, force: options.force === true, cacheKey: `${timeZone}|${dayKey(now, timeZone)}` }); // 复用会话日志重放
  const rows = scan.rows.map((item) => ({ vendor: item.provider, model: item.model, time: item.time, total: item.total })); // 只保留分析需要的字段
  const vendors = new Map(); // 供应商汇总
  for (const row of rows) { // 逐条累计
    const bucket = vendors.get(row.vendor) ?? { id: row.vendor, total: 0, calls: 0, lastAt: 0 }; // 取桶
    bucket.total += row.total; // 累加 token
    bucket.calls += 1; // 累加调用
    bucket.lastAt = Math.max(bucket.lastAt, row.time); // 记录最近时间
    vendors.set(row.vendor, bucket); // 写回
  } // 结束累计
  const vendorList = [...vendors.values()].sort((a, b) => b.total - a.total); // 按用量降序
  const activeVendor = vendor.length > 0 && vendors.has(vendor) ? vendor : vendorList[0]?.id ?? ''; // 没指定或不存在时退回用量最大的供应商
  const modelTotals = new Map(); // 选中供应商下的模型汇总
  for (const row of rows) { // 只统计选中供应商
    if (row.vendor !== activeVendor) continue; // 跳过其他供应商
    const bucket = modelTotals.get(row.model) ?? { model: row.model, total: 0, calls: 0 }; // 取桶
    bucket.total += row.total; // 累加 token
    bucket.calls += 1; // 累加调用
    modelTotals.set(row.model, bucket); // 写回
  } // 结束汇总
  const modelList = classifyModels([...modelTotals.values()].sort((a, b) => b.total - a.total).map((item) => ({ provider: activeVendor, ...item })), models); // 标出哪些模型属于 opencode 线路
  const activeModel = modelList.some((item) => item.model === model) ? model : ''; // 校验模型筛选是否有效
  let filterNote = ''; // 口径说明键
  let activityWindowMs = 2 * HOUR_MS; // 近窗默认两小时
  if (activeModel.length > 0) { // 指定了模型
    const chosen = modelList.find((item) => item.model === activeModel); // 找到该模型
    filterNote = chosen?.opencode === true ? 'model' : 'provider'; // opencode 模型单独看，其他模型只代表整条线路
    activityWindowMs = chosen?.opencode === true ? 15 * 60_000 : 2 * HOUR_MS; // 单模型看近 15 分钟
  } // 结束模型判断
  const filtered = rows.filter((row) => row.vendor === activeVendor && (activeModel.length === 0 || row.model === activeModel)); // 参与分析的记录
  const prepared = buildSamples(history, filtered, activeVendor); // 相邻读数对齐
  let tokenPerPoint = null; // 最终采用的换算价
  let basisKey = null; // 换算价来自哪个窗口
  const samples = {}; // 各窗口样本数
  for (const window of ANALYSIS_WINDOWS) { // 逐窗口估算
    const rate = estimateWindowRate(prepared.samples[window.key], now); // 该窗口的历史换算价
    samples[window.key] = prepared.samples[window.key].length; // 记录样本数
    if (tokenPerPoint === null && rate !== null) { tokenPerPoint = rate; basisKey = window.key; } // 优先用更细的窗口
  } // 结束窗口估算
  const lastSampleAt = Math.max(0, history[history.length - 1]?.at ?? 0); // 最近一次读数的时间
  const readingAt = current?.fetchedAt ? Date.parse(current.fetchedAt) : Number.NaN; // 当前读数的抓取时间
  const calibrationFresh = tokenPerPoint !== null && Number.isFinite(readingAt) && (now - readingAt) <= MAX_CALIBRATION_AGE_MS; // 换算价是否还新鲜
  const usableRate = calibrationFresh ? tokenPerPoint : null; // 过期就不参与换算
  const speed = currentSpeed(prepared, filtered, now, usableRate, activityWindowMs); // 当前速度
  const ratePerHour = usableRate === null ? null : speed.recent ?? speed.fallback; // 每小时 token（优先读数之后的实测）
  const windows = ANALYSIS_WINDOWS.map((window) => { // 逐窗口预估
    const source = current?.windows?.[window.key]; // 服务端读数
    if (source === null || source === undefined) return { key: window.key, state: 'noQuota', message: '还没有这个窗口的额度读数。' }; // 缺读数
    const forecast = forecastWindow({ key: window.key, percent: source.percent, shownPercent: typeof source.remaining === 'number' ? 100 - source.remaining : source.percent, resetsAt: source.resetsAt ?? null, now, tokenPerPoint: usableRate, ratePerHour }); // 预估
    const last = prepared.samples[window.key].slice(-1)[0]; // 该窗口最近一次样本
    return { ...forecast, deltaPts: last?.dp ?? null, deltaTokens: last?.total ?? null, deltaAt: last?.at ?? null }; // 附上最近一次变化
  }); // 结束窗口预估
  const ranked = [...windows].filter((item) => item.state !== 'noQuota').sort((a, b) => (STATE_PRIORITY[a.state] ?? 9) - (STATE_PRIORITY[b.state] ?? 9)); // 按严重程度排序
  const overview = ranked[0] ?? { state: 'noQuota', message: '还没有额度读数，先去「剩余用量」刷新一次。', key: null }; // 最要紧的窗口
  return { // 组装结果
    fetchedAt: now, // 分析时间
    timeZone, // 统计时区
    reading: current === null ? null : { fetchedAt: current.fetchedAt, source: current.source }, // 读数来源与时间
    readingAgeMs: Number.isFinite(readingAt) ? Math.max(0, now - readingAt) : null, // 读数有多旧
    vendor: activeVendor, // 实际使用的供应商
    model: activeModel, // 实际使用的模型（空表示整个供应商）
    filterNote, // 口径说明键
    vendors: vendorList.map((item) => ({ id: item.id, total: item.total, calls: item.calls, lastAt: item.lastAt })), // 供应商列表
    models: modelList, // 模型列表与归属
    tokenPerPoint: usableRate, // 每 1% 额度折算的 token 数
    quota, // 默认套餐的参考额度
    calibration: { tokenPerPoint, window: basisKey, lastSampleAt: lastSampleAt > 0 ? lastSampleAt : null, fresh: calibrationFresh, samples }, // 校准明细
    speed: { perHour: ratePerHour, instantPerHour: speed.windowRate, recentPerHour: speed.recent, callsPerHour: speed.callsPerHour, basis: speed.basis, sinceLastMs: prepared.lastAt === null ? null : Math.max(0, now - prepared.lastAt), callsSinceLast: prepared.sinceCalls, activityMinutes: Math.round(activityWindowMs / 60_000) }, // 速度明细
    windows, // 三个窗口的预估
    overview: { state: overview.state, message: overview.message, key: overview.key ?? null, etaMs: overview.etaMs ?? null, leftoverPercent: overview.leftoverPercent ?? null, projectedPercent: overview.projectedPercent ?? null, timeLeftMs: overview.timeLeftMs ?? null }, // 顶部结论
    sessions: scan.sessions, // 会话读取统计
  }; // 结束组装
} // 结束分析入口
