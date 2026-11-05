/**
 * Host half of the DeepSeek pet bundle.
 *
 * The pet itself is drawn by the Client module (`client.js`). This half adds
 * the authenticated OpenCode Go monitoring routes: the Client calls
 * `api/deepseek-pet/opencode/check` and `.../history`, and all network and
 * filesystem work happens here so the browser never needs CORS access or a
 * writable local directory.
 */
import { performCheck, readHistory, readStatus, KEY_REF } from './monitor.js'; // 监控实现与凭据引用

export const inject = ['connection', 'credentials']; // 认证路由与只读凭据服务

const CHECK_PATH = '/api/deepseek-pet/opencode/check'; // 检查路由绝对路径
const HISTORY_PATH = '/api/deepseek-pet/opencode/history'; // 历史路由绝对路径
const STATUS_PATH = '/api/deepseek-pet/opencode/status'; // 当前状态路由绝对路径
const MAX_KEY_LENGTH = 4096; // 限制请求体里的 Key 长度

function jsonResponse(body, status = 200) { // 统一的 JSON 响应
  return new Response(JSON.stringify(body), { // 序列化响应体
    status, // HTTP 状态
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, // 禁止缓存
  }); // 返回响应
} // 结束 JSON 响应

function errorResponse(error, status) { // 统一的错误响应
  return jsonResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }, status); // 返回错误文本
} // 结束错误响应

export function apply(ctx) { // 注册监控路由
  const credentials = ctx.credentials; // 凭据服务
  const routes = ctx.connection.fetch; // Host 认证路由注册表
  let queue = Promise.resolve(); // 串行化检查，避免并发写快照
  const enqueue = (task) => { // 把任务接入串行队列
    const run = queue.then(task, task); // 前一个任务结束后执行
    queue = run.then(() => undefined, () => undefined); // 吞掉错误以保持队列
    return run; // 返回本次结果
  }; // 结束队列包装
  const resolveKey = async () => { // 读取已保存的 OpenCode Key
    const resolved = await credentials.resolve(KEY_REF); // 从凭据服务读取
    return typeof resolved?.value === 'string' ? resolved.value : ''; // 返回非空字符串
  }; // 结束 Key 读取
  const storeKey = async (value) => { // 保存非空 Key
    const trimmed = typeof value === 'string' ? value.trim() : ''; // 去掉两侧空格
    if (trimmed.length > 0) await credentials.set(KEY_REF, trimmed); // 写入只读凭据
  }; // 结束 Key 保存
  const readBody = async (request) => { // 读取 JSON 请求体
    if (request.method !== 'POST') return {}; // 非 POST 视为空
    try { // 解析请求体
      const body = await request.json(); // 读取 JSON
      return body !== null && typeof body === 'object' ? body : {}; // 只接受对象
    } catch (error) { // 空或非法 JSON
      return {}; // 按空对象处理
    } // 结束异常
  }; // 结束请求体读取

  routes.register({ // 检查路由
    path: CHECK_PATH, // 绝对注册路径
    methods: ['POST'], // 只接受 POST
    requestBody: 'buffered', // 缓冲读取请求体
    fetch: async (request) => { // 处理一次检查
      try { // 统一捕获失败
        const body = await readBody(request); // 读取请求体
        const provided = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''; // 提取请求中的 Key
        if (provided.length > MAX_KEY_LENGTH) return errorResponse(new Error('API Key 过长'), 400); // 拒绝超长 Key
        await storeKey(provided); // 保存非空 Key
        const apiKey = provided.length > 0 ? provided : await resolveKey(); // 本次使用的 Key
        const result = await enqueue(() => performCheck({ apiKey, signal: request.signal })); // 串行执行检查
        return jsonResponse({ ...result, hasKey: apiKey.length > 0 }); // 返回结果与 Key 状态
      } catch (error) { // 检查失败
        return errorResponse(error, 502); // 以 502 返回原因
      } // 结束异常
    }, // 结束检查处理器
  }); // 结束检查路由

  routes.register({ // 历史路由
    path: HISTORY_PATH, // 绝对注册路径
    methods: ['GET'], // 只读
    requestBody: 'buffered', // 与注册协议保持一致
    fetch: async (request) => { // 处理历史读取
      try { // 统一捕获失败
        const url = new URL(request.url); // 解析查询参数
        const rawLimit = Number(url.searchParams.get('limit') ?? '20'); // 默认 20 条
        const limit = Number.isFinite(rawLimit) ? rawLimit : 20; // 非法值回退
        const checks = await readHistory(limit); // 读取最近记录
        const apiKey = await resolveKey(); // 查询 Key 状态
        return jsonResponse({ ok: true, hasKey: apiKey.length > 0, checks }); // 返回历史
      } catch (error) { // 读取失败
        return errorResponse(error, 500); // 以 500 返回原因
      } // 结束异常
    }, // 结束历史处理器
  }); // 结束历史路由

  routes.register({ // 当前状态路由
    path: STATUS_PATH, // 绝对注册路径
    methods: ['GET'], // 只读
    requestBody: 'buffered', // 与注册协议保持一致
    fetch: async (request) => { // 处理状态读取
      try { // 统一捕获失败
        const status = await readStatus(); // 读取最近快照
        const apiKey = await resolveKey(); // 查询 Key 状态
        return jsonResponse({ ok: true, hasKey: apiKey.length > 0, status }); // 返回状态
      } catch (error) { // 读取失败
        return errorResponse(error, 500); // 以 500 返回原因
      } // 结束异常
    }, // 结束状态处理器
  }); // 结束状态路由
} // 结束 apply
