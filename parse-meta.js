// parse-meta.js — 解析 SKILL.md frontmatter，提取 larkAuth 权限声明
// ============================================================
// 参考 parse-skill-meta.js 的逐行解析逻辑，适配两种 frontmatter 格式：
//   1. JSON 内联格式：metadata: { "openclaw": { "larkAuth": { ... } } }
//   2. YAML 缩进格式：larkAuth:\n  identity: user\n  scopes:\n    - scope1
// 零外部依赖。

import { readFileSync } from "node:fs";

// ---------- frontmatter 块提取 ----------
function extractFrontmatter(content) {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---")) return null;
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) return null;
  return normalized.slice(4, end);
}

// ---------- 逐行解析 key: value（含缩进续行），参考 parse-skill-meta.js ----------
function parseKeyValues(block) {
  const fm = {};
  const lines = block.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) { i += 1; continue; }
    const key = m[1];
    let inline = m[2].trim();
    if (!key) { i += 1; continue; }

    // 多行续行：key: 之后的行为缩进内容
    if (!inline && i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.startsWith(" ") || next.startsWith("\t")) {
        const valueLines = [];
        let j = i + 1;
        while (j < lines.length) {
          const l = lines[j];
          if (l.length > 0 && !l.startsWith(" ") && !l.startsWith("\t")) break;
          valueLines.push(l);
          j += 1;
        }
        const combined = valueLines.join("\n").trim();
        if (combined) fm[key] = combined;
        i = j;
        continue;
      }
    }

    // 去掉首尾引号
    if ((inline.startsWith('"') && inline.endsWith('"')) ||
        (inline.startsWith("'") && inline.endsWith("'"))) {
      inline = inline.slice(1, -1);
    }
    if (inline) fm[key] = inline;
    i += 1;
  }
  return fm;
}

// ---------- 从 metadata JSON 字段解析 larkAuth ----------
function parseLarkAuthFromJson(fm) {
  const raw = fm.metadata;
  if (!raw) return null;
  // 清理 trailing commas 后 JSON.parse
  const cleaned = raw.replace(/,(\s*[\]}])/g, "$1");
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const larkAuth = parsed?.openclaw?.larkAuth ?? null;
  if (!larkAuth || typeof larkAuth !== "object") return null;
  return normalize(larkAuth);
}

// ---------- 从 YAML 缩进格式解析 larkAuth ----------
function parseLarkAuthFromYaml(fm) {
  // 尝试直接从顶层 key 拿 larkAuth（metadata.openclaw 里也可能有 YAML 格式的 larkAuth）
  const candidates = [];
  if (fm.larkAuth) candidates.push(fm.larkAuth);
  // 也尝试从 metadata 字段里提取 YAML 格式（兼容 metadata 字段中包含 YAML 缩进 larkAuth）
  // 此时 fm.metadata 是整个 YAML 块，需在其中搜索 larkAuth 子键

  for (const raw of candidates) {
    const result = parseYamlLarkAuthBlock(raw);
    if (result) return result;
  }

  // 尝试从 metadata 块中查找 larkAuth 子键（YAML 嵌套格式）
  if (fm.metadata) {
    const nested = parseYamlLarkAuthBlock(fm.metadata);
    if (nested) return nested;
  }

  return null;
}

function parseYamlLarkAuthBlock(block) {
  if (!block) return null;
  const lines = block.split("\n");

  // 尝试查找 larkAuth: 行（适用于 metadata 嵌套场景）
  let larkAuthLineIdx = -1, baseIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)larkAuth:\s*$/);
    if (m) { larkAuthLineIdx = i; baseIndent = m[1].length; break; }
    // 也匹配内联形式 larkAuth: { ... }
    const inline = lines[i].match(/^(\s*)larkAuth:\s*(\{.*\})\s*$/);
    if (inline) {
      try {
        const obj = JSON.parse(inline[2]);
        return normalize(obj);
      } catch {}
    }
  }

  let startLine, indentLevel, isDirectContent;
  if (larkAuthLineIdx !== -1) {
    // 找到 larkAuth: 行，从下一行开始解析
    startLine = larkAuthLineIdx + 1;
    indentLevel = baseIndent;
    isDirectContent = false;
  } else {
    // 没找到 larkAuth: 行，说明整个 block 就是 larkAuth 的值
    // 直接处理所有行，不按缩进截断
    startLine = 0;
    indentLevel = -1;
    isDirectContent = true;
  }

  const result = { identity: undefined, scopes: [] };
  let inScopes = false;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (!isDirectContent && indent <= indentLevel) break;
    const t = line.trim();
    if (inScopes && t.startsWith("- ")) {
      result.scopes.push(stripQuotes(t.slice(2).trim()));
      continue;
    }
    inScopes = false;
    const idM = t.match(/^identity:\s*(.+)$/);
    if (idM) { result.identity = stripQuotes(idM[1].trim()); continue; }
    if (/^scopes:\s*$/.test(t)) { inScopes = true; continue; }
    const inlineArr = t.match(/^scopes:\s*(\[.*\])\s*$/);
    if (inlineArr) {
      try { const arr = JSON.parse(inlineArr[1]); if (Array.isArray(arr)) result.scopes.push(...arr.map(String)); } catch {}
      continue;
    }
  }
  if (result.identity === undefined && result.scopes.length === 0) return null;
  return normalize(result);
}

// ---------- 工具函数 ----------
function stripQuotes(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1);
  return s;
}

function normalize(la) {
  if (!la || typeof la !== "object") return null;
  const scopes = Array.isArray(la.scopes)
    ? [...new Set(la.scopes.map((s) => String(s).trim()).filter(Boolean))]
    : [];
  if (scopes.length === 0) return null;
  return {
    identity: la.identity || "user",
    scopes,
  };
}

// ---------- 公开入口 ----------
/**
 * 读取 SKILL.md 内容，提取 larkAuth 权限声明。
 * @param {string} content - SKILL.md 文件内容
 * @returns {{ identity: string, scopes: string[] } | null}
 */
export function readLarkAuthFromContent(content) {
  const block = extractFrontmatter(content);
  if (!block) return null;
  const fm = parseKeyValues(block);

  // 优先 JSON 格式：metadata.openclaw.larkAuth
  let result = parseLarkAuthFromJson(fm);
  if (result) return result;

  // 回退 YAML 格式：larkAuth 或 metadata 中的 larkAuth 子键
  result = parseLarkAuthFromYaml(fm);
  if (result) return result;

  return null;
}

/**
 * 从 SKILL.md 文件路径读取并解析 larkAuth（兼容旧版 readLarkAuth 签名）。
 * @param {string} skillMdPath - SKILL.md 的绝对路径
 * @returns {{ identity: string, scopes: string[] } | null}
 */
export function readLarkAuth(skillMdPath) {
  let text;
  try { text = readFileSync(skillMdPath, "utf8"); } catch { return null; }
  return readLarkAuthFromContent(text);
}