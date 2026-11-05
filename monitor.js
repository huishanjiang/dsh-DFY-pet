import { promises as fs } from 'node:fs'; // 文件系统操作
import path from 'node:path'; // 路径拼接
import os from 'node:os'; // 用户主目录

export const MODELS_URL = 'https://opencode.ai/zen/go/v1/models'; // OpenCode Go 实时模型端点
export const DOCS_URL = 'https://opencode.ai/docs/go/'; // 定价与月度配额文档
export const SNAPSHOT_VERSION = 1; // 快照格式版本
export const MAX_SNAPSHOTS = 50; // 本地最多保留的检查次数
export const KEY_REF = 'OPENCODE_GO_API_KEY'; // 凭据引用名
export const DEFAULT_PLANS = [ // 文档中的三档套餐
  { key: 'go', label: 'Go' }, // 基础套餐
  { key: 'goPlus', label: 'Go Plus' }, // 更高额度套餐
  { key: 'goTeams', label: 'Go Teams' }, // 团队套餐
]; // 结束套餐定义

export function snapshotDir() { // 返回快照目录
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 // 优先使用 DSH_HOME
    ? process.env.DSH_HOME.trim() // 使用配置的主目录
    : path.join(os.homedir(), '.dsh'); // 回退到 ~/.dsh
  return path.join(home, 'opencode-go-models-snapshots'); // 需求指定的目录名
} // 结束目录解析

function combineSignals(signals) { // 合并多个 AbortSignal
  const valid = signals.filter(Boolean); // 去掉空信号
  if (valid.length === 0) return undefined; // 没有信号
  if (valid.length === 1) return valid[0]; // 单个信号直接返回
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid); // 原生合并
  const controller = new AbortController(); // 兜底控制器
  const abort = () => controller.abort(); // 中止函数
  for (const signal of valid) { // 遍历信号
    if (signal.aborted) { abort(); break; } // 已中止则立即中止
    signal.addEventListener('abort', abort, { once: true }); // 监听中止
  } // 结束遍历
  return controller.signal; // 返回合并信号
} // 结束信号合并

export async function fetchWithRetry(url, options = {}, policy = {}) { // 带超时与重试的 fetch
  const timeoutMs = policy.timeoutMs ?? 15000; // 单次超时
  const retries = policy.retries ?? 2; // 可重试次数
  let lastError; // 最后一次错误
  for (let attempt = 0; attempt <= retries; attempt += 1) { // 逐次尝试
    const controller = new AbortController(); // 超时控制器
    const timer = setTimeout(() => controller.abort(), timeoutMs); // 到点中止
    const signal = combineSignals([options.signal, controller.signal]); // 合并调用方信号
    try { // 发起请求
      const response = await fetch(url, { ...options, signal }); // 执行请求
      if (response.status >= 500 || response.status === 429) { // 可重试状态
        lastError = new Error(`HTTP ${response.status}`); // 记录错误
        await response.body?.cancel(); // 释放响应体
      } else { // 非可重试状态
        return response; // 直接返回响应
      } // 结束状态判断
    } catch (error) { // 网络或超时错误
      lastError = error; // 记录错误
    } finally { // 清理定时器
      clearTimeout(timer); // 清除超时
    } // 结束清理
    if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1))); // 退避后重试
  } // 结束重试循环
  throw lastError ?? new Error('请求失败'); // 抛出最后一次错误
} // 结束 fetchWithRetry

function numberOrNull(value) { // 只接受有限数字
  return typeof value === 'number' && Number.isFinite(value) ? value : null; // 非数字返回 null
} // 结束数字校验

export function stableStringify(value) { // 稳定序列化，避免键顺序造成假变动
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`; // 数组递归
  if (value !== null && typeof value === 'object') { // 对象按 key 排序
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`; // 返回排序后的对象
  } // 结束对象分支
  return JSON.stringify(value); // 基本类型直接序列化
} // 结束稳定序列化

export function normalizeModelName(value) { // 生成用于匹配的名称键
  return String(value ?? '') // 统一成字符串
    .toLowerCase() // 忽略大小写
    .replace(/\([^)]*\)/g, ' ') // 去掉括号里的档位与折扣说明
    .replace(/&/g, ' and ') // 处理 & 符号
    .replace(/[^a-z0-9]+/g, ' ') // 非字母数字转空格
    .replace(/\s+/g, ' ') // 合并空格
    .trim(); // 去掉首尾空格
} // 结束名称归一化

function normalizeApiModel(item) { // 把 API 条目转成内部模型
  const id = typeof item?.id === 'string' ? item.id.trim() : ''; // 读取模型 id
  const name = typeof item?.name === 'string' && item.name.trim().length > 0 ? item.name.trim() : id; // 读取显示名
  const cost = item?.cost?.text; // 读取文本计费
  const input = numberOrNull(cost?.input?.price); // 输入单价
  const output = numberOrNull(cost?.output?.price); // 输出单价
  const cacheRead = numberOrNull(cost?.input?.cache?.read); // 缓存读单价
  const cacheWrite = numberOrNull(cost?.input?.cache?.write); // 缓存写单价
  const context = numberOrNull(item?.limit?.context); // 上下文窗口
  const maxOutput = numberOrNull(item?.limit?.output); // 最大输出
  return { id, name, input, output, cacheRead, cacheWrite, context, maxOutput, costDigest: stableStringify(item?.cost ?? null), pricingSource: input !== null || output !== null ? 'api' : null }; // 返回内部记录
} // 结束 API 模型转换

export async function fetchModels(apiKey, signal) { // 读取实时模型列表
  const headers = { 'user-agent': 'deepseek-harness-opencode-go-monitor/1.0', accept: 'application/json' }; // 标识本客户端
  if (typeof apiKey === 'string' && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`; // 有 Key 时携带
  const response = await fetchWithRetry(MODELS_URL, { headers, signal }, { timeoutMs: 15000, retries: 2 }); // 请求模型端点
  if (response.status === 401 || response.status === 403) throw new Error(`认证失败（HTTP ${response.status}），请检查 OpenCode API Key`); // 认证提示
  if (!response.ok) throw new Error(`模型端点返回 HTTP ${response.status}`); // 其他状态错误
  const payload = await response.json(); // 解析 JSON
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []; // 兼容多种形状
  if (list.length === 0) throw new Error('模型端点没有返回任何模型'); // 空列表视为失败
  return list.map(normalizeApiModel).filter((model) => model.id.length > 0); // 规范化后返回
} // 结束模型抓取

function stripHtml(html) { // 把表格单元格转成纯文本
  return String(html ?? '') // 统一成字符串
    .replace(/<[^>]*>/g, ' ') // 去掉标签
    .replace(/&nbsp;/gi, ' ') // 不换行空格
    .replace(/&amp;/gi, '&') // 转义 &
    .replace(/&lt;/gi, '<') // 转义 <
    .replace(/&gt;/gi, '>') // 转义 >
    .replace(/&quot;/gi, '"') // 转义双引号
    .replace(/&#0*39;|&#x0*27;/gi, "'") // 转义单引号
    .replace(/&mdash;/gi, '—') // 破折号
    .replace(/\s+/g, ' ') // 合并空白
    .trim(); // 去掉首尾空格
} // 结束文本清洗

export function parseMoney(text) { // 解析价格或配额
  const normalized = String(text ?? '').trim(); // 统一成字符串
  if (normalized.length === 0 || normalized === '-') return null; // 空值与占位
  if (/^free$/i.test(normalized)) return 0; // Free 记为 0
  if (/unlimited/i.test(normalized)) return 'unlimited'; // 无限配额
  const matches = [...normalized.matchAll(/\$([0-9]+(?:\.[0-9]+)?)/g)]; // 找出所有美元金额
  if (matches.length === 0) return null; // 没有金额
  return Number(matches[matches.length - 1][1]); // 取最后一个金额（折扣后的现价）
} // 结束金额解析

function parseRequests(value) { // 解析 5h 请求估算
  const normalized = String(value ?? '').replace(/,/g, '').trim(); // 去逗号与空白
  if (/unlimited|∞/i.test(normalized)) return 'unlimited'; // 不限量
  if (normalized.length === 0 || /^(?:-|—|n\/a)$/i.test(normalized)) return null; // 空值
  const number = Number(normalized.replace(/[^0-9.]/g, '')); // 提取数字
  return Number.isFinite(number) ? number : null; // 返回数值
} // 结束请求解析

export function parsePricingTables(html) { // 解析文档页的配额与 5h 请求估算
  const tables = [...String(html ?? '').matchAll(/<table[\s\S]*?<\/table>/gi)].map((match) => match[0]); // 拆出所有表格
  const quotaByPlan = []; // 各套餐配额行
  const requestByPlan = []; // 各套餐 5h 请求行
  const warnings = []; // 解析提示
  let quotaTables = 0; // 配额表数量
  let requestTables = 0; // 请求表数量
  const cellsOf = (row) => [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((match) => stripHtml(match[1])); // 拆出单元格
  for (const table of tables) { // 逐个表格
    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((match) => match[0]); // 拆出行
    if (rows.length < 2) continue; // 跳过空表
    const header = cellsOf(rows[0]); // 表头
    const isQuota = header.some((cell) => /^monthly limit$/i.test(cell)); // 配额表
    const isRequests = header.some((cell) => /requests per 5 hours/i.test(cell)); // 5h 请求表
    if (!isQuota && !isRequests) continue; // 只看目标表
    const index = isQuota ? quotaTables : requestTables; // 当前套餐序号
    const plan = DEFAULT_PLANS[index] ?? { key: `plan${index}`, label: `Plan ${index + 1}` }; // 按顺序识别套餐
    const byName = new Map(); // 名称到行
    for (const row of rows.slice(1)) { // 逐行解析
      const cells = cellsOf(row); // 单元格
      if (isQuota) { // 配额行
        if (cells.length < 6) continue; // 列数不足
        const name = cells[0]; // 模型名
        if (name.length === 0) continue; // 跳过空名
        const record = { // 文档配额行
          name, // 原始名称
          input: parseMoney(cells[1]), // 输入价
          output: parseMoney(cells[2]), // 输出价
          cacheRead: parseMoney(cells[3]), // 缓存读
          cacheWrite: parseMoney(cells[4]), // 缓存写
          monthlyLimit: parseMoney(cells[cells.length - 1]), // 月度配额
        }; // 结束配额行
        const key = normalizeModelName(name); // 归一化名称
        const previous = byName.get(key); // 已有同模型行
        if (previous === undefined) byName.set(key, record); // 首次出现
        else if (previous.monthlyLimit === null && record.monthlyLimit !== null) byName.set(key, record); // 用有配额的行覆盖
      } else { // 请求行
        if (cells.length < 2) continue; // 列数不足
        const name = cells[0]; // 模型名
        if (name.length === 0) continue; // 跳过空名
        const record = { name, fiveHour: parseRequests(cells[1]) }; // 只取 5h 列
        const key = normalizeModelName(name); // 归一化名称
        const previous = byName.get(key); // 已有同模型行
        if (previous === undefined) byName.set(key, record); // 首次出现
        else if (previous.fiveHour === null && record.fiveHour !== null) byName.set(key, record); // 用有数值的行覆盖
      } // 结束行类型
    } // 结束行循环
    if (isQuota) { quotaByPlan[index] = [...byName.values()]; quotaTables += 1; } // 保存配额表
    else { requestByPlan[index] = [...byName.values()]; requestTables += 1; } // 保存请求表
  } // 结束表格循环
  const plans = DEFAULT_PLANS.map((plan, index) => ({ key: plan.key, label: plan.label, rows: quotaByPlan[index] ?? [], requests: requestByPlan[index] ?? [] })); // 统一三档套餐
  if (quotaTables === 0) warnings.push('定价文档中没有找到配额表，配额将沿用上次快照或为空'); // 结构变化提示
  if (requestTables === 0) warnings.push('定价文档中没有找到 5h 请求估算表，5h 请求将沿用上次快照或为空'); // 请求表提示
  return { plans, warnings }; // 返回解析结果
} // 结束文档解析

export async function fetchPricingDocs(signal) { // 抓取并解析定价文档
  const response = await fetchWithRetry(DOCS_URL, { headers: { 'user-agent': 'deepseek-harness-opencode-go-monitor/1.0', accept: 'text/html' }, signal }, { timeoutMs: 20000, retries: 1 }); // 请求文档
  if (!response.ok) throw new Error(`定价文档返回 HTTP ${response.status}`); // 状态错误
  const html = await response.text(); // 读取 HTML
  return { ...parsePricingTables(html), url: response.url || DOCS_URL }; // 返回解析结果与最终地址
} // 结束文档抓取

export function mergeModelData(apiModels, docs, previousModels = []) { // 合并 API 与文档数据
  const docPlans = docs?.plans ?? []; // 文档套餐
  const plansForMerge = docPlans.length > 0 ? docPlans : DEFAULT_PLANS.map((plan) => ({ ...plan, rows: [], requests: [] })); // 文档失败时仍保留三档
  const docRows = new Map(); // 归一化名称到文档行
  for (const plan of docPlans) { // 遍历文档套餐
    for (const row of plan.rows) { // 遍历行
      const key = normalizeModelName(row.name); // 归一化
      const existing = docRows.get(key); // 现有行
      if (existing === undefined) docRows.set(key, row); // 首次
      else if (existing.monthlyLimit === null && row.monthlyLimit !== null) docRows.set(key, row); // 补配额
    } // 结束行遍历
  } // 结束套餐遍历
  const previousById = new Map(previousModels.map((model) => [model.id, model])); // 上次快照
  return apiModels.map((model) => { // 逐模型合并
    const normalizedName = normalizeModelName(model.name); // 名称键
    const normalizedId = normalizeModelName(model.id); // id 键
    const row = docRows.get(normalizedName) ?? docRows.get(normalizedId); // 文档行
    const previous = previousById.get(model.id); // 上次记录
    const quotas = {}; // 三档配额
    const requests5h = {}; // 三档 5h 请求
    let matchedDocs = false; // 是否命中文档
    let matchedRequests = false; // 是否命中请求表
    for (const plan of plansForMerge) { // 每个套餐
      const targetName = normalizeModelName(row?.name ?? model.name); // 文档中的目标名称
      const planRow = plan.rows.find((candidate) => normalizeModelName(candidate.name) === targetName); // 套餐内匹配
      if (planRow?.monthlyLimit !== undefined) matchedDocs = true; // 命中文档
      quotas[plan.key] = planRow?.monthlyLimit ?? previous?.quotas?.[plan.key] ?? null; // 文档优先，其次上次
      const requestRow = (plan.requests ?? []).find((candidate) => { const key = normalizeModelName(candidate.name); return key === normalizedName || key === normalizedId; }); // 套餐内请求匹配
      if (requestRow?.fiveHour !== undefined && requestRow.fiveHour !== null) matchedRequests = true; // 命中请求表
      requests5h[plan.key] = requestRow?.fiveHour ?? previous?.requests5h?.[plan.key] ?? null; // 请求优先，其次上次
    } // 结束套餐循环
    return { // 合并后的模型
      ...model, // API 字段
      input: model.input ?? row?.input ?? null, // 价格回退文档
      output: model.output ?? row?.output ?? null, // 输出价回退文档
      cacheRead: model.cacheRead ?? row?.cacheRead ?? null, // 缓存读回退
      cacheWrite: model.cacheWrite ?? row?.cacheWrite ?? null, // 缓存写回退
      pricingSource: model.pricingSource ?? (row ? 'docs' : null), // 价格来源
      quotas, // 三档配额
      requests5h, // 三档 5h 请求
      quotaSource: matchedDocs ? 'docs' : previous ? 'previous' : null, // 配额来源
      requestSource: matchedRequests ? 'docs' : previous ? 'previous' : null, // 请求来源
    }; // 结束合并
  }); // 结束模型映射
} // 结束数据合并

function comparePrice(changes, field, from, to) { // 比较价格字段
  if (typeof from === 'number' && typeof to === 'number' && from !== to) { // 两边都有值且不同
    changes.push({ kind: 'price', field, from, to }); // 记录价格变动
  } // 结束比较
} // 结束价格比较

export function diffSnapshots(previous, next) { // 对比两次快照
  const nextById = new Map(next.models.map((model) => [model.id, model])); // 本次模型
  const previousById = new Map((previous?.models ?? []).map((model) => [model.id, model])); // 上次模型
  if (!previous) return { baseline: true, added: [], removed: [], changed: [], counts: { added: 0, removed: 0, changed: 0, total: next.models.length } }; // 首次建立基线
  const added = next.models.filter((model) => !previousById.has(model.id)).map((model) => ({ id: model.id, name: model.name })); // 新增模型
  const removed = (previous.models ?? []).filter((model) => !nextById.has(model.id)).map((model) => ({ id: model.id, name: model.name })); // 移除模型
  const changed = []; // 变动模型
  for (const model of next.models) { // 逐模型比较
    const before = previousById.get(model.id); // 上次记录
    if (!before) continue; // 新增已单独处理
    const changes = []; // 字段变动
    comparePrice(changes, 'input', before.input, model.input); // 输入价
    comparePrice(changes, 'output', before.output, model.output); // 输出价
    comparePrice(changes, 'cacheRead', before.cacheRead, model.cacheRead); // 缓存读
    comparePrice(changes, 'cacheWrite', before.cacheWrite, model.cacheWrite); // 缓存写
    if (typeof before.costDigest === 'string' && typeof model.costDigest === 'string' && before.costDigest !== model.costDigest && !changes.some((change) => change.kind === 'price')) { // 计费规则变化
      changes.push({ kind: 'price', field: 'cost', from: null, to: null }); // 记录规则变化
    } // 结束规则比较
    for (const plan of DEFAULT_PLANS) { // 三档配额
      const from = before.quotas?.[plan.key] ?? null; // 上次配额
      const to = model.quotas?.[plan.key] ?? null; // 本次配额
      if (from !== to) changes.push({ kind: 'quota', field: plan.key, from, to }); // 记录配额变动
    } // 结束配额比较
    for (const plan of DEFAULT_PLANS) { // 三档 5h 请求
      const from = before.requests5h?.[plan.key] ?? null; // 上次请求
      const to = model.requests5h?.[plan.key] ?? null; // 本次请求
      if (from !== null && to !== null && from !== to) changes.push({ kind: 'request', field: plan.key, from, to }); // 记录请求变动
    } // 结束请求比较
    if (changes.length > 0) changed.push({ id: model.id, name: model.name, changes }); // 保存变动
  } // 结束模型比较
  return { baseline: false, added, removed, changed, counts: { added: added.length, removed: removed.length, changed: changed.length, total: next.models.length } }; // 返回差异
} // 结束快照对比

export function makeSnapshot(models, docs, diff, warnings, now = new Date()) { // 组装快照
  return { // 快照结构
    version: SNAPSHOT_VERSION, // 格式版本
    checkedAt: now.toISOString(), // 检查时间
    source: { models: MODELS_URL, docs: docs?.url ?? DOCS_URL, plans: (docs?.plans ?? []).map((plan) => plan.label) }, // 数据来源
    baseline: diff.baseline, // 是否基线
    counts: diff.counts, // 数量摘要
    diff: { added: diff.added, removed: diff.removed, changed: diff.changed }, // 差异详情
    models, // 完整模型快照
    warnings, // 警告
  }; // 结束快照
} // 结束快照组装

export async function listSnapshotFiles(dir = snapshotDir()) { // 列出快照文件
  try { // 读取目录
    const entries = await fs.readdir(dir); // 文件列表
    return entries.filter((name) => /^snapshot-.*\.json$/.test(name)).sort().reverse(); // 按时间倒序
  } catch (error) { // 目录不存在
    if (error?.code === 'ENOENT') return []; // 视为空
    throw error; // 其他错误继续抛出
  } // 结束异常
} // 结束列目录

export async function readSnapshots(dir = snapshotDir(), limit = MAX_SNAPSHOTS) { // 读取最近快照
  const files = await listSnapshotFiles(dir); // 文件列表
  const snapshots = []; // 结果
  for (const file of files.slice(0, Math.max(limit, 1))) { // 限制数量
    try { // 读取单个文件
      const raw = await fs.readFile(path.join(dir, file), 'utf8'); // 读取文本
      const parsed = JSON.parse(raw); // 解析 JSON
      if (parsed && parsed.version === SNAPSHOT_VERSION && Array.isArray(parsed.models)) { // 校验版本
        snapshots.push({ file, ...parsed }); // 保存
      } // 结束校验
    } catch (error) { // 损坏文件
      /* 跳过损坏文件 */ // 不阻断历史
    } // 结束异常
  } // 结束循环
  return snapshots; // 返回快照
} // 结束读取

export async function pruneSnapshots(dir = snapshotDir(), keep = MAX_SNAPSHOTS) { // 修剪旧快照
  const files = await listSnapshotFiles(dir); // 文件列表
  for (const file of files.slice(keep)) { // 超出保留数
    await fs.rm(path.join(dir, file), { force: true }); // 删除
  } // 结束循环
} // 结束修剪

export async function writeSnapshot(snapshot, dir = snapshotDir()) { // 原子写入快照
  await fs.mkdir(dir, { recursive: true, mode: 0o700 }); // 创建目录
  const stamp = snapshot.checkedAt.replace(/[:.]/g, '-'); // 文件名安全时间戳
  const file = `snapshot-${stamp}.json`; // 目标文件名
  const temp = path.join(dir, `.${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`); // 临时文件
  try { // 写入临时文件
    await fs.writeFile(temp, JSON.stringify(snapshot, null, 2), { mode: 0o600 }); // 写入内容
    await fs.rename(temp, path.join(dir, file)); // 同目录原子替换
  } catch (error) { // 写入失败
    await fs.rm(temp, { force: true }); // 清理临时文件
    throw error; // 继续抛出
  } // 结束异常
  await pruneSnapshots(dir); // 修剪旧文件
  return file; // 返回文件名
} // 结束写入

export async function readHistory(limit = 20, dir = snapshotDir()) { // 读取历史差异
  const clamped = Math.min(Math.max(Math.trunc(limit) || 20, 1), MAX_SNAPSHOTS); // 限制数量
  const snapshots = await readSnapshots(dir, clamped); // 最近快照
  return snapshots.map((snapshot) => ({ // 映射展示字段
    checkedAt: snapshot.checkedAt, // 检查时间
    baseline: snapshot.baseline === true, // 是否基线
    counts: snapshot.counts ?? { added: 0, removed: 0, changed: 0, total: 0 }, // 数量摘要
    added: snapshot.diff?.added ?? [], // 新增
    removed: snapshot.diff?.removed ?? [], // 移除
    changed: snapshot.diff?.changed ?? [], // 变动
    warnings: snapshot.warnings ?? [], // 警告
  })); // 结束映射
} // 结束历史读取

export async function readStatus(dir = snapshotDir()) { // 读取最近一次状态
  const snapshots = await readSnapshots(dir, 1); // 最近快照
  const snapshot = snapshots[0] ?? null; // 第一条
  if (!snapshot) return null; // 没有快照
  return { checkedAt: snapshot.checkedAt, baseline: snapshot.baseline === true, counts: snapshot.counts ?? { added: 0, removed: 0, changed: 0, total: 0 }, warnings: snapshot.warnings ?? [], models: snapshot.models ?? [] }; // 返回状态
} // 结束状态读取

export async function performCheck(options = {}) { // 执行一次检查
  const dir = options.dir ?? snapshotDir(); // 快照目录
  const now = options.now instanceof Date ? options.now : new Date(); // 检查时间
  const previousSnapshots = await readSnapshots(dir, 1); // 最近一次快照
  const previous = previousSnapshots[0] ?? null; // 上次快照
  const warnings = []; // 警告
  const apiModels = await fetchModels(options.apiKey ?? '', options.signal); // 拉取实时模型
  let docs = null; // 文档结果
  try { // 文档失败不阻断
    docs = await fetchPricingDocs(options.signal); // 抓取文档
    warnings.push(...(docs.warnings ?? [])); // 收集文档提示
  } catch (error) { // 文档抓取失败
    warnings.push(`定价文档抓取失败，配额与 5h 请求沿用上次快照：${error instanceof Error ? error.message : String(error)}`); // 记录提示
  } // 结束文档容错
  const merged = mergeModelData(apiModels, docs, previous?.models ?? []); // 合并数据
  if (docs && docs.plans.length > 0 && merged.every((model) => Object.values(model.quotas ?? {}).every((value) => value === null))) { // 配额全部未命中
    warnings.push('文档已抓取，但没有匹配到任何模型的配额'); // 匹配失败提示
  } // 结束匹配检查
  if (docs && docs.plans.length > 0 && merged.every((model) => Object.values(model.requests5h ?? {}).every((value) => value === null))) { // 请求全部未命中
    warnings.push('文档已抓取，但没有匹配到任何模型的 5h 请求估算'); // 请求匹配失败提示
  } // 结束请求检查
  const provisional = makeSnapshot(merged, docs, { baseline: false, added: [], removed: [], changed: [], counts: { added: 0, removed: 0, changed: 0, total: merged.length } }, warnings, now); // 临时快照
  const diff = diffSnapshots(previous, provisional); // 计算差异
  const snapshot = { ...provisional, baseline: diff.baseline, counts: diff.counts, diff: { added: diff.added, removed: diff.removed, changed: diff.changed } }; // 最终快照
  const file = await writeSnapshot(snapshot, dir); // 原子写入
  return { ok: true, checkedAt: snapshot.checkedAt, baseline: diff.baseline, counts: diff.counts, added: diff.added, removed: diff.removed, changed: diff.changed, warnings: snapshot.warnings, models: snapshot.models, file, plans: (docs?.plans ?? []).map((plan) => plan.label) }; // 返回检查结果与当前模型
} // 结束检查
