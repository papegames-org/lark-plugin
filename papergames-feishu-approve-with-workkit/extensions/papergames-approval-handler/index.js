"use strict";
/**
 * PaperGames Feishu Approval Interactive Handler Plugin
 *
 * Bridges Feishu card.action.trigger events for namespace `papergames-feishu-approve`
 * to papergames-feishu-approve/scripts/card_action_handler.py.
 *
 * Button value protocol (OpenClaw native):
 *   ev.action.value.action = "<namespace>:action=<detail|approve|reject>|group_index=<int>|task_ids=<csv>"
 */

const { execFile } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// OpenClaw gateway 常以精简 PATH 启动（GUI / daemon 拉起，PATH 不含 Homebrew / pyenv /
// nvm 等目录），直接 spawn "python3" 会报 `spawn python3 ENOENT`。这里把解释器解析成
// 绝对路径候选回退链，并在调用时给子进程补全 PATH，避免脚本内部再调 lark-cli 时二次 ENOENT。
//
// 解释器候选回退链：spawn 报 ENOENT 时按顺序重试下一个；末尾保留裸 "python3" 交给 PATH
// 解析。覆盖项（env）若存在则置于最前。
function pythonCandidates() {
  const list = [];
  const override =
    process.env.PAPER_FEISHU_APPROVE_PYTHON ||
    process.env.PYTHON_BIN ||
    process.env.PYTHON ||
    "";
  if (override) list.push(override);
  list.push(
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
    path.join(os.homedir(), ".pyenv", "shims", "python3"),
    "python3",
  );
  // 去重，保持顺序。
  return Array.from(new Set(list.filter(Boolean)));
}

function enrichedPath() {
  const extra = [
    path.dirname(process.execPath), // gateway 的 node 所在目录，lark-cli 通常同目录
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    path.join(os.homedir(), ".pyenv", "shims"),
  ];
  const merged = [
    ...extra,
    ...String(process.env.PATH || "").split(path.delimiter),
  ].filter(Boolean);
  return Array.from(new Set(merged)).join(path.delimiter);
}

const NAMESPACE = "papergames-feishu-approve";

function resolveSkillRoot() {
  // 显式覆盖优先。
  const override = process.env.PAPER_FEISHU_APPROVE_SKILL_ROOT;
  if (
    override &&
    fs.existsSync(path.join(override, "scripts", "card_action_handler.py"))
  ) {
    return override;
  }

  // 自我定位（最稳）：本插件被 install-openclaw.sh 软链到
  // <技能根>/extensions/papergames-approval-handler。Node 默认解析软链，
  // __dirname 即技能内的真实路径，向上两级就是技能根。无论技能解压到
  // ~/.agents/skills、~/.openclaw/workspace/skills 还是任意目录都能自动命中，
  // 不再依赖 OPENCLAW_WORKSPACE 猜测。
  const selfCandidates = [
    path.resolve(__dirname, "..", ".."),
    // 兼容 --preserve-symlinks：此时 __dirname 是软链位置，用 realpath 再试一次。
    (() => {
      try {
        return path.resolve(fs.realpathSync(__dirname), "..", "..");
      } catch {
        return "";
      }
    })(),
  ];
  for (const root of selfCandidates) {
    if (
      root &&
      fs.existsSync(path.join(root, "scripts", "card_action_handler.py"))
    ) {
      return root;
    }
  }

  // 回退：常见技能安装目录逐个探测。
  const home = os.homedir();
  const fallbacks = [
    process.env.OPENCLAW_WORKSPACE
      ? path.join(
          process.env.OPENCLAW_WORKSPACE,
          "skills",
          "papergames-feishu-approve",
        )
      : "",
    path.join(home, ".agents", "skills", "papergames-feishu-approve"),
    path.join(
      home,
      ".openclaw",
      "workspace",
      "skills",
      "papergames-feishu-approve",
    ),
  ];
  for (const root of fallbacks) {
    if (
      root &&
      fs.existsSync(path.join(root, "scripts", "card_action_handler.py"))
    ) {
      return root;
    }
  }

  // 全部未命中：返回自我定位的首选值，交给下游报"脚本未找到"明确错误。
  return selfCandidates[0];
}

const SKILL_ROOT = resolveSkillRoot();
const SCRIPT_PATH = path.join(SKILL_ROOT, "scripts", "card_action_handler.py");
const EVENT_LOG_PATH = "/tmp/approval-handler-events.log";

function appendEventLog(entry) {
  try {
    fs.appendFileSync(
      EVENT_LOG_PATH,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
      "utf8",
    );
  } catch {}
}

function tryParseJson(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const candidates = [
    raw,
    ...raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse(),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      const parsed = JSON.parse(raw.slice(first, last + 1));
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

function parsePayload(payload) {
  const result = {};

  // Case 1: payload is already an object (OpenClaw may parse it)
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    result.action = payload.action || "";
    const gi = payload.group_index;
    if (gi !== undefined) {
      const g = parseInt(String(gi).trim(), 10);
      if (Number.isFinite(g)) result.group_index = g;
    }
    result.task_ids = payload.task_ids || "";
    return result;
  }

  // Case 2: payload is a JSON string representing an object
  const raw = String(payload || "").trim();
  if (!raw) return {};

  if (raw.startsWith("{") && raw.endsWith("}")) {
    try {
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        result.action = obj.action || "";
        const gi = obj.group_index;
        if (gi !== undefined) {
          const g = parseInt(String(gi).trim(), 10);
          if (Number.isFinite(g)) result.group_index = g;
        }
        result.task_ids = obj.task_ids || "";
        return result;
      }
    } catch {}
  }

  // Case 3: legacy pipe-delimited string format
  // "action=detail|group_index=0|task_ids=..." or "papergames-feishu-approve:detail|..."
  let pipePayload = raw;
  const nsSep = raw.indexOf(":");
  if (nsSep >= 0) {
    pipePayload = raw.slice(nsSep + 1);
  }

  const actionMatch = pipePayload.match(/(?:^|\|)action=([^|]*)/);
  const groupMatch = pipePayload.match(/(?:^|\|)group_index=([^|]*)/);
  const taskIdsMatch = pipePayload.match(/(?:^|\|)task_ids=(.+)$/);

  // Heuristic action extraction. We MUST validate the candidate is a known
  // verb before accepting it, otherwise a stripped task-suffixed payload like
  // "approve:7647383552392252" (where OpenClaw already stripped the namespace)
  // gets here as pipePayload="7647383552392252" — a bare task_id that the old
  // code happily set as result.action. Always cross-check against the known
  // verb set.
  const KNOWN_VERBS = new Set([
    "approve",
    "reject",
    "detail",
    "view_detail",
    "show_detail",
  ]);
  const findKnownVerb = (text) => {
    if (!text) return "";
    for (const seg of String(text).split(":")) {
      const s = seg.trim().toLowerCase();
      if (KNOWN_VERBS.has(s)) return s;
    }
    return "";
  };

  if (actionMatch) {
    const candidate = actionMatch[1].trim();
    result.action = findKnownVerb(candidate) || candidate;
  } else {
    // Try to find a known verb in either the raw payload or the post-strip
    // pipePayload. If found, use it; otherwise leave result.action empty and
    // let upstream fall back to rawAction.value.action.
    const verb = findKnownVerb(raw) || findKnownVerb(pipePayload);
    if (verb) {
      result.action = verb;
    } else if (pipePayload && !pipePayload.includes("=")) {
      // Pre-existing path: bare/pipe string with no = and no known verb.
      // Keep first segment, but a Set check above means downstream
      // actionToStatus will return 0 for unknown verbs — safe.
      result.action = pipePayload.split("|")[0].trim();
    } else if (pipePayload && pipePayload.includes("|")) {
      result.action = pipePayload.split("|")[0].trim();
    }
  }
  if (groupMatch) {
    const g = parseInt(groupMatch[1].trim(), 10);
    if (Number.isFinite(g)) result.group_index = g;
  }
  if (taskIdsMatch) result.task_ids = taskIdsMatch[1].trim();
  return result;
}

/** Map skill action to status int expected by card_action_handler (APPROVE=3, REJECT=2). */
function actionToStatus(action) {
  // Robust segment scan: handles all forms after upstream strips
  // (0, 1, or 2 leading colon-segments removed):
  //   papergames-feishu-approve:approve:abc12345
  //   approve:abc12345
  //   papergames-feishu-approve:approve
  //   approve
  const raw = String(action || "").toLowerCase();
  const segments = raw.split(":");
  for (const seg of segments) {
    const s = seg.trim();
    if (s === "approve") return 3;
    if (s === "reject") return 2;
    if (s === "detail" || s === "view_detail" || s === "show_detail")
      return "detail";
  }
  return 0;
}

// 跨解释器候选执行：某个候选 spawn 报 ENOENT（解释器不存在）时，自动重试下一个。
// 注意 `spawn <cmd> ENOENT` 也可能由 options.cwd 不存在触发 —— 调用方需先确保 cwd 有效，
// 否则这里会把所有候选都试一遍仍失败。
async function runSkillScriptWithFallback(args, options) {
  const candidates = pythonCandidates();
  let last = null;
  for (const bin of candidates) {
    const result = await new Promise((resolve) => {
      execFile(bin, args, options, (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: typeof error?.code === "number" ? error.code : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error,
          bin,
        });
      });
    });
    last = result;
    // 仅在"解释器找不到"(ENOENT) 时继续尝试下一个候选；其它错误（脚本自身报错、
    // 超时等）直接返回，避免用一个不该用的解释器重复执行业务逻辑。
    if (result.error && result.error.code === "ENOENT") continue;
    return result;
  }
  return (
    last || {
      ok: false,
      code: 0,
      stdout: "",
      stderr: "no python candidate",
      error: null,
    }
  );
}

function missingSkillScriptResponse() {
  return {
    toast: {
      type: "error",
      content: ("审批脚本未找到，请确认 skill 已安装: " + SCRIPT_PATH).slice(
        0,
        100,
      ),
    },
  };
}

function skillScriptRuntimeOptions() {
  const cwd = fs.existsSync(SKILL_ROOT)
    ? SKILL_ROOT
    : path.dirname(SCRIPT_PATH);

  const env = {
    ...process.env,
    PATH: enrichedPath(),
    // 不要在这里硬塞 LARKSUITE_CLI_CONFIG_DIR。此前固定指向
    // ~/.lark-cli/openclaw，但实际登录/查询走的是 lark-cli 默认解析，token 常
    // 写在别的目录（如 ~/.lark-cli）。强制一个空目录会让 approve 侧 auth check
    // 报 not_configured（点通过提示"需要先完成审批授权"）。改为：仅当 gateway
    // 环境已显式设置时才透传（由上面的 ...process.env 完成），否则交给
    // skill 的 resolve_lark_cli_config_dir() 自动定位，与查询侧保持一致。
    PAPER_FEISHU_APPROVE_CARD_MODE:
      process.env.PAPER_FEISHU_APPROVE_CARD_MODE || "inline",
  };

  return {
    cwd,
    env,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  };
}

function skillScriptArgs(event) {
  return [SCRIPT_PATH, "--event-json", JSON.stringify(event || {})];
}

async function dispatchToSkill({ event }) {
  // 先校验脚本与工作目录是否存在：Node 的 `spawn <cmd> ENOENT` 在 cwd 不存在时
  // 会误报成解释器路径的 ENOENT（极具误导）。这里提前给出明确错误，避免把
  // "skill 未正确安装/路径不对" 误判成 "python 没装"。
  if (!fs.existsSync(SCRIPT_PATH)) {
    return missingSkillScriptResponse();
  }

  const execResult = await runSkillScriptWithFallback(
    skillScriptArgs(event),
    skillScriptRuntimeOptions(),
  );

  const parsed =
    tryParseJson(execResult.stdout) || tryParseJson(execResult.stderr);
  if (parsed) return parsed;

  // 全部候选都 ENOENT：给出"找不到 python 解释器"的明确提示，而不是裸 spawn 错误。
  if (execResult.error && execResult.error.code === "ENOENT") {
    return {
      toast: {
        type: "error",
        content:
          "未找到 python3 解释器，请设置 PAPER_FEISHU_APPROVE_PYTHON 指向可用 python3".slice(
            0,
            100,
          ),
      },
    };
  }

  return {
    toast: {
      type: "error",
      content: String(
        execResult.stderr ||
          execResult.stdout ||
          execResult.error?.message ||
          "审批回调处理失败",
      )
        .trim()
        .slice(0, 100),
    },
  };
}

function dispatchToSkillInBackground({ event, actionName }) {
  if (!fs.existsSync(SCRIPT_PATH)) {
    return missingSkillScriptResponse();
  }

  runSkillScriptWithFallback(skillScriptArgs(event), skillScriptRuntimeOptions())
    .then((result) => {
      appendEventLog({
        event: "background_result",
        action: actionName,
        ok: Boolean(result && result.ok),
        code: result && result.code,
        bin: result && result.bin,
        stdout: String((result && result.stdout) || "").slice(0, 500),
        stderr: String((result && result.stderr) || "").slice(0, 500),
        error: String((result && result.error && result.error.message) || "").slice(
          0,
          500,
        ),
      });
    })
    .catch((error) => {
      appendEventLog({
        event: "background_error",
        action: actionName,
        error: String((error && error.message) || error || "").slice(0, 500),
      });
    });

  const verb = actionName === "reject" ? "驳回" : "通过";
  return {
    toast: {
      type: "success",
      content: `已收到，正在${verb}审批，请稍后查看卡片状态。`,
    },
  };
}

function asyncApprovalActionsEnabled() {
  return process.env.PAPER_FEISHU_APPROVE_ASYNC_ACTIONS !== "0";
}

/** @type {import('openclaw/plugin-sdk').OpenClawPlugin} */
const plugin = {
  id: "papergames-approval-handler",
  name: "PaperGames Approval Handler",
  description:
    "Routes papergames-feishu-approve card actions to card_action_handler.py",
  configSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
  register(api) {
    const handler = async (ctx) => {
      appendEventLog({
        event: "entry",
        hasPayload: Boolean(ctx.payload),
        hasRawEvent: Boolean(ctx.rawEvent),
      });
      const parsedAction = parsePayload(ctx.payload);

      const rawEvent = ctx.rawEvent || {};
      const rawAction = rawEvent.event?.action || rawEvent.action || {};

      // Extract action name. PRIORITY MATTERS.
      // rawAction.value.action is the original Feishu callback value, never
      // touched by OpenClaw upstream stripping. Try it first.
      // parsedAction.action comes from ctx.payload which OpenClaw may have
      // pre-stripped to e.g. "approve:7647..." — using that first historically
      // caused legacy parsePayload to mis-parse the suffix as a task_id.
      let actionName =
        rawAction.value?.action ||
        rawAction.action ||
        parsedAction.action ||
        "";
      // Robust segment scan: handles all upstream-strip levels.
      if (actionName) {
        const segs = String(actionName).split(":");
        let canonical = "";
        for (const seg of segs) {
          const s = seg.trim().toLowerCase();
          if (
            s === "approve" ||
            s === "reject" ||
            s === "detail" ||
            s === "view_detail" ||
            s === "show_detail"
          ) {
            canonical = s;
            break;
          }
        }
        if (canonical) {
          actionName = canonical;
        }
      }
      if (!actionName) {
        return { handled: false };
      }

      // Merge group_index from multiple sources: payload string, raw action, raw action.value
      let groupIndex = parsedAction.group_index;
      if (groupIndex === undefined) {
        const gi = rawAction.group_index ?? rawAction.value?.group_index;
        if (gi !== undefined) {
          const g = parseInt(String(gi).trim(), 10);
          if (Number.isFinite(g)) groupIndex = g;
        }
      }

      // Merge task_ids from multiple sources
      let taskIds = parsedAction.task_ids;
      if (!taskIds) {
        taskIds = rawAction.task_ids || rawAction.value?.task_ids || "";
      }

      const operator = rawEvent.event?.operator || rawEvent.operator || {};
      const senderOpenId =
        operator.open_id || operator.operator_id?.open_id || ctx.senderId || "";
      const chatId =
        rawEvent.event?.context?.open_chat_id ||
        rawEvent.event?.message?.chat_id ||
        ctx.conversationId ||
        "";

      // Extract message_id / card_token from all possible locations in rawEvent
      const openMessageId =
        rawEvent.event?.context?.open_message_id ||
        rawEvent.event?.message?.open_message_id ||
        rawEvent.open_message_id ||
        "";
      const cardToken =
        rawEvent.event?.context?.token ||
        rawEvent.event?.token ||
        rawEvent.token ||
        "";

      if (openMessageId || cardToken) {
        console.log(
          "[papergames-approval-handler] extracted message_id=" +
            (openMessageId ? "present" : "missing") +
            ", token=" +
            (cardToken ? "present" : "missing"),
        );
      }

      const synthEvent = {
        event: {
          ...(rawEvent.event || {}),
          action: {
            tag: rawAction.tag || "button",
            value: {
              ...(typeof rawAction.value === "object" && rawAction.value
                ? rawAction.value
                : {}),
              status:
                typeof rawAction.value === "object" &&
                rawAction.value &&
                rawAction.value.status !== undefined
                  ? rawAction.value.status
                  : actionToStatus(actionName),
              action: actionName,
              group_index: groupIndex,
              task_ids: taskIds || "",
              raw_payload:
                typeof ctx.payload === "string"
                  ? ctx.payload
                  : JSON.stringify(ctx.payload || {}),
            },
          },
          operator: {
            ...(operator || {}),
            open_id: senderOpenId,
          },
          context: {
            ...(rawEvent.event?.context || {}),
            open_chat_id: chatId,
            open_message_id: openMessageId,
            token: cardToken,
          },
        },
      };

      const shouldRunAsync =
        asyncApprovalActionsEnabled() &&
        (actionName === "approve" || actionName === "reject");
      const result = shouldRunAsync
        ? dispatchToSkillInBackground({ event: synthEvent, actionName })
        : await dispatchToSkill({ event: synthEvent });

      return {
        handled: true,
        ...(result && typeof result === "object" ? result : {}),
      };
    };

    api.registerInteractiveHandler({
      channel: "feishu",
      namespace: NAMESPACE,
      handler,
    });

    console.log(
      "[papergames-approval-handler] registered interactive handlers for namespaces:",
      NAMESPACE,
    );
  },
};

function register(api) {
  return plugin.register(api);
}

module.exports = { register, plugin };
module.exports.default = plugin;
